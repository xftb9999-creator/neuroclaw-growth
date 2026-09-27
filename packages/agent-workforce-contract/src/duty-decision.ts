/**
 * I-035 · RG-3b 上岗裁决纯函数：`canAgentTakeDuty`（7 步算法，确定性、可复算）。
 *
 * 依据与证据分级：
 * - 算法原文：`.artifacts/gm-report-20260922/agent-workforce.md:584-602`（7 步 + 可复算口径）。
 * - 批次：`.artifacts/i035-role-grid/proposal.md:99`（RG-3；插件化 AW-6 依赖 plugin-roadmap
 *   P1-1/P2-1 = P-2，本批不做）；切片 `.artifacts/i035-role-grid/aw1/capabilities.md:140`（RG-3b）。
 * - 复用（E3 实测）：本包 §7 `resolveAgentCapabilityRefs`、§6 `capabilityInventoryFingerprint`、
 *   §5 `canonicalJson`；profile 经 `agentProfileSchema` 严格校验（RG-1/RG-2/RG-3 收紧后）。
 *
 * 输入解读（E2 设计选择，待 QA/GM 复核；均不发明业务语义）：
 * - 7 步伪代码签名 `canAgentTakeDuty(profile, inventory)`，但 `status` / `baseEngine` 不在
 *   RG-1 冻结的 10 字段内（完整草案见 agent-workforce.md:449-451）→ 由 `DutyContext` 提供；
 * - 步骤 5“宿主授权链支持该 scope”= 宿主侧事实 → `DutyContext.supportedWriteScopes`
 *   （缺省空集，fail-closed：未提供授权证据 = 不支持）；
 * - 步骤 6“计划允许的风险类”= 计划侧事实 → `DutyContext.allowedRiskClass`（null/缺省 = 计划
 *   未声明，跳过该步不降级：不发明计划约束）；`permissions` 未声明时 maxRiskClass 按最小权限
 *   解读为 LOW；
 * - `DutyContext.status` 为宿主人工激活态：忠实步骤 1 字面，仅 `INACTIVE` 直接拒；
 *   “首次上岗须人工 `status: ACTIVE`”（agent-workforce.md:531）属 PlanSpec 引用校验，
 *   超出本纯函数（deferred）。
 *
 * 边界：纯函数、零 DB、零 I/O、零接线（`apps/**` 不 import）；**不进包 barrel**（循 RG-2b
 * `executability-bridge` 非 barrel 先例，避免他线写集冲突）。“BLOCKED 员工不可被 PlanSpec
 * 引用”的结构校验依赖 AW-0（GoalSpec/PlanSpec 均未建，实测）→ deferred，不在本批。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { templateTypes } from "@neuroclaw/shared";

import {
  CAPABILITY_INVENTORY_V1,
  agentProfileSchema,
  canonicalJson,
  capabilityInventoryFingerprint,
  capabilityInventorySchema,
  resolveAgentCapabilityRefs,
  type AgentProfile,
  type AgentRoleKey,
  type CapabilityInventory
} from "./index.js";

// ---------------------------------------------------------------------------
// §1 裁决输入 / 输出类型（DutyContext + DutyDecision）
// ---------------------------------------------------------------------------

/** 宿主态（agent-workforce.md:451 `status` 三值；仅 INACTIVE 直接拒，见头注）。 */
export const dutyStatusSchema = z.enum(["ACTIVE", "INACTIVE", "BLOCKED_BY_CAPABILITY"]);
export type DutyStatus = z.infer<typeof dutyStatusSchema>;

/** 风险档序（步骤 6 比较用；与 permissions.maxRiskClass 同枚举字面，提案 §二-7）。 */
const riskClassSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type RiskClass = z.infer<typeof riskClassSchema>;
const RISK_CLASS_ORDER: Record<RiskClass, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/**
 * 裁决上下文（profile 外的两类事实：宿主态 + 计划态）。
 * 所有字段显式给出；缺省行为见头注（supportedWriteScopes 缺省 = 空集 fail-closed）。
 */
export const dutyContextSchema = z
  .object({
    status: dutyStatusSchema,
    /** 过渡期引擎绑定（agent-workforce.md:450 三内置模板枚举）。 */
    baseEngine: z.enum(templateTypes).nullable().optional(),
    /** 计划允许的风险类（步骤 6）；null = 计划未声明。 */
    allowedRiskClass: riskClassSchema.nullable().optional(),
    /** 宿主 CONTROLLED_WRITE 授权链支持的 scope 集（步骤 5）；缺省 = 空集。 */
    supportedWriteScopes: z.array(z.string().min(1)).optional()
  })
  .strict();
