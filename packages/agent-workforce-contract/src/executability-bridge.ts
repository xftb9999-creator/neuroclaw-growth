/**
 * I-035 · RG-2b 接线：role-grid `AgentProfile` → shared D5 matcher（唯一实现）的确定性映射。
 *
 * 依据与证据分级：
 * - GM 裁定（2026-09-27，I-035 裁点③/TODO-8）：复用 `shared/src/capability-matching.ts`
 *   （D5，E3 实测）；**不另建** `packages/capability-match`（不存在，另建=第二套方言）。
 * - AW-1 验收口径（`.artifacts/i035-role-grid/aw1/CAPABILITIES.md:137`）：
 *   MUST=MISSING → tier C 且退出码非零；PARTIAL → tier B 且列前置条件。
 * - 清单复用 RG-2a `capability-inventory.v1.json`（本包 §6，E3 实测）。
 * - role-grid `AgentProfile` schema：本包 `index.ts` §4（RG-1/RG-2 收紧后，E3 测试）。
 *
 * 边界：
 * - 纯函数、零 DB、零 I/O、零接线（`apps/**` 不 import）；同输入 ⇒ 同输出（D5 指纹可复算）。
 * - `weight` / `layer` / `chainSegment` 在 AgentProfile 中**无来源字段**：取保守缺省并在
 *   `docs/TODO-rg2b-matcher-defaults.md` 标注，不发明业务语义。
 * - 本文件**不加入包 barrel**（`index.ts`）：供 RG-2b 脚本/测试直接引用，避免环形依赖与
 *   与他线写集冲突（非 barrel 优先）。
 */
import {
  matchCapabilities,
  type CapabilityLayer,
  type CapabilityMatchInput,
  type CapabilityMatchReport,
  type CapabilityWeight,
  type ChainSegment,
  type EvidenceLevel,
  type ExecutabilityVerdict,
  type InstalledPlugin
} from "@neuroclaw/shared";

import {
  CAPABILITY_INVENTORY_V1,
  agentProfileSchema,
  capabilityInventorySchema,
  type AgentProfile,
  type AgentRoleKey,
  type CapabilityInventory
} from "./index.js";

// ---------------------------------------------------------------------------
// §1 缺省值与证据化常量（无来源字段 → 保守缺省；来源字段 → 直接映射）
// ---------------------------------------------------------------------------

/**
 * role-grid → D5 的保守缺省（理由一行，详见 `docs/TODO-rg2b-matcher-defaults.md`）：
 * - weight=MUST：提案 §二-5/6 上岗判据为“每个 capabilityRef 须 COVERED”，缺失即拦截
 *   （fail-closed），不静默降级为 B；
 * - layer=L0：D5 判定不读取 layer（仅元数据，实测 `capability-matching.ts:220-320`），取枚举下界占位；
 * - chainSegment=execute：D5 仅对 deliver 加通道就绪检查（`:276-294`），无来源时不发明投递语义；
 * - minEvidence=E1：取 D5 证据地板（E0 永不可 COVERED，`:166-175`），不发明更高门槛。
 */
export const ROLE_GRID_MATCHER_DEFAULTS: {
  readonly weight: CapabilityWeight;
  readonly layer: CapabilityLayer;
  readonly chainSegment: ChainSegment;
  readonly minEvidence: EvidenceLevel;
} = {
  weight: "MUST",
  layer: "L0",
  chainSegment: "execute",
  minEvidence: "E1"
};

/**
 * simulationOnly=true 的 ref 白名单（E3 依据，2026-09-27 实测）：
 * `capability_growth_simulation` 的代码面构造即“模拟、只读”：
 * - `universal-contracts.ts:2942` objectiveProfiles + `:2949` `budgetPolicy: { mode: "SIMULATION_ONLY" }`；
 * - `:2977-2983` 工作流节点 kind = "simulate" / "simulate_preview"；
 * - `:2994` 适配器注释 "simulation-only, read-only"。
 * 仅此 1 条已证 ref；**不以命名推测**其他 ref（不发明）。
 */
export const SIMULATION_ONLY_CAPABILITY_REFS: ReadonlySet<string> = new Set([
  "capability_growth_simulation"
]);

// ---------------------------------------------------------------------------
// §2 清单 → D5 已安装插件（InstalledPlugin[]）
// ---------------------------------------------------------------------------

/**
 * RG-2a 清单（AVAILABLE/MISSING）→ D5 `InstalledPlugin[]`：
 * - AVAILABLE ⇒ 已安装插件 `{enabled:true, evidenceLevel 直迁}`；MISSING ⇒ **不映射**
 *   （未安装），由 D5 rule 1 报 MISSING（fail-closed，不发明“半可用”状态）；
 * - `pluginId` 确定性：`inventory:<capabilityRef>`（universalIdSchema 仅要求非空）；
 * - `requires` / `channels` 清单 schema 无对应字段 ⇒ 缺省空（TODO 见文档）；
 * - `simulationOnly` 仅对白名单 ref 为 true（E3 依据见 §1）。
 */
export function inventoryToInstalledPlugins(inventory: CapabilityInventory): InstalledPlugin[] {
  const parsed = capabilityInventorySchema.parse(inventory);
  return parsed.entries
    .filter((entry) => entry.status === "AVAILABLE")
    .map((entry) => ({
      pluginId: `inventory:${entry.capabilityRef}`,
      capabilityRefs: [entry.capabilityRef],
      enabled: true,
      requires: [],
      evidenceLevel: entry.evidenceLevel,
      simulationOnly: SIMULATION_ONLY_CAPABILITY_REFS.has(entry.capabilityRef),
      channels: []
    }))
    .sort((left, right) => left.pluginId.localeCompare(right.pluginId));
}

