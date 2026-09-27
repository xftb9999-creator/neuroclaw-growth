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
 *   接线方式待 GM 裁点③，本批不另建 `capability-match` 包。
 * - RG-3 本批切片：memoryScope / kpi / escalation 收紧（§3.6）+ `duty-decision.ts`
 *   上岗裁决纯函数（不进包 barrel，循 RG-2b 非 barrel 先例）；插件化（AW-6）属 P-2，不做。
 * - M1 本批切片（2026-09-27）：8 岗位 profile 终稿 v1（`profiles.v1.json` + 指纹，§8）；
 *   3 个 E3 岗位契约零新写直迁、5 个设计岗 E1 草案复核后定稿；无来源的键位缺省（见留证）。
 * - 裁点⑤ 本批切片（2026-09-27）：5 设计岗 persona 草案 v1（`persona-drafts.v1.json` + 指纹，§9）；
 *   3 个 E3 直迁岗 persona 以 templates 原文为唯一真源，不在本包复制（迁移落库属 AW-5 接线）。
 * - AW-0 本批切片（2026-09-27）：§10 GoalSpec / PlanSpec / TaskNode / TaskEdge 契约
 *   （`.strict()`；图硬校验经 TaskNode→WorkflowNode 投影复用 shared `validateWorkflowGraph`；
 *   能力覆盖校验 / BLOCKED 员工引用校验〔F5 前半〕属后续批）。
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
  utcTimestampSchema,
  validateTemplateInputContract,
  validateWorkflowGraph,
  workflowEdgeSchema,
  type EvidenceLevel,
  type TemplateContractField,
  type TemplateInputContract,
  type TemplateOutputContract,
  type TemplateInputPayload,
  type TemplateOutputPayload,
  type WorkflowDefinition,
  type WorkflowEdge
} from "@neuroclaw/shared";
import capabilityInventoryV1Json from "./capability-inventory.v1.json" with { type: "json" };
import agentProfilesV1Json from "./profiles.v1.json" with { type: "json" };
import agentPersonaDraftsV1Json from "./persona-drafts.v1.json" with { type: "json" };

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
// §3.6 RG-3：治理字段 memoryScope / kpi / escalation（提案 §二 字段 8/9/10）
// ---------------------------------------------------------------------------

/**
 * 记忆可见性：复用 memory 层词汇 `"private" | "team"`
 * （E3 实测：`packages/memory/src/index.ts:24`、`packages/db/src/schema.ts:241+`）。
 */
export const agentMemoryVisibilitySchema = z.enum(["private", "team"]);
export type AgentMemoryVisibility = z.infer<typeof agentMemoryVisibilitySchema>;

/**
 * 记忆范围（提案 §二-8）：`{visibility, namespace, retentionDays, readableNamespaces}`。
 * - `readableNamespaces` 为**显式白名单**：拒绝通配符（含 `*`）——跨工作区/项目一律禁止
 *   （agent-workforce.md:520-521“scope 强制”口径），本包以结构约束落地（E2 解读）；
 * - 重复项拒绝（确定性）；`retentionDays` / 各项为正整数。
 */
export const agentMemoryScopeSchema = z
  .object({
    visibility: agentMemoryVisibilitySchema,
    /** 建议 = `role + agentKey`（提案 §二-8；agentKey 属 AW-0 完整草案，本包暂为自由串）。 */
    namespace: z.string().min(1),
    retentionDays: z.number().int().positive(),
    readableNamespaces: z.array(z.string().min(1))
  })
  .strict()
  .superRefine((scope, ctx) => {
    const seen = new Set<string>();
    scope.readableNamespaces.forEach((namespace, index) => {
      if (namespace.includes("*")) {
        ctx.addIssue({
          code: "custom",
          path: ["readableNamespaces", index],
          message: `readableNamespaces 须为显式白名单，不接受通配符: ${namespace}`
        });
      }
      if (seen.has(namespace)) {
        ctx.addIssue({
          code: "custom",
          path: ["readableNamespaces", index],
          message: `readableNamespaces 重复项: ${namespace}`
        });
      }
      seen.add(namespace);
    });
  });
export type AgentMemoryScope = z.infer<typeof agentMemoryScopeSchema>;

