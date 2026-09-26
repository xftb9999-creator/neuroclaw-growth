/**
 * I-035 · RG-1 契约层（首批）：agent-workforce role-grid 基础契约。
 *
 * 依据与证据分级：
 * - 方案稿 `.artifacts/i035-role-grid/proposal.md` §二/§三/§四（E2 计划）
 * - GM 裁决（2026-09-27）：4 必填（role / inputContract / outputContract / acceptance）
 *   + 6 过渡默认键位（skills / tools / permissions / memoryScope / kpi / escalation）；
 *   新包先行（零方言）。
 * - 复用资产（E3 实测，2026-09-27）：
 *   `shared/src/index.ts:74-90`（ContractField / Input / Output 契约 schema）
 *   `shared/src/index.ts:342-372`（validateTemplateInputContract）
 *   `templates/src/index.ts:171-181`（formatOutput 输出校验口径）
 *
 * 边界（RG-1）：
 * - 零方言：契约字段与输入校验直接复用 `@neuroclaw/shared`，本包不造第二套结构。
 * - 零接线：`apps/**` 不 import 本包（RG-1 判据④）；本包为纯契约包，无副作用。
 * - 6 过渡字段本批仅冻结键位（可缺省）；深度 schema 与 capabilityRef 绑定归 RG-2/RG-3。
 */
import { z } from "zod";
import {
  templateContractFieldSchema,
  templateInputContractSchema,
  templateOutputContractSchema,
  validateTemplateInputContract,
  type TemplateContractField,
  type TemplateInputContract,
  type TemplateOutputContract,
  type TemplateInputPayload,
  type TemplateOutputPayload
} from "@neuroclaw/shared";

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
// §4 AgentProfile — 4 必填 + 6 过渡默认键位（GM 裁决 2026-09-27）
// ---------------------------------------------------------------------------

export const agentProfileSchema = z
  .object({
    // —— 4 必填：上岗最小集 ——
    role: agentRoleKeySchema,
    inputContract: agentInputContractSchema,
    outputContract: agentOutputContractSchema,
    acceptance: agentAcceptanceSchema,
    // —— 6 过渡默认：本批仅冻结键位（可缺省）；RG-2 收紧 skills/tools/permissions，
    //    RG-3 收紧 memoryScope/kpi/escalation ——
    skills: z.unknown().optional(),
    tools: z.unknown().optional(),
    permissions: z.unknown().optional(),
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