export type DutyContext = z.infer<typeof dutyContextSchema>;

export type DutyVerdict = "ELIGIBLE" | "PARTIAL" | "BLOCKED_BY_CAPABILITY" | "NOT_ELIGIBLE";

export interface DutyDecisionStep {
  step: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  name: string;
  outcome: "PASS" | "FAIL" | "SKIPPED";
  reason: string;
}

/**
 * 裁决结果（确定性；steps 为**已执行步骤**，顺序短路）。
 * - `blocked` / `blockedWriteScopes` 为决策依据名单（排序、去重由来源函数保证）；
 * - `inputFingerprint` = profile（parse 后）+ context（归一化）canonical JSON 的 sha256；
 * - `inventoryFingerprint` = §6 `capabilityInventoryFingerprint`（同清单同值）。
 */
export interface DutyDecision {
  role: AgentRoleKey;
  verdict: DutyVerdict;
  steps: DutyDecisionStep[];
  blocked: string[];
  blockedWriteScopes: string[];
  inventoryFingerprint: string;
  inputFingerprint: string;
}

// ---------------------------------------------------------------------------
// §2 7 步裁决实现（agent-workforce.md:584-602 逐条）
// ---------------------------------------------------------------------------

/** 组装裁决结果（含归一化指纹；supportedWriteScopes 按集合语义排序归一）。 */
function buildDecision(
  profile: AgentProfile,
  context: DutyContext,
  verdict: DutyVerdict,
  steps: DutyDecisionStep[],
  blocked: string[],
  blockedWriteScopes: string[],
  inventoryFingerprint: string
): DutyDecision {
  const normalizedContext = {
    status: context.status,
    baseEngine: context.baseEngine ?? null,
    allowedRiskClass: context.allowedRiskClass ?? null,
    supportedWriteScopes: [...(context.supportedWriteScopes ?? [])].sort()
  };
  const inputFingerprint = createHash("sha256")
    .update(canonicalJson({ profile, context: normalizedContext }))
    .digest("hex");
  return {
    role: profile.role,
    verdict,
    steps,
    blocked,
    blockedWriteScopes,
    inventoryFingerprint,
    inputFingerprint
  };
}

/**
 * 上岗裁决：同 profile + 同 context + 同清单 ⇒ 同 verdict / steps / 指纹（可快照比对）。
 * 步骤（短路顺序执行，blocked 名单随失败步骤返回）：
 * 1. `status != "INACTIVE"` 否 → NOT_ELIGIBLE；2. `baseEngine` 存在否 → NOT_ELIGIBLE；
 * 3. tools 全 COVERED 否 → BLOCKED；4. skills 全 COVERED 否 → BLOCKED；
 * 5. writeScopes 全获授权链支持 否 → BLOCKED；6. maxRiskClass ≤ 计划允许 否 → PARTIAL；
 * 7. 全部通过 → ELIGIBLE。
 */
