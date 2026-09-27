/**
 * I-035 · RG-1 契约层（首批）+ RG-2 能力绑定层（小步续批）：agent-workforce role-grid 基础契约。
 *
 * 依据与证据分级：
 * - 方案稿 `.artifacts/i035-role-grid/proposal.md` §二/§三/§四（E2 计划）
 * - GM 裁决（2026-09-27）：4 必填（role / inputContract / outputContract / acceptance）
 *   + 6 过渡默认键位（skills / tools / permissions / memoryScope / kpi / escalation）；
 *   新包先行（零方言）。
 * - AW-1 静态能力清单稿 `.artifacts/i035-role-grid/aw1/capabilities.md`（RG-2 前置材料）
 * - 复用资产（E3 实测，2026-09-27）：
 *   `shared/src/index.ts:74-90`（ContractField / Input / Output 契约 schema）
 *   `shared/src/index.ts:342-372`（validateTemplateInputContract）
 *   `templates/src/index.ts:171-181`（formatOutput 输出校验口径）
 *   `shared/src/index.ts:65-72`（adapterActionTypeSchema）
 *   `shared/src/universal-contracts.ts:1175`、`:1307-1360`（CONTROLLED_WRITE 授权链口径）
 *
 * 边界（RG-1 / RG-2 小步）：
 * - 零方言：契约字段、动作类型与校验直接复用 `@neuroclaw/shared`，本包不造第二套结构。
 * - 零接线：`apps/**` 不 import 本包（RG-1 判据④）；本包为纯契约包，无副作用
 *   （清单为静态 JSON import，指纹为纯函数）。
 * - RG-2 本批切片：① `capability-inventory.v1.json` 首版（schema + fingerprint + resolver）
 *   ② skills / tools / permissions 收紧 + write scope 授权链前置门禁。
 *   匹配器 tierC（RG-2b）复用 `shared/capability-matching.ts`（D5 唯一实现），
 *   接线方式待 GM 裁点③，本批不另建 `capability-match` 包；memoryScope/kpi/escalation 仍归 RG-3。
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  adapterActionTypeSchema,
  evidenceLevelSchema,
  templateContractFieldSchema,
  templateInputContractSchema,
  templateOutputContractSchema,
  universalIdSchema,
  validateTemplateInputContract,
  type EvidenceLevel,
  type TemplateContractField,
  type TemplateInputContract,
  type TemplateOutputContract,
  type TemplateInputPayload,
  type TemplateOutputPayload
} from "@neuroclaw/shared";
import capabilityInventoryV1Json from "./capability-inventory.v1.json" with { type: "json" };

// ---------------------------------------------------------------------------
// §1 AgentRoleKey — 8 岗位键（唯一分派 / 裁决键）
// ---------------------------------------------------------------------------

/** 8 岗位固定顺序（来源：方案稿 §3.2 矩阵实测名单）。 */
export const AGENT_ROLE_KEYS = [
  "goal_officer",
  "strategist",
  "content_editor",
  "conversion_writer",
  "channel_ops",
  "analyst",
  "compliance_reviewer",
  "retro_officer"
] as const;

export const agentRoleKeySchema = z.enum(AGENT_ROLE_KEYS);
export type AgentRoleKey = z.infer<typeof agentRoleKeySchema>;

// ---------------------------------------------------------------------------
// §2 契约字段与输入 / 输出契约（复用 templates 结构，零方言）
// ---------------------------------------------------------------------------

/** 契约字段结构：复用 `@neuroclaw/shared.templateContractFieldSchema`。 */
export const agentContractFieldSchema = templateContractFieldSchema;
export type AgentContractField = TemplateContractField;

/** 输入契约 `{ fields }`：结构同 templates `inputContract`（templates/src/index.ts:45-58）。 */
export const agentInputContractSchema = templateInputContractSchema;
export type AgentInputContract = TemplateInputContract;

/** 输出契约 `{ fields }`：结构同 templates `outputContract`。 */
export const agentOutputContractSchema = templateOutputContractSchema;
export type AgentOutputContract = TemplateOutputContract;

// ---------------------------------------------------------------------------
// §3 acceptance — 验收定义（谁验、验到哪级证据）
// ---------------------------------------------------------------------------