/**
 * KPI 指标条目（提案 §二-9）：`{metricKey, target, unit, windowDays, evidenceLevelRequired}`。
 * - 证据级别沿用 acceptance 口径 E0–E3（agent 产出不得自证 E4）；
 * - “只允许可复算指标”需指标注册表（实测不存在）→ 结构层不可校验，属接线阶段（证据 deferred）。
 */
export const agentKpiEntrySchema = z
  .object({
    metricKey: z.string().min(1),
    target: z.number(),
    unit: z.string().min(1),
    windowDays: z.number().int().positive(),
    evidenceLevelRequired: acceptanceEvidenceLevelSchema
  })
  .strict();
export type AgentKpiEntry = z.infer<typeof agentKpiEntrySchema>;

/** 失败路径枚举（提案 §二-10）；`halt` 不得静默降级 = 运行期语义（执行器责任，结构层不可校验）。 */
export const agentEscalationFailureModeSchema = z.enum(["retry", "degrade", "escalate", "halt"]);
export type AgentEscalationFailureMode = z.infer<typeof agentEscalationFailureModeSchema>;

/**
 * 上报目标：岗位键 ∪ `"human"`。
 * 解读：类型草案为 `AgentRoleKey`（提案 §二-10），校验点明确“`reportsTo` 可指向 human role”
 * → 以 union 同时表达（`"human"` 非第 9 个岗位，不改 `AGENT_ROLE_KEYS`；E2 解读，待复核）。
 */
export const agentEscalationTargetSchema = z.union([agentRoleKeySchema, z.literal("human")]);
export type AgentEscalationTarget = z.infer<typeof agentEscalationTargetSchema>;

/** 上报关系与失败路径（提案 §二-10）：`{reportsTo, onFailure, maxRetries}`。 */
export const agentEscalationSchema = z
  .object({
    reportsTo: agentEscalationTargetSchema,
    onFailure: agentEscalationFailureModeSchema,
    maxRetries: z.number().int().nonnegative()
  })
  .strict();
export type AgentEscalation = z.infer<typeof agentEscalationSchema>;

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
    // —— 6 过渡默认：skills/tools/permissions 已由 RG-2 收紧、memoryScope/kpi/escalation
    //    已由 RG-3 收紧（§3.6）；均可缺省，存在即须合规 ——
    skills: z.array(agentSkillBindingSchema).optional(),
    tools: z.array(agentToolBindingSchema).optional(),
    permissions: agentPermissionsSchema.optional(),
    memoryScope: agentMemoryScopeSchema.optional(),
    kpi: z.array(agentKpiEntrySchema).optional(),
    escalation: agentEscalationSchema.optional()
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

/**
 * 确定性 JSON（递归排序键，口径与 `shared/capability-matching.ts` 一致）。
 * RG-3：导出供 `duty-decision.ts` 复算 inputFingerprint（同包复用，避免第二套序列化方言）。
 */
export function canonicalJson(value: unknown): string {
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

// ---------------------------------------------------------------------------
// §8 M1：8 岗位 profile 终稿 v1（profiles.v1.json）
// ---------------------------------------------------------------------------

/**
 * 文件形态 `{version:"1.0", profiles: AgentProfile[]}`（`.strict()`）。
 * 不变量：role 唯一且恰为 `AGENT_ROLE_KEYS` 全量（8/8，缺一/重复即拒）。
 * 落盘口径：3 个 E3 岗位契约零新写直迁 templates；5 个设计岗 E1 草案经复核定稿；
 * 其余键位仅落有来源者（无来源不发明，见 `.artifacts/impl/20260927-m1-profiles.md`）。
 */
export const agentProfilesSchema = z
  .object({
    version: z.literal("1.0"),
    profiles: z.array(agentProfileSchema).min(1)
  })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    document.profiles.forEach((profile, index) => {
      if (seen.has(profile.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles", index, "role"],
          message: `重复 role: ${profile.role}`
        });
      }
      seen.add(profile.role);
    });
    for (const role of AGENT_ROLE_KEYS) {
      if (!seen.has(role)) {
        ctx.addIssue({
          code: "custom",
          path: ["profiles"],
          message: `缺少 role 终稿: ${role}`
        });
      }
    }
  });