export function canAgentTakeDuty(
  profile: AgentProfile,
  context: DutyContext,
  inventory: CapabilityInventory = CAPABILITY_INVENTORY_V1
): DutyDecision {
  const parsedProfile = agentProfileSchema.parse(profile);
  const parsedContext = dutyContextSchema.parse(context);
  const parsedInventory = capabilityInventorySchema.parse(inventory);

  const steps: DutyDecisionStep[] = [];
  const inventoryFingerprint = capabilityInventoryFingerprint(parsedInventory);
  const decide = (
    verdict: DutyVerdict,
    blocked: string[] = [],
    blockedWriteScopes: string[] = []
  ): DutyDecision =>
    buildDecision(
      parsedProfile,
      parsedContext,
      verdict,
      steps,
      blocked,
      blockedWriteScopes,
      inventoryFingerprint
    );

  // 步骤 1：人工停用检查
  if (parsedContext.status === "INACTIVE") {
    steps.push({
      step: 1,
      name: "人工停用检查",
      outcome: "FAIL",
      reason: "宿主状态 INACTIVE（人工停用）"
    });
    return decide("NOT_ELIGIBLE");
  }
  steps.push({
    step: 1,
    name: "人工停用检查",
    outcome: "PASS",
    reason: `宿主状态 ${parsedContext.status}（非 INACTIVE）`
  });

  // 步骤 2：过渡期引擎检查
  const baseEngine = parsedContext.baseEngine ?? null;
  if (baseEngine === null) {
    steps.push({
      step: 2,
      name: "过渡期引擎检查",
      outcome: "FAIL",
      reason: "baseEngine 缺失（过渡期须有执行底座）"
    });
    return decide("NOT_ELIGIBLE");
  }
  steps.push({
    step: 2,
    name: "过渡期引擎检查",
    outcome: "PASS",
    reason: `baseEngine=${baseEngine}`
  });

  // 步骤 3 / 4：capabilityRef 全解析（复用 §7，一次解析分别过滤 sources）
  const resolution = resolveAgentCapabilityRefs(parsedProfile, parsedInventory);
  const missingTools = resolution.items
    .filter((item) => item.source === "tools" && item.status === "MISSING")
    .map((item) => item.capabilityRef);
  const missingSkills = resolution.items
    .filter((item) => item.source === "skills" && item.status === "MISSING")
    .map((item) => item.capabilityRef);

  if (missingTools.length > 0) {
    steps.push({
      step: 3,
      name: "tools capabilityRef 解析",
      outcome: "FAIL",
      reason: `tools capabilityRef 未 COVERED: ${missingTools.join(", ")}`
    });
    return decide("BLOCKED_BY_CAPABILITY", missingTools);
  }
  steps.push({
    step: 3,
    name: "tools capabilityRef 解析",
    outcome: "PASS",
    reason:
      resolution.items.filter((item) => item.source === "tools").length === 0
        ? "无 tools 绑定（∀ 空集通过）"
        : "tools capabilityRef 全 COVERED"
  });

  if (missingSkills.length > 0) {
    steps.push({
      step: 4,
      name: "skills capabilityRef 解析",
      outcome: "FAIL",
      reason: `skills capabilityRef 未 COVERED: ${missingSkills.join(", ")}`
    });
    return decide("BLOCKED_BY_CAPABILITY", missingSkills);
  }
  steps.push({
    step: 4,
    name: "skills capabilityRef 解析",
    outcome: "PASS",
    reason:
      resolution.items.filter((item) => item.source === "skills").length === 0
        ? "无 skills 绑定（∀ 空集通过）"
        : "skills capabilityRef 全 COVERED"
  });

  // 步骤 5：writeScopes ⇒ 宿主授权链支持（缺省空集，fail-closed）
  const writeScopes = parsedProfile.permissions?.writeScopes ?? [];
  const supportedWriteScopes = new Set(parsedContext.supportedWriteScopes ?? []);
  const blockedWriteScopes = writeScopes
    .filter((scope) => !supportedWriteScopes.has(scope))
    .sort();
  if (blockedWriteScopes.length > 0) {
    steps.push({
      step: 5,
      name: "CONTROLLED_WRITE 授权链支持",
      outcome: "FAIL",
      reason: `writeScopes 未获授权链支持: ${blockedWriteScopes.join(", ")}`
    });
    return decide("BLOCKED_BY_CAPABILITY", [], blockedWriteScopes);
  }
  steps.push({
    step: 5,
    name: "CONTROLLED_WRITE 授权链支持",
    outcome: writeScopes.length === 0 ? "SKIPPED" : "PASS",
    reason:
      writeScopes.length === 0
        ? "permissions.writeScopes 为空/未声明（步骤不适用）"
        : `writeScopes 全获授权链支持: ${[...writeScopes].sort().join(", ")}`
  });

  // 步骤 6：风险类匹配（计划未声明 → 跳过，不发明计划约束）
  if (parsedContext.allowedRiskClass == null) {
    steps.push({
      step: 6,
      name: "计划风险类匹配",
      outcome: "SKIPPED",
      reason: "计划未声明 allowedRiskClass（不发明计划约束，不降级）"
    });
  } else {
    const maxRiskClass: RiskClass = parsedProfile.permissions?.maxRiskClass ?? "LOW";
    if (RISK_CLASS_ORDER[maxRiskClass] > RISK_CLASS_ORDER[parsedContext.allowedRiskClass]) {
      steps.push({
        step: 6,
        name: "计划风险类匹配",
        outcome: "FAIL",
        reason: `maxRiskClass ${maxRiskClass} > 计划允许 ${parsedContext.allowedRiskClass}`
      });
      steps.push({
        step: 7,
        name: "汇总",
        outcome: "FAIL",
        reason: "存在未通过步骤：风险档降级（PARTIAL）"
      });
      return decide("PARTIAL");
    }
    steps.push({
      step: 6,
      name: "计划风险类匹配",
      outcome: "PASS",
      reason: `maxRiskClass ${maxRiskClass} ≤ 计划允许 ${parsedContext.allowedRiskClass}`
    });
  }

  // 步骤 7：全部通过
  steps.push({
    step: 7,
    name: "汇总",
    outcome: "PASS",
    reason: "全部前置步骤通过"
  });
  return decide("ELIGIBLE");
}