/**
 * acceptance 证据级别口径为 E0–E3（方案稿 §2 字段 4）。
 * E4 属外部事实，agent 产出不得自证 E4，故不在枚举内。
 */
export const acceptanceEvidenceLevelSchema = z.enum(["E0", "E1", "E2", "E3"]);
export type AcceptanceEvidenceLevel = z.infer<typeof acceptanceEvidenceLevelSchema>;

export const acceptanceVerifierSchema = z.enum(["self", "peer_role", "human"]);
export type AcceptanceVerifier = z.infer<typeof acceptanceVerifierSchema>;

export const agentAcceptanceSchema = z.object({
  requiredOutputFields: z.array(z.string()),
  minEvidenceLevel: acceptanceEvidenceLevelSchema,
  verifier: acceptanceVerifierSchema
});
export type AgentAcceptance = z.infer<typeof agentAcceptanceSchema>;

// ---------------------------------------------------------------------------
// §3.5 RG-2：skills / tools / permissions 绑定 schema（提案 §二 字段 5/6/7）
// ---------------------------------------------------------------------------

/**
 * 技能绑定（提案 §二-5）：`{skillKey, skillVersion, capabilityRefs, promptTemplateRef}`。
 * capabilityRefs 采用 shared `universalIdSchema`（capabilityRef 词汇，零方言）。
 */
export const agentSkillBindingSchema = z
  .object({
    skillKey: z.string().min(1),
    skillVersion: z.string().min(1),
    capabilityRefs: z.array(universalIdSchema),
    promptTemplateRef: z.string().min(1)
  })
  .strict();
export type AgentSkillBinding = z.infer<typeof agentSkillBindingSchema>;

export const agentToolScopeSchema = z.enum(["read", "write"]);
export type AgentToolScope = z.infer<typeof agentToolScopeSchema>;

/**
 * 工具绑定（提案 §二-6）：`{toolKey, capabilityRef, scopes, actionType?, requiresApproval}`。
 * actionType 复用 shared `adapterActionTypeSchema`；write scope 走 CONTROLLED_WRITE
 * 授权链（`universal-contracts.ts:1307-1360`），前置门禁见 §4 superRefine。
 */
export const agentToolBindingSchema = z
  .object({
    toolKey: z.string().min(1),
    capabilityRef: universalIdSchema,
    scopes: z.array(agentToolScopeSchema),
    actionType: adapterActionTypeSchema.optional(),
    requiresApproval: z.boolean()
  })
  .strict();
export type AgentToolBinding = z.infer<typeof agentToolBindingSchema>;

/**
 * 权限与写范围（提案 §二-7）：`{readScopes, writeScopes, maxRiskClass,
 * requiresApprovalFor, rateLimit?}`；rateLimit 仅 `enforced` 模式有效。
 */
export const agentPermissionsSchema = z
  .object({
    readScopes: z.array(z.string()),
    writeScopes: z.array(z.string()),
    maxRiskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    requiresApprovalFor: z.array(adapterActionTypeSchema),
    rateLimit: z
      .object({ mode: z.literal("enforced"), perHour: z.number().int().positive() })
      .strict()
      .optional()
  })
  .strict();
export type AgentPermissions = z.infer<typeof agentPermissionsSchema>;

// ---------------------------------------------------------------------------
// §4 AgentProfile — 4 必填 + 6 过渡默认键位（GM 裁决 2026-09-27）
// ---------------------------------------------------------------------------