export type AgentProfilesDocument = z.infer<typeof agentProfilesSchema>;

/** 8 岗位 profile 终稿 v1（静态 JSON；来源见 .artifacts/impl/20260927-m1-profiles.md）。 */
export const AGENT_PROFILES_V1: AgentProfilesDocument = agentProfilesSchema.parse(agentProfilesV1Json);

/** 事实源文件（用于指纹与快照复核）。 */
export const AGENT_PROFILES_V1_FILE = "profiles.v1.json";

/**
 * profiles 指纹：对 parse 后的文档做 canonical JSON + sha256（口径同清单指纹）。
 * 同输入两次调用字节一致（默认参数即 AGENT_PROFILES_V1）。
 */
export function agentProfilesFingerprint(
  document: AgentProfilesDocument = AGENT_PROFILES_V1
): string {
  return createHash("sha256")
    .update(canonicalJson(agentProfilesSchema.parse(document)))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// §9 裁点⑤：5 设计岗 persona 草案 v1（persona-drafts.v1.json）
// ---------------------------------------------------------------------------

/**
 * 5 个设计岗固定顺序（= `AGENT_ROLE_KEYS` 去除 3 个 E3 直迁岗后的相对顺序；
 * 来源：方案稿 §3.2、M1 留证 §三/§四）。仅这 5 岗进草案文件；
 * 3 个 E3 直迁岗 persona 以 `templates/src/index.ts:43-44 / :73-74 / :109-110` 原文为唯一真源。
 */
export const AGENT_DESIGN_ROLE_KEYS = [
  "goal_officer",
  "strategist",
  "channel_ops",
  "compliance_reviewer",
  "retro_officer"
] as const;
export type AgentDesignRoleKey = (typeof AGENT_DESIGN_ROLE_KEYS)[number];

/**
 * persona 草案条目：恰 2 键（`.strict()`）。
 * `persona` 为单行文本（与 3 直迁 templates 载体同格式；不得含换行）。
 */
export const agentPersonaDraftSchema = z
  .object({
    role: agentRoleKeySchema,
    persona: z
      .string()
      .min(1)
      .refine((text) => !/[\r\n]/.test(text), {
        message: "persona 草案须为单行文本（与 3 直迁 templates 同格式）"
      })
  })
  .strict();
export type AgentPersonaDraft = z.infer<typeof agentPersonaDraftSchema>;

/**
 * 文件形态 `{version:"1.0-draft", drafts: [{role, persona}]}`（`.strict()`）。
 * 不变量：role 唯一且恰为 5 设计岗全量（缺一/重复/混入 3 直迁岗即拒）。
 * 状态：**草案**——独立复核通过后方可升为 v1.0；本文件不落库、不接线（AW-5 范围）。
 */
export const agentPersonaDraftsSchema = z
  .object({
    version: z.literal("1.0-draft"),
    drafts: z.array(agentPersonaDraftSchema).min(1)
  })
  .strict()
  .superRefine((document, ctx) => {
    const seen = new Set<string>();
    document.drafts.forEach((draft, index) => {
      if (seen.has(draft.role)) {
        ctx.addIssue({
          code: "custom",
          path: ["drafts", index, "role"],
          message: `重复 role: ${draft.role}`
        });
      }
      seen.add(draft.role);
    });
    for (const role of AGENT_DESIGN_ROLE_KEYS) {
      if (!seen.has(role)) {
        ctx.addIssue({ code: "custom", path: ["drafts"], message: `缺少设计岗草案: ${role}` });
      }
    }
    for (const role of seen) {
      if (!(AGENT_DESIGN_ROLE_KEYS as readonly string[]).includes(role)) {
        ctx.addIssue({
          code: "custom",
          path: ["drafts"],
          message: `非设计岗不得进入草案（直迁岗保持 templates 原文）: ${role}`
        });
      }
    }
  });
export type AgentPersonaDraftsDocument = z.infer<typeof agentPersonaDraftsSchema>;

/** 5 设计岗 persona 草案 v1（静态 JSON；来源见 `.artifacts/impl/20260927-persona-drafts.md`）。 */
export const AGENT_PERSONA_DRAFTS_V1: AgentPersonaDraftsDocument =
  agentPersonaDraftsSchema.parse(agentPersonaDraftsV1Json);

/** 事实源文件（用于指纹与快照复核）。 */
export const AGENT_PERSONA_DRAFTS_V1_FILE = "persona-drafts.v1.json";

/**
 * persona 草案指纹：对 parse 后的文档做 canonical JSON + sha256（口径同 profiles/清单指纹）。
 * 同输入两次调用字节一致（默认参数即 `AGENT_PERSONA_DRAFTS_V1`）。
 */
export function agentPersonaDraftsFingerprint(
  document: AgentPersonaDraftsDocument = AGENT_PERSONA_DRAFTS_V1
): string {
  return createHash("sha256")
    .update(canonicalJson(agentPersonaDraftsSchema.parse(document)))
    .digest("hex");
}

// ---------------------------------------------------------------------------
// §10 AW-0：目标 / 计划契约（GoalSpec / PlanSpec / TaskNode / TaskEdge）
// ---------------------------------------------------------------------------

/**
 * AW-0 规格来源（E1 设计）：
 * - `agent-workforce.md` §2.2（:129-193 GoalSpec 草案）、§2.3（:197-256 PlanSpec /
 *   TaskNode / TaskEdge 草案 + 8 条结构性硬约束）、§2.5 复用表（:375-390）、
 *   §4.2 AW-0 判据（:636）。
 * 复用口径（零方言）：
 * - TaskEdge = shared `workflowEdgeSchema`（universal-contracts.ts:247-255）直接复用（同构）；
 * - TaskNode 字段超集：capabilityRefs / riskClass / timeoutMs / approvalPoint 与
 *   `workflowNodeSchema`（:230-244）同口径；
 * - 图硬校验（无环 / 引用存在 / 审批一致性 / 审批策略非空）调用 shared
 *   `validateWorkflowGraph`（:2685-2756），不重写 Kahn。
 * 本批边界（零接线）：
 * - 能力覆盖校验（capabilityRefs 全部 COVERED；BLOCKED 员工不可被引用）＝F5 前半，属后续批；
 * - 纯图校验内核抽取（设计 :717 缓解项）需修改 shared，超本批 write scope，暂以
 *   TaskNode→WorkflowNode 投影方式复用（校验语义不变），留待独立批；
 * - 无数据文件：契约冻结批无实例数据，GoalSpec / PlanSpec 实例由 AW-2 规划器产生。
 */

/** 风险档：与 shared `workflowNodeSchema.riskClass` / `workItemSchema` 同词汇（:237）。 */
export const agentRiskClassSchema = z.enum(["LOW", "MEDIUM", "HIGH"]);
export type AgentRiskClass = z.infer<typeof agentRiskClassSchema>;

/** 成本单位：GoalSpec.constraints.budget.unit 与 PlanSpec.estimatedCost.unit 共用（:161/:221）。 */
export const agentCostUnitSchema = z.enum(["run", "token", "usd"]);
export type AgentCostUnit = z.infer<typeof agentCostUnitSchema>;

/** 能力层分层键 L0–L8（:178/:216；plugin-roadmap §一）。 */
export const agentCapabilityLayerSchema = z.enum([
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8"
]);
export type AgentCapabilityLayer = z.infer<typeof agentCapabilityLayerSchema>;

/**
 * 目标作用域（:139）：组织 / 工作区 / 项目三者必填（禁止跨域推断）。
 * 单对象层强校验三者存在；跨对象链一致性走 shared `assertScopeConsistency`
 * （universal-contracts.ts:1802）——为执行/接线层调用，本包不重复实现。
 */
export const goalScopeSchema = z
  .object({
    organizationId: universalIdSchema,
    workspaceId: universalIdSchema,
    projectId: universalIdSchema
  })
  .strict();
export type GoalScope = z.infer<typeof goalScopeSchema>;

/**
 * 成功判据（:148-157）。E2 解读（来源 :463 goal_officer 验收 ③「每条判据带
 * `metricDefinitionRef` 或显式 `UNVERIFIED`」）：无 `metricDefinitionRef` 时
 * `verifiability` 必须显式为 `UNVERIFIED`；`metricDefinitionRef` 的注册表解析
 * （metricDefinitions 不存在）属执行层。
 */
export const goalSuccessCriterionSchema = z
  .object({
    criterionId: universalIdSchema,
    key: z.string().min(1),
    target: z.union([z.string(), z.number()]),
    unit: z.string().min(1),
    metricDefinitionRef: universalIdSchema.optional(),
    evidenceLevelRequired: acceptanceEvidenceLevelSchema,
    verifiability: z.enum(["MEASURABLE", "UNVERIFIED"])
  })
  .strict()
  .superRefine((criterion, ctx) => {
    if (criterion.verifiability !== "UNVERIFIED" && !criterion.metricDefinitionRef) {
      ctx.addIssue({
        code: "custom",
        path: ["metricDefinitionRef"],
        message: "MEASURABLE 判据必须带 metricDefinitionRef（或显式标 UNVERIFIED）"
      });
    }
  });
export type GoalSuccessCriterion = z.infer<typeof goalSuccessCriterionSchema>;

/** 预算（:161）：`limit > 0`（:262 Step 1），`windowDays` 正整数。 */
export const goalBudgetSchema = z
  .object({
    unit: agentCostUnitSchema,
    limit: z.number().positive(),
    windowDays: z.number().int().positive()
  })
  .strict();
export type GoalBudget = z.infer<typeof goalBudgetSchema>;

/** 硬约束（:160-166）：规划器必须遵守且不得放宽。 */
export const goalConstraintsSchema = z
  .object({
    budget: goalBudgetSchema,
    timeWindow: z
      .object({
        notBefore: utcTimestampSchema.optional(),
        deadline: utcTimestampSchema.optional()
      })
      .strict(),
    maxTasks: z.number().int().positive(),
    maxAgents: z.number().int().positive(),
    maxRiskClass: agentRiskClassSchema
  })
  .strict();
export type GoalConstraints = z.infer<typeof goalConstraintsSchema>;

/**
 * 合规边界（:168-174）。`stopLineHits` 非空是**合法输入**（规划侧转 tier C /
 * BLOCKED，:191），schema 不拒——停止线的 fail-closed 语义在执行/规划层。
 */
export const goalComplianceSchema = z
  .object({
    regimes: z.array(z.string().min(1)),
    dataResidency: z.string().min(1).optional(),
    platformTosRefs: z.array(z.string().min(1)),
    stopLineHits: z.array(z.string().min(1))
  })
  .strict();
export type GoalCompliance = z.infer<typeof goalComplianceSchema>;

/** 渠道资源面（:177）。 */
export const goalChannelSchema = z
  .object({
    channelKey: z.string().min(1),
    accountStatus: z.enum(["NONE", "PENDING", "READY"])
  })
  .strict();
export type GoalChannel = z.infer<typeof goalChannelSchema>;

/**
 * GoalSpec（:134-187）：运行时目标契约；`objectiveRef?` 指向已存在 Objective
 * （universal-contracts.ts:120-136），不复制其字段语义。
 * `goalVersion` 为 semver 草案口径；shared 无「纯 semver 版本」校验器（仅有
 * semverRangeSchema 范围语义），维持 `z.string().min(1)`（与
 * `agentSkillBindingSchema.skillVersion` 同口径）。
 */
export const goalSpecSchema = z
  .object({
    goalId: universalIdSchema,
    goalVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    scope: goalScopeSchema,
    title: z.string().min(1),
    objectiveKind: z.enum(["growth", "operation", "research", "review"]),
    intent: z.string().min(1),
    objectiveRef: universalIdSchema.optional(),
    initiativeRefs: z.array(universalIdSchema).optional(),
    successCriteria: z.array(goalSuccessCriterionSchema).min(1),
    constraints: goalConstraintsSchema,
    compliance: goalComplianceSchema,
    channels: z.array(goalChannelSchema),
    availableCapabilityLayers: z.array(agentCapabilityLayerSchema).optional(),
    installedInventoryFingerprint: z.string().min(1),
    approvalMode: z.enum(["human_in_the_loop", "human_on_the_loop"]),
    requestedOutcome: z.enum(["draft", "delivered", "measured"]),
    createdBy: z.string().min(1),
    createdAt: utcTimestampSchema
  })
  .strict();
export type GoalSpec = z.infer<typeof goalSpecSchema>;

/**
 * GoalSpec 内容指纹（:202 `goalFingerprint` 语义：防目标漂移）。
 * 口径同 §6/§8/§9：canonical JSON + sha256；同输入两次调用字节一致。
 */
export function goalSpecFingerprint(spec: GoalSpec): string {
  return createHash("sha256").update(canonicalJson(goalSpecSchema.parse(spec))).digest("hex");
}

/** 结构化交接输入（:235）：替代字符串拼接；基础校验见 PlanSpec 约束 8。 */
export const taskHandoffInputSchema = z
  .object({
    fromTask: universalIdSchema,
    field: z.string().min(1)
  })
  .strict();
export type TaskHandoffInput = z.infer<typeof taskHandoffInputSchema>;

/** 任务输出声明（:236）：`field` + 契约字段（复用 §2 `agentContractFieldSchema`，零方言）。 */
export const taskOutputSchema = z
  .object({
    field: z.string().min(1),
    contract: z.array(agentContractFieldSchema)
  })
  .strict();
export type TaskOutput = z.infer<typeof taskOutputSchema>;

/** 任务级验收判据（:237）。 */
export const taskAcceptanceCriterionSchema = z
  .object({
    criterionId: universalIdSchema,
    key: z.string().min(1),
    target: z.union([z.string(), z.number()]),
    unit: z.string().min(1),
    evidenceLevelRequired: acceptanceEvidenceLevelSchema
  })
  .strict();
export type TaskAcceptanceCriterion = z.infer<typeof taskAcceptanceCriterionSchema>;

/** 重试策略（:241）：`maxAttempts` / `backoffMs` 非负整数（与 `agentEscalationSchema.maxRetries` 同口径）。 */
export const taskRetryPolicySchema = z
  .object({
    maxAttempts: z.number().int().nonnegative(),
    backoffMs: z.number().int().nonnegative().optional()
  })
  .strict();
export type TaskRetryPolicy = z.infer<typeof taskRetryPolicySchema>;

/** 任务种类（:231）。 */
export const taskNodeKindSchema = z.enum([
  "extract",
  "generate",
  "publish",
  "measure",
  "review",
  "approve"
]);
export type TaskNodeKind = z.infer<typeof taskNodeKindSchema>;

/** 失败策略（:242）；`halt` 不得静默降级为运行期语义（执行器责任）。 */
export const taskFailurePolicySchema = z.enum(["explicit_failure", "degrade", "escalate"]);
export type TaskFailurePolicy = z.infer<typeof taskFailurePolicySchema>;

/**
 * TaskNode（:229-243）：`workflowNodeSchema`（universal-contracts.ts:230-244）字段超集。
 * 复用：capabilityRefs / riskClass / timeoutMs / approvalPoint 原样同口径；
 * 新增：taskId / title / assignedRole / inputs / outputs / acceptanceCriteria / failurePolicy。
 */
export const taskNodeSchema = z
  .object({
    taskId: universalIdSchema,
    kind: taskNodeKindSchema,
    title: z.string().min(1),
    capabilityRefs: z.array(universalIdSchema),
    assignedRole: agentRoleKeySchema,
    inputs: z.array(taskHandoffInputSchema),
    outputs: z.array(taskOutputSchema),
    acceptanceCriteria: z.array(taskAcceptanceCriterionSchema),
    riskClass: agentRiskClassSchema,
    timeoutMs: z.number().int().positive(),
    approvalPoint: z.boolean(),
    retryPolicy: taskRetryPolicySchema,
    failurePolicy: taskFailurePolicySchema
  })
  .strict();
export type TaskNode = z.infer<typeof taskNodeSchema>;

/** TaskEdge（:245/:382）：与 `workflowEdgeSchema` 同构，直接复用（零方言）。 */
export const taskEdgeSchema = workflowEdgeSchema;
export type TaskEdge = WorkflowEdge;

/** 计划引用的目标身份 + 内容指纹（:202，防目标漂移）。 */
export const planGoalRefSchema = z
  .object({
    goalId: universalIdSchema,
    goalVersion: z.string().min(1),
    goalFingerprint: z.string().min(1)
  })
  .strict();
export type PlanGoalRef = z.infer<typeof planGoalRefSchema>;

/** 计划状态机（:205）：DRAFT → NEEDS_APPROVAL → APPROVED / REJECTED / BLOCKED / SUPERSEDED。 */
export const planStatusSchema = z.enum([
  "DRAFT",
  "NEEDS_APPROVAL",
  "APPROVED",
  "REJECTED",
  "BLOCKED",
  "SUPERSEDED"
]);
export type PlanStatus = z.infer<typeof planStatusSchema>;

/** 规划器种类（:204）：rules 为确定性档（同输入字节一致）。 */
export const planPlannerKindSchema = z.enum(["rules", "llm", "hybrid"]);
export type PlanPlannerKind = z.infer<typeof planPlannerKindSchema>;

/** 可执行度档位（:214；plugin-roadmap §2.3：A 全可执行 / B 有条件 / C fail-closed）。 */
export const planExecutabilityTierSchema = z.enum(["A", "B", "C"]);
export type PlanExecutabilityTier = z.infer<typeof planExecutabilityTierSchema>;

/** 缺口条目（:216）：缺哪层、缺什么、补什么可解锁。 */
export const planMissingCapabilitySchema = z
  .object({
    reqId: universalIdSchema,
    layer: agentCapabilityLayerSchema,
    capabilityRef: universalIdSchema,
    unlockHint: z.string().min(1)
  })
  .strict();
export type PlanMissingCapability = z.infer<typeof planMissingCapabilitySchema>;

/** 降级条目（:217）：禁止静默降级——每条须带 reason 与 precondition。 */
export const planDegradationSchema = z
  .object({
    taskId: universalIdSchema,
    reqId: universalIdSchema,
    reason: z.string().min(1),
    precondition: z.string().min(1)
  })
  .strict();
export type PlanDegradation = z.infer<typeof planDegradationSchema>;

/** 成本估算（:221）。 */
export const planEstimatedCostSchema = z
  .object({
    unit: agentCostUnitSchema,
    amount: z.number()
  })
  .strict();
export type PlanEstimatedCost = z.infer<typeof planEstimatedCostSchema>;

/**
 * PlanSpec（:200-227）+ 结构性硬约束（:248-256，写入 schema，不靠人记）：
 * 1. `tasks` 非空、`taskId` 唯一（schema + superRefine）；
 * 2. 图无环——复用 shared `validateWorkflowGraph`（Kahn，:2685-2756）；
 * 3. `edges[].from/to/failureRoute` 必须指向存在的 `taskId`（同上）；
 * 4. `approvalPoints` 指向存在 `taskId`，且与 `task.approvalPoint` 一致（同上）；
 * 5. `approvalPoints` 非空 ⇒ `approvalPolicy` 非空（同上，照搬 :2693-2695 语义）；
 * 7. `riskClass` ≥ 所有 task 的 `riskClass` 最大值（superRefine）；
 * 8. 交接字段存在性（基础版，superRefine）：`inputs[].fromTask` 必须存在且
 *    `field` 在该任务 `outputs` 中声明；「上游」拓扑可达性与跨任务继承检查属后续批。
 * 约束 6（capabilityRefs 全部 COVERED / BLOCKED 员工不可引用）＝F5 前半，属后续批。
 */
export const planSpecSchema = z
  .object({
    planId: universalIdSchema,
    planVersion: z.string().min(1),
    schemaVersion: z.string().min(1),
    goalSpecRef: planGoalRefSchema,
    plannerVersion: z.string().min(1),
    plannerKind: planPlannerKindSchema,
    status: planStatusSchema,
    tasks: z.array(taskNodeSchema).min(1),
    edges: z.array(taskEdgeSchema),
    approvalPoints: z.array(universalIdSchema),
    /** G1 不可关闭为执行层语义；结构层照搬 shared 口径（record + 非空检查）。 */
    approvalPolicy: z.record(z.string(), z.unknown()).default({}),
    inventoryFingerprint: z.string().min(1),
    executabilityTier: planExecutabilityTierSchema,
    executabilityReportRef: z.string().min(1),
    missingCapabilities: z.array(planMissingCapabilitySchema),
    degradations: z.array(planDegradationSchema),
    riskClass: agentRiskClassSchema,
    estimatedCost: planEstimatedCostSchema,
    estimatedDurationSec: z.number().int().nonnegative().optional(),
    approvedBy: z.string().min(1).optional(),
    approvedAt: utcTimestampSchema.optional(),
    planFingerprint: z.string().min(1)
  })
  .strict()
  .superRefine((plan, ctx) => {
    // 约束 1：taskId 唯一（图校验亦查 nodeId 唯一，这里给出更直白的字段定位）。
    const taskIds = new Set<string>();
    plan.tasks.forEach((task, index) => {
      if (taskIds.has(task.taskId)) {
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "taskId"],
          message: `重复 taskId: ${task.taskId}`
        });
      }
      taskIds.add(task.taskId);
    });

    // 约束 7：计划风险档取全任务最大值下界。
    const riskRank: Record<AgentRiskClass, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    const maxTaskRiskRank = plan.tasks.reduce(
      (acc, task) => Math.max(acc, riskRank[task.riskClass]),
      0
    );
    if (riskRank[plan.riskClass] < maxTaskRiskRank) {
      ctx.addIssue({
        code: "custom",
        path: ["riskClass"],
        message: `plan.riskClass (${plan.riskClass}) 低于任务最大风险档`
      });
    }

    // 约束 8（基础版）：交接输入必须指向存在的任务，且字段在该任务 outputs 中声明。
    const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
    plan.tasks.forEach((task, taskIndex) => {
      task.inputs.forEach((input, inputIndex) => {
        const source = taskById.get(input.fromTask);
        if (!source) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "inputs", inputIndex, "fromTask"],
            message: `inputs.fromTask 引用不存在的 taskId: ${input.fromTask}`
          });
          return;
        }
        if (!source.outputs.some((output) => output.field === input.field)) {
          ctx.addIssue({
            code: "custom",
            path: ["tasks", taskIndex, "inputs", inputIndex, "field"],
            message: `交接字段 ${input.field} 未在上游 ${source.taskId} outputs 中声明`
          });
        }
      });
    });

    // 约束 2/3/4/5：投影 TaskNode → workflowNodeSchema 允许字段后复用 shared 图校验
    //（纯图校验内核抽取需动 shared，超本批 write scope；投影不改变校验语义）。
    try {
      validateWorkflowGraph({
        nodes: plan.tasks.map((task) => ({
          nodeId: task.taskId,
          kind: task.kind,
          capabilityRefs: task.capabilityRefs,
          riskClass: task.riskClass,
          timeoutMs: task.timeoutMs,
          approvalPoint: task.approvalPoint
        })),
        edges: plan.edges,
        approvalPoints: plan.approvalPoints,
        approvalPolicy: plan.approvalPolicy
      } as unknown as WorkflowDefinition);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["edges"],
        message: error instanceof Error ? error.message : "Invalid TaskDAG"
      });
    }
  });
export type PlanSpec = z.infer<typeof planSpecSchema>;

/**
 * PlanSpec 内容指纹（:226 `planFingerprint` 语义：批准内容的指纹，防批准后被篡改）。
 * 口径同 §6/§8/§9（canonical JSON + sha256），但**排除 `planFingerprint` 字段本身**
 * （防自引用）；校验式：`planSpecFingerprint(plan) === plan.planFingerprint`。
 */
export function planSpecFingerprint(plan: PlanSpec): string {
  const { planFingerprint: _embedded, ...content } = planSpecSchema.parse(plan);
  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}

// ---------------------------------------------------------------------------
// AW-5 片 2 · 结构化交接（handoff）— relay 消费入口（barrel 最小公开面）。
// `duty-decision` 导出裁决维持「暂不导出」（源码内直接引用），二者独立。
// ---------------------------------------------------------------------------

export {
  validateHandoff,
  type HandoffValidationOptions,
  type HandoffValidationResult,
  type HandoffViolation,
  type HandoffViolationKind
} from "./handoff.js";