// ---------------------------------------------------------------------------
// §3 AgentProfile → CapabilityMatchInput（单一映射函数，确定性输出）
// ---------------------------------------------------------------------------

interface CapabilityRefBinding {
  capabilityRef: string;
  sources: Array<"skills" | "tools">;
  /** 任一绑定该 ref 的 tool 含 write scope ⇒ 该需求要求真实副作用（来源字段，非缺省）。 */
  writeScoped: boolean;
}

/** 收集 profile 全部 capabilityRef（skills[].capabilityRefs + tools[].capabilityRef），去重且确定性排序。 */
function collectCapabilityRefs(profile: AgentProfile): CapabilityRefBinding[] {
  const byRef = new Map<string, CapabilityRefBinding>();
  const ensure = (capabilityRef: string): CapabilityRefBinding => {
    const existing = byRef.get(capabilityRef);
    if (existing) return existing;
    const created: CapabilityRefBinding = { capabilityRef, sources: [], writeScoped: false };
    byRef.set(capabilityRef, created);
    return created;
  };

  for (const skill of profile.skills ?? []) {
    for (const capabilityRef of skill.capabilityRefs) {
      const binding = ensure(capabilityRef);
      if (!binding.sources.includes("skills")) binding.sources.push("skills");
    }
  }
  for (const tool of profile.tools ?? []) {
    const binding = ensure(tool.capabilityRef);
    if (!binding.sources.includes("tools")) binding.sources.push("tools");
    if (tool.scopes.includes("write")) binding.writeScoped = true;
  }

  return [...byRef.values()].sort((left, right) =>
    left.capabilityRef.localeCompare(right.capabilityRef)
  );
}

export const ROLE_GRID_MATCHER_OBJECTIVE_PREFIX = "role-grid executability";

function buildInputFromParsedProfile(
  profile: AgentProfile,
  inventory: CapabilityInventory
): CapabilityMatchInput | null {
  const bindings = collectCapabilityRefs(profile);
  // D5 明确：空 requirements 是调用方错误，不得判 A（capability-matching.test.ts:116-123）。
  // 零绑定 profile 不构成 tier 判定；由调用方（脚本/resolver）显式呈现，不发明合成需求。
  if (bindings.length === 0) return null;

  return {
    goalSpec: {
      objective: `${ROLE_GRID_MATCHER_OBJECTIVE_PREFIX}: ${profile.role}`,
      requirements: bindings.map((binding) => ({
        reqId: `req:${profile.role}:${binding.capabilityRef}`,
        layer: ROLE_GRID_MATCHER_DEFAULTS.layer,
        capabilityRef: binding.capabilityRef,
        weight: ROLE_GRID_MATCHER_DEFAULTS.weight,
        minEvidence: ROLE_GRID_MATCHER_DEFAULTS.minEvidence,
        chainSegment: ROLE_GRID_MATCHER_DEFAULTS.chainSegment,
        requiresRealSideEffect: binding.writeScoped
      }))
    },
    inventory: inventoryToInstalledPlugins(inventory)
  };
}

/**
 * role-grid profile → D5 输入（未装配 D5 前先经 `agentProfileSchema` 严格校验）：
 * - profile 零 capability 绑定 ⇒ 返回 `null`（不合成需求、不判 A）；
 * - 映射只使用**来源字段**（capabilityRef / scopes→requiresRealSideEffect）与 §1 缺省；
 * - 清单缺省 = RG-2a `CAPABILITY_INVENTORY_V1`。
 */
export function buildCapabilityMatchInput(
  profile: AgentProfile,
  inventory: CapabilityInventory = CAPABILITY_INVENTORY_V1
): CapabilityMatchInput | null {
  return buildInputFromParsedProfile(agentProfileSchema.parse(profile), inventory);
}

// ---------------------------------------------------------------------------
// §4 可执行性检查（tier 判定 + 阻塞标志；脚本 --check 的语义载体）
// ---------------------------------------------------------------------------

export interface AgentProfileExecutability {
  role: AgentRoleKey;
  /** D5 tier A/B/C；NO_BINDINGS = 零 capability 绑定（不构成 tier 判定）。 */
  verdict: ExecutabilityVerdict | "NO_BINDINGS";
  /** --check 退出码口径：仅 tier C 为 true（MUST=MISSING 或 BLOCKED segment）。 */
  blocking: boolean;
  report: CapabilityMatchReport | null;
  /** 聚合全部 PARTIAL 前置条件（验收“PARTIAL → tier B 且列前置条件”）。 */
  preconditions: string[];
}

/**
 * 完整检查：profile → 映射 → D5 `matchCapabilities` → tier + blocking。
 * 纯函数：同输入两次调用报告字节一致（D5 指纹保证）。
 */
export function checkAgentProfileExecutability(
  profile: AgentProfile,
  inventory: CapabilityInventory = CAPABILITY_INVENTORY_V1
): AgentProfileExecutability {
  const parsedProfile = agentProfileSchema.parse(profile);
  const input = buildInputFromParsedProfile(parsedProfile, inventory);
  if (input === null) {
    return {
      role: parsedProfile.role,
      verdict: "NO_BINDINGS",
      blocking: false,
      report: null,
      preconditions: []
    };
  }

  const report = matchCapabilities(input);
  return {
    role: parsedProfile.role,
    verdict: report.verdict,
    blocking: report.verdict === "C",
    report,
    preconditions: report.items.flatMap((item) => item.preconditions)
  };
}