export const agentProfileSchema = z
  .object({
    // —— 4 必填：上岗最小集 ——
    role: agentRoleKeySchema,
    inputContract: agentInputContractSchema,
    outputContract: agentOutputContractSchema,
    acceptance: agentAcceptanceSchema,
    // —— 6 过渡默认：skills/tools/permissions 已由 RG-2 收紧（可缺省；存在即须合规），
    //    memoryScope/kpi/escalation 仍仅冻结键位，RG-3 收紧 ——
    skills: z.array(agentSkillBindingSchema).optional(),
    tools: z.array(agentToolBindingSchema).optional(),
    permissions: agentPermissionsSchema.optional(),
    memoryScope: z.unknown().optional(),
    kpi: z.unknown().optional(),
    escalation: z.unknown().optional()
  })
  .strict()
  .superRefine((profile, ctx) => {
    const declared = new Set(profile.outputContract.fields.map((field) => field.name));
    for (const name of profile.acceptance.requiredOutputFields) {
      if (!declared.has(name)) {
        ctx.addIssue({
          code: "custom",
          message: `acceptance.requiredOutputFields 含 outputContract 未声明字段: ${name}`,
          path: ["acceptance", "requiredOutputFields"]
        });
      }
    }

    // RG-2 门禁：write scope ⇒ permissions.writeScopes 非空 + requiresApproval=true
    //（CONTROLLED_WRITE 授权链前置，`universal-contracts.ts:1307-1360`）。
    for (const tool of profile.tools ?? []) {
      if (!tool.scopes.includes("write")) continue;
      if (!profile.permissions) {
        ctx.addIssue({
          code: "custom",
          message: `tool '${tool.toolKey}' 含 write scope 但未声明 permissions（CONTROLLED_WRITE 授权链前置缺失）`,
          path: ["permissions"]
        });
        continue;
      }
      if (profile.permissions.writeScopes.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: `tool '${tool.toolKey}' 含 write scope 但 permissions.writeScopes 为空`,
          path: ["permissions", "writeScopes"]
        });
      }
      if (!tool.requiresApproval) {
        ctx.addIssue({
          code: "custom",
          message: `tool '${tool.toolKey}' 含 write scope 须 requiresApproval=true（CONTROLLED_WRITE 审批门）`,
          path: ["tools"]
        });
      }
    }
  });

export type AgentProfile = z.infer<typeof agentProfileSchema>;

// ---------------------------------------------------------------------------
// §5 校验点（纯函数，零接线可独立使用）
// ---------------------------------------------------------------------------

/**
 * 输入契约校验：必填字段存在 + 类型匹配。
 * 直接复用 shared `validateTemplateInputContract`（零方言），抛错文案沿用 templates 口径。
 */
export function validateAgentInputContract(
  input: TemplateInputPayload,
  contract: AgentInputContract
): void {
  validateTemplateInputContract(input, contract);
}

/**
 * 输出契约校验（对齐 templates `formatOutput` 口径并加严）：
 * 1. 未声明字段一律拒绝（防上游污染下游）；
 * 2. 必填字段缺失（undefined / null / ""）即抛错，缺失口径与 shared 输入校验一致。
 */
