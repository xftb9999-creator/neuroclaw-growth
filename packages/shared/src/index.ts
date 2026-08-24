import { z } from "zod";

// ---------------------------------------------------------------------------
// Zod schemas — single source of truth for all domain types
// ---------------------------------------------------------------------------

export const workspacePlanSchema = z.enum(["starter", "growth"]);
export type WorkspacePlan = z.infer<typeof workspacePlanSchema>;

export const workspaceSchema = z.object({
  id: z.string(),
  name: z.string(),
  plan: workspacePlanSchema,
  createdAt: z.string()
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const templateTypes = [
  "content_acquisition",
  "private_conversion",
  "weekly_review"
] as const;

export type BuiltinTemplateType = (typeof templateTypes)[number];

/**
 * 智能体类型:内置三员工之外,允许自定义 slug(数据驱动的 AgentDefinition)。
 * 保留字面量联合以获得自动补全,同时接受任意 string。
 */
export type TemplateType = BuiltinTemplateType | (string & {});

export const templateTypeSchema = z.string();

export const templateStatusSchema = z.enum(["active", "inactive"]);
export type TemplateStatus = z.infer<typeof templateStatusSchema>;

export const contractFieldTypeSchema = z.enum(["string", "string[]", "number"]);
export type ContractFieldType = z.infer<typeof contractFieldTypeSchema>;

export const adapterTypeSchema = z.enum(["browser", "mcp", "notification"]);
export type AdapterType = z.infer<typeof adapterTypeSchema>;

export const adapterActionTypeSchema = z.enum([
  "browser_extract",
  "mcp_generate_brief",
  "mcp_generate_conversion_copy",
  "mcp_generate_review",
  "notification_send_preview"
]);
export type AdapterActionType = z.infer<typeof adapterActionTypeSchema>;

export const templateContractFieldSchema = z.object({
  name: z.string(),
  type: contractFieldTypeSchema,
  required: z.boolean(),
  description: z.string()
});
export type TemplateContractField = z.infer<typeof templateContractFieldSchema>;

export const templateInputContractSchema = z.object({
  fields: z.array(templateContractFieldSchema)
});
export type TemplateInputContract = z.infer<typeof templateInputContractSchema>;

export const templateOutputContractSchema = z.object({
  fields: z.array(templateContractFieldSchema)
});
export type TemplateOutputContract = z.infer<typeof templateOutputContractSchema>;

export const templateActionSchema = z.object({
  id: z.string(),
  adapter: adapterTypeSchema,
  actionType: adapterActionTypeSchema,
  description: z.string(),
  critical: z.boolean()
});
export type TemplateAction = z.infer<typeof templateActionSchema>;

export const approvalRuleSchema = z.object({
  actionType: adapterActionTypeSchema,
  reason: z.string()
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const templateSchema = z.object({
  id: z.string(),
  type: z.string(),
  name: z.string(),
  version: z.string(),
  status: templateStatusSchema,
  description: z.string().optional(),
  persona: z.string().optional(),
  baseEngine: z.string().optional(),
  inputContract: templateInputContractSchema,
  outputContract: templateOutputContractSchema,
  requiresApprovalRules: z.array(approvalRuleSchema),
  supportedActions: z.array(templateActionSchema)
});
export type Template = z.infer<typeof templateSchema>;

// ---------------------------------------------------------------------------
// Custom agents — 数据驱动的智能体定义(J2)
// ---------------------------------------------------------------------------

export const agentStatusSchema = z.enum(["active", "inactive"]);

export const createAgentInputSchema = z.object({
  slug: z
    .string()
    .min(2, "slug is required")
    .regex(/^[a-z][a-z0-9_]*$/, "slug must be lowercase snake_case"),
  name: z.string().min(1, "name is required"),
  baseEngine: z.enum(templateTypes),
  persona: z.string().min(4, "persona is required"),
  description: z.string().optional(),
  focusAreas: z.array(z.string()).default([]),
  outputStyle: z.enum(["structured", "checklist", "copy"]).default("structured"),
  toolNames: z.array(z.string()).default([])
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

export const runStatuses = [
  "draft",
  "queued",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled"
] as const;

export const runStatusSchema = z.enum(runStatuses);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runStepStatusSchema = z.enum([
  "pending",
  "in_progress",
  "waiting_approval",
  "completed",
  "failed",
  "skipped",
  "degraded"
]);
export type RunStepStatus = z.infer<typeof runStepStatusSchema>;

export const approvalStatusSchema = z.enum([
  "not_required",
  "pending",
  "approved",
  "rejected"
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const templateInputPayloadSchema = z.record(z.string(), z.unknown());
export type TemplateInputPayload = z.infer<typeof templateInputPayloadSchema>;

export const templateOutputPayloadSchema = z.record(z.string(), z.unknown());
export type TemplateOutputPayload = z.infer<typeof templateOutputPayloadSchema>;

export const runStepResultSchema = z.object({
  stepId: z.string(),
  actionType: adapterActionTypeSchema,
  status: runStepStatusSchema,
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional()
});
export type RunStepResult = z.infer<typeof runStepResultSchema>;

export const runSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  templateType: templateTypeSchema,
  status: runStatusSchema,
  input: templateInputPayloadSchema,
  outputPayload: templateOutputPayloadSchema.optional(),
  failureReason: z.string().optional(),
  currentStep: z.string().nullable(),
  approvalStatus: approvalStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  stepResults: z.array(runStepResultSchema).optional()
});
export type Run = z.infer<typeof runSchema>;

export const policyDecisionTypeSchema = z.enum([
  "allow",
  "deny",
  "require_approval",
  "degrade"
]);
export type PolicyDecisionType = z.infer<typeof policyDecisionTypeSchema>;

export const policyRiskLevelSchema = z.enum(["low", "medium", "high"]);
export type PolicyRiskLevel = z.infer<typeof policyRiskLevelSchema>;

export const policyDecisionSchema = z.object({
  decision: policyDecisionTypeSchema,
  reason: z.string(),
  requiresApproval: z.boolean(),
  riskLevel: policyRiskLevelSchema.optional(),
  appliesToAction: adapterActionTypeSchema.optional()
});
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  reviewerId: z.string(),
  note: z.string().optional()
});
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalRequestSchema = z.object({
  id: z.string(),
  runId: z.string(),
  actionType: adapterActionTypeSchema,
  reason: z.string(),
  status: z.enum(["pending", "approved", "rejected", "expired"]),
  requestedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolution: z.string().optional()
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const runtimeEventSchema = z.object({
  type: z.enum([
    "run_accepted",
    "contract_validated",
    "step_started",
    "policy_evaluated",
    "step_degraded",
    "approval_requested",
    "step_completed",
    "run_completed",
    "run_failed"
  ]),
  runId: z.string(),
  stepId: z.string().optional(),
  details: z.string()
});
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export const adapterActionResultSchema = z.object({
  status: z.enum(["succeeded", "failed", "degraded"]),
  actionType: adapterActionTypeSchema,
  summary: z.string(),
  payload: z.record(z.string(), z.unknown()).optional(),
  degraded: z.boolean().optional()
});
export type AdapterActionResult = z.infer<typeof adapterActionResultSchema>;

// ---------------------------------------------------------------------------
// Runtime validation helpers
// ---------------------------------------------------------------------------

const allowedTransitions: Record<RunStatus, readonly RunStatus[]> = {
  draft: ["queued"],
  queued: ["running", "cancelled"],
  running: ["waiting_approval", "completed", "failed", "cancelled"],
  waiting_approval: ["running", "cancelled"],
  completed: [],
  failed: [],
  cancelled: []
};

export function isTemplateType(value: string): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertTemplateType(value: string): TemplateType {
  if (!isTemplateType(value)) {
    throw new Error(`Unsupported template type: ${value}`);
  }

  return value;
}

export function assertRunInput(input: TemplateInputPayload): TemplateInputPayload {
  if (!input || Object.keys(input).length === 0) {
    throw new Error("Run input requires at least one field");
  }

  return input;
}

export function validateTemplateInputContract(
  input: TemplateInputPayload,
  contract: TemplateInputContract
): void {
  for (const field of contract.fields) {
    const value = input[field.name];

    if (field.required && (value === undefined || value === null || value === "")) {
      throw new Error(`Template input requires ${field.name}`);
    }

    if (value === undefined || value === null) {
      continue;
    }

    if (field.type === "string" && typeof value !== "string") {
      throw new Error(`Template input ${field.name} must be a string`);
    }

    if (
      field.type === "string[]" &&
      (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    ) {
      throw new Error(`Template input ${field.name} must be a string[]`);
    }

    if (field.type === "number" && typeof value !== "number") {
      throw new Error(`Template input ${field.name} must be a number`);
    }
  }
}

export function canTransitionRunStatus(
  from: RunStatus,
  to: RunStatus
): boolean {
  return allowedTransitions[from].includes(to);
}

export function transitionRun(run: Run, nextStatus: RunStatus): Run {
  if (!canTransitionRunStatus(run.status, nextStatus)) {
    throw new Error(`Invalid run transition: ${run.status} -> ${nextStatus}`);
  }

  const now = new Date().toISOString();
  return {
    ...run,
    status: nextStatus,
    updatedAt: now,
    startedAt: nextStatus === "running" && !run.startedAt ? now : run.startedAt,
    completedAt:
      nextStatus === "completed" || nextStatus === "failed" || nextStatus === "cancelled"
        ? now
        : run.completedAt
  };
}

export function appendRunStepResult(
  run: Run,
  stepResult: RunStepResult
): Run {
  return {
    ...run,
    currentStep: stepResult.stepId,
    stepResults: [...(run.stepResults ?? []), stepResult],
    updatedAt: new Date().toISOString()
  };
}

export function applyApprovalDecision(
  run: Run,
  decision: ApprovalDecision
): Run {
  if (run.status !== "waiting_approval") {
    throw new Error("Run is not waiting for approval");
  }

  return {
    ...transitionRun(run, decision.approved ? "running" : "cancelled"),
    approvalStatus: decision.approved ? "approved" : "rejected"
  };
}

// ---------------------------------------------------------------------------
// API request schemas — Zod validation for HTTP endpoints
// ---------------------------------------------------------------------------

export const createWorkspaceInputSchema = z.object({
  name: z.string().min(1, "Workspace name is required"),
  plan: workspacePlanSchema
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceInputSchema>;

export const createRunInputSchema = z.object({
  workspaceId: z.string().min(1, "workspaceId is required"),
  templateType: templateTypeSchema,
  input: templateInputPayloadSchema
});
export type CreateRunInput = z.infer<typeof createRunInputSchema>;

export const updateMemoryInputSchema = z.object({
  summary: z.string().optional(),
  isPinned: z.boolean().optional(),
  isSuppressed: z.boolean().optional()
});
export type UpdateMemoryInput = z.infer<typeof updateMemoryInputSchema>;

// ---------------------------------------------------------------------------
// RBAC roles and permissions
// ---------------------------------------------------------------------------

export const roleSchema = z.enum(["admin", "operator", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

export const rolePermissions: Record<Role, readonly string[]> = {
  admin: [
    "workspace:create",
    "workspace:read",
    "run:create",
    "run:read",
    "approval:decide",
    "memory:read",
    "memory:write",
    "memory:delete",
    "template:read",
    "agent:create"
  ],
  operator: [
    "workspace:read",
    "run:create",
    "run:read",
    "approval:decide",
    "memory:read",
    "memory:write",
    "memory:delete",
    "template:read",
    "agent:create"
  ],
  viewer: [
    "workspace:read",
    "run:read",
    "memory:read",
    "template:read"
  ]
};

export function hasPermission(role: Role, permission: string): boolean {
  return rolePermissions[role].includes(permission);
}