export function validateAgentOutputContract(
  output: TemplateOutputPayload,
  contract: AgentOutputContract
): void {
  const declared = new Set(contract.fields.map((field) => field.name));
  for (const key of Object.keys(output)) {
    if (!declared.has(key)) {
      throw new Error(`Agent output has undeclared field: ${key}`);
    }
  }

  for (const field of contract.fields) {
    const value = output[field.name];
    if (field.required && (value === undefined || value === null || value === "")) {
      throw new Error(`Agent output requires ${field.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// §6 RG-2：静态能力清单 v1（capability-inventory.v1.json 首版）
// ---------------------------------------------------------------------------

/**
 * 清单条目（AW-1 基线：3 模板 + 5 动作 + 3 实测 ref + 缺口条目）：
 * - kind：条目的词汇类别（模板 / 动作类型 / capabilityRef）；
 * - status：AVAILABLE = 代码面存在（E3 实测）；MISSING = 缺口（不发明）；
 * - evidenceLevel：复用 shared `evidenceLevelSchema`（E0–E4），AVAILABLE 须 ≥E1（D5 证据地板）。
 */
export const capabilityInventoryEntrySchema = z
  .object({
    capabilityRef: universalIdSchema,
    kind: z.enum(["template", "action", "capability_ref"]),
    status: z.enum(["AVAILABLE", "MISSING"]),
    evidenceLevel: evidenceLevelSchema,
    source: z.string().min(1)
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.status === "AVAILABLE" && entry.evidenceLevel === "E0") {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceLevel"],
        message: `AVAILABLE 条目须有 ≥E1 证据（D5 证据地板）: ${entry.capabilityRef}`
      });
    }
  });
export type CapabilityInventoryEntry = z.infer<typeof capabilityInventoryEntrySchema>;

export const capabilityInventorySchema = z
  .object({
    version: z.literal("1.0"),
    entries: z.array(capabilityInventoryEntrySchema).min(1)
  })
  .strict()
  .superRefine((inventory, ctx) => {
    const seen = new Set<string>();
    inventory.entries.forEach((entry, index) => {
      if (seen.has(entry.capabilityRef)) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "capabilityRef"],
          message: `重复 capabilityRef: ${entry.capabilityRef}`
        });
      }
      seen.add(entry.capabilityRef);
    });
  });
export type CapabilityInventory = z.infer<typeof capabilityInventorySchema>;

/** 首版清单（静态 JSON；条目来源见各 source 字段，缺口不发明）。 */
export const CAPABILITY_INVENTORY_V1: CapabilityInventory =
  capabilityInventorySchema.parse(capabilityInventoryV1Json);

/** 事实源文件（用于指纹与快照复核）。 */
export const CAPABILITY_INVENTORY_V1_FILE = "capability-inventory.v1.json";

/** 确定性 JSON（递归排序键，口径与 `shared/capability-matching.ts` 一致）。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * 清单指纹：对 parse 后的清单做 canonical JSON + sha256。
 * 同输入两次调用字节一致（默认参数即 CAPABILITY_INVENTORY_V1）。
 */
export function capabilityInventoryFingerprint(
  inventory: CapabilityInventory = CAPABILITY_INVENTORY_V1
): string {
  return createHash("sha256")
    .update(canonicalJson(capabilityInventorySchema.parse(inventory)))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// §7 RG-2：capabilityRef 解析（BLOCKED 名单元数据；tierC 匹配器复用 shared D5）
// ---------------------------------------------------------------------------

export interface AgentCapabilityResolutionItem {
  capabilityRef: string;
  source: "skills" | "tools";
  status: "COVERED" | "MISSING";
  inventoryStatus: "AVAILABLE" | "MISSING" | "NOT_IN_INVENTORY";
  evidenceLevel: EvidenceLevel | "E0";
}

export interface AgentCapabilityResolution {
  status: "ELIGIBLE" | "BLOCKED_BY_CAPABILITY";
  items: AgentCapabilityResolutionItem[];
  blocked: string[];
}

/**
 * 解析 profile 中全部 capabilityRef（skills[].capabilityRefs + tools[].capabilityRef）：
 * - AVAILABLE 条目 ⇒ COVERED；MISSING / 不在清单 ⇒ MISSING（fail-closed，不发明）；
 * - 任一 MISSING ⇒ 整体 BLOCKED_BY_CAPABILITY，`blocked` 为去重排序名单；
 * - 纯函数、确定性输出；tierC 的 MUST=MISSING ⇒ 退出码非零口径由 shared D5 匹配器承担。
 */
export function resolveAgentCapabilityRefs(
  profile: AgentProfile,
  inventory: CapabilityInventory = CAPABILITY_INVENTORY_V1
): AgentCapabilityResolution {
  const parsedInventory = capabilityInventorySchema.parse(inventory);
  const byRef = new Map(parsedInventory.entries.map((entry) => [entry.capabilityRef, entry]));

  const refs: Array<{ capabilityRef: string; source: "skills" | "tools" }> = [];
  for (const skill of profile.skills ?? []) {
    for (const capabilityRef of skill.capabilityRefs) {
      refs.push({ capabilityRef, source: "skills" });
    }
  }
  for (const tool of profile.tools ?? []) {
    refs.push({ capabilityRef: tool.capabilityRef, source: "tools" });
  }

  const seen = new Set<string>();
  const items: AgentCapabilityResolutionItem[] = [];
  for (const ref of [...refs].sort((left, right) =>
    left.source === right.source
      ? left.capabilityRef.localeCompare(right.capabilityRef)
      : left.source.localeCompare(right.source)
  )) {
    const key = `${ref.source}\u0000${ref.capabilityRef}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const entry = byRef.get(ref.capabilityRef);
    items.push({
      capabilityRef: ref.capabilityRef,
      source: ref.source,
      status: entry?.status === "AVAILABLE" ? "COVERED" : "MISSING",
      inventoryStatus: entry ? entry.status : "NOT_IN_INVENTORY",
      evidenceLevel: entry ? entry.evidenceLevel : "E0"
    });
  }

  const blocked = [
    ...new Set(items.filter((item) => item.status === "MISSING").map((item) => item.capabilityRef))
  ].sort();

  return {
    status: blocked.length > 0 ? "BLOCKED_BY_CAPABILITY" : "ELIGIBLE",
    items,
    blocked
  };
}
