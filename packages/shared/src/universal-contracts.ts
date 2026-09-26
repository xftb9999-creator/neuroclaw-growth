import { z } from "zod";

import { semverRangeSchema, versionPinMatches } from "./semver-range.js";

export * from "./semver-range.js";

/**
 * Round AC-1 foundation: versioned, project-scoped universal contracts.
 *
 * This module is intentionally pure. It contains no persistence, network,
 * credentials, or external side effects. Existing Growth v1 contracts remain
 * unchanged and can be adapted into these types in a later compatibility
 * layer.
 */

export const universalIdSchema = z.string().min(1);
export type UniversalId = z.infer<typeof universalIdSchema>;

export const utcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/)
  .refine(
    (value) => {
      const parsed = new Date(value);
      const canonical = parsed.toISOString();
      return (
        !Number.isNaN(parsed.getTime()) &&
        (canonical === value || canonical.replace(".000Z", "Z") === value)
      );
    },
    "Timestamp must be a real canonical UTC date"
  );

export const sourceRefsSchema = z
  .array(universalIdSchema)
  .min(1, "sourceRefs requires at least one reference")
  .refine((refs) => new Set(refs).size === refs.length, "sourceRefs must be unique");
export type SourceRefs = z.infer<typeof sourceRefsSchema>;

export const universalScopeSchema = z
  .object({
    organizationId: universalIdSchema.optional(),
    workspaceId: universalIdSchema.optional(),
    projectId: universalIdSchema.optional()
  })
  .strict()
  .refine(
    (scope) => Boolean(scope.organizationId || scope.workspaceId || scope.projectId),
    "Universal scope requires organizationId, workspaceId, or projectId"
  );
export type UniversalScope = z.infer<typeof universalScopeSchema>;

const universalEntityFields = {
  id: universalIdSchema,
  schemaVersion: z.string().min(1),
  scope: universalScopeSchema,
  createdBy: universalIdSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  sourceRefs: sourceRefsSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
};

const projectScopeMatchesObject = (entity: {
  id: UniversalId;
  projectId?: UniversalId;
  scope: UniversalScope;
}): boolean => entity.scope.projectId === (entity.projectId ?? entity.id);

const projectScopeMismatchMessage =
  "Project-scoped objects must match scope.projectId to projectId (or id for Project)";

export const projectStatusSchema = z.enum([
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "ARCHIVED",
  "RETIRED"
]);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectSchema = z
  .object({
    ...universalEntityFields,
    name: z.string().min(1),
    packId: universalIdSchema,
    packVersion: z.string().min(1),
    typeKey: z.string().min(1),
    lifecycleState: z.string().min(1),
    ownerRef: universalIdSchema,
    riskPosture: z.enum(["LOW", "MEDIUM", "HIGH"]),
    status: projectStatusSchema
  })
  .strict()
  .refine(projectScopeMatchesObject, projectScopeMismatchMessage);
export type UniversalProject = z.infer<typeof projectSchema>;

export const objectiveStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "ACTIVE",
  "AT_RISK",
  "PAUSED",
  "ACHIEVED",
  "BLOCKED",
  "CANCELED",
  "RETIRED"
]);
export type ObjectiveStatus = z.infer<typeof objectiveStatusSchema>;

export const keyResultSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  target: z.union([z.string(), z.number()]),
  unit: z.string().min(1),
  metricDefinitionRef: universalIdSchema.optional()
});
export type KeyResult = z.infer<typeof keyResultSchema>;

export const objectiveSchema = z
  .object({
    ...universalEntityFields,
    projectId: universalIdSchema,
    title: z.string().min(1),
    kind: z.string().min(1),
    target: z.union([z.string(), z.number()]),
    unit: z.string().min(1),
    baseline: z.union([z.string(), z.number()]).optional(),
    deadline: utcTimestampSchema,
    keyResults: z.array(keyResultSchema).default([]),
    evidencePolicy: z.record(z.string(), z.unknown()).default({}),
    status: objectiveStatusSchema
  })
  .strict()
  .refine(projectScopeMatchesObject, projectScopeMismatchMessage);
export type UniversalObjective = z.infer<typeof objectiveSchema>;

export const initiativeSchema = z
  .object({
    ...universalEntityFields,
    objectiveId: universalIdSchema,
    title: z.string().min(1),
    hypothesis: z.string().min(1),
    expectedOutcome: z.string().min(1),
    ownerRef: universalIdSchema,
    budgetEnvelope: z.record(z.string(), z.unknown()).default({}),
    status: z.enum(["DRAFT", "READY", "ACTIVE", "PAUSED", "COMPLETED", "CANCELED"])
  })
  .strict();
export type UniversalInitiative = z.infer<typeof initiativeSchema>;

export const workItemStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "INPUT_REQUIRED",
  "DEGRADED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "PAUSED"
]);
export type UniversalWorkItemStatus = z.infer<typeof workItemStatusSchema>;

export const workItemSchema = z
  .object({
    ...universalEntityFields,
    /** Explicit project identity for compatibility wrappers; never inferred from workspace. */
    projectId: universalIdSchema.optional(),
    initiativeId: universalIdSchema,
    kind: z.string().min(1),
    title: z.string().min(1),
    dependencies: z.array(universalIdSchema).default([]),
    workflowRef: universalIdSchema,
    /** AC-2 name for the legacy workflowRef identity. */
    workflowDefinitionId: universalIdSchema.optional(),
    /** Optional on legacy WorkItems; persisted AC-2 bindings should supply it. */
    workflowVersion: z.string().min(1).optional(),
    workflowDefinitionVersion: z.string().min(1).optional(),
    capabilityRefs: z.array(universalIdSchema).default([]),
    assigneeRef: universalIdSchema,
    packRef: universalIdSchema.optional(),
    packVersion: z.string().min(1).optional(),
    adapterRef: universalIdSchema.optional(),
    adapterVersion: z.string().min(1).optional(),
    inputSnapshotRef: universalIdSchema.optional(),
    outputArtifactRefs: z.array(universalIdSchema).default([]),
    outputSnapshotRef: universalIdSchema.optional(),
    legacyRunId: universalIdSchema.optional(),
    approvalStatus: z.enum(["not_required", "pending", "approved", "rejected"]).optional(),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    approvalPolicyRef: universalIdSchema.optional(),
    budgetEnvelope: z.record(z.string(), z.unknown()).default({}),
    status: workItemStatusSchema
  })
  .strict()
  .refine(
    (workItem) => !workItem.projectId || projectScopeMatchesObject(workItem),
    projectScopeMismatchMessage
  )
  .superRefine((workItem, ctx) => {
    if (
      workItem.workflowDefinitionId &&
      workItem.workflowRef &&
      workItem.workflowDefinitionId !== workItem.workflowRef
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionId"],
        message: "workflowDefinitionId must match workflowRef"
      });
    }
    if (
      workItem.workflowDefinitionVersion &&
      workItem.workflowVersion &&
      workItem.workflowDefinitionVersion !== workItem.workflowVersion
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionVersion"],
        message: "workflowDefinitionVersion must match workflowVersion"
      });
    }
  });
export type UniversalWorkItem = z.infer<typeof workItemSchema>;

export const workflowNodeSchema = z
  .object({
    nodeId: universalIdSchema,
    kind: z.string().min(1),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    capabilityRefs: z.array(universalIdSchema).default([]),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    timeoutMs: z.number().int().positive(),
    retryPolicy: z.record(z.string(), z.unknown()).default({}),
    approvalPoint: z.boolean().default(false),
    produces: z.array(z.string().min(1)).default([]),
    consumes: z.array(z.string().min(1)).default([])
  })
  .strict();
export type WorkflowNode = z.infer<typeof workflowNodeSchema>;

export const workflowEdgeSchema = z
  .object({
    from: universalIdSchema,
    to: universalIdSchema,
    condition: z.string().optional(),
    failureRoute: universalIdSchema.optional()
  })
  .strict();
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>;

export const workflowDefinitionSchema = z
  .object({
    ...universalEntityFields,
    packId: universalIdSchema,
    /** Optional explicit Pack version; legacy definitions use version itself. */
    packVersion: z.string().min(1).optional(),
    projectId: universalIdSchema.optional(),
    version: z.string().min(1),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    nodes: z.array(workflowNodeSchema).min(1),
    edges: z.array(workflowEdgeSchema).default([]),
    retryPolicy: z.record(z.string(), z.unknown()).default({}),
    failurePolicy: z.record(z.string(), z.unknown()).default({}),
    approvalPoints: z.array(universalIdSchema).default([]),
    approvalPolicy: z.record(z.string(), z.unknown()).default({}),
    status: z.enum(["DRAFT", "ACTIVE", "RETIRED"]).default("DRAFT")
  })
  .strict()
  .superRefine((workflow, ctx) => {
    try {
      validateWorkflowGraph(workflow);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["edges"],
        message: error instanceof Error ? error.message : "Invalid workflow graph"
      });
    }
    if (workflow.projectId && workflow.scope.projectId !== workflow.projectId) {
      ctx.addIssue({
        code: "custom",
        path: ["projectId"],
        message: "Workflow projectId must match scope.projectId"
      });
    }
    if (workflow.packVersion && !versionPinMatches(workflow.packVersion, workflow.version)) {
      ctx.addIssue({
        code: "custom",
        path: ["packVersion"],
        message: "Workflow packVersion must match the workflow version"
      });
    }
  });
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const universalRunStatusSchema = z.enum([
  "DRAFT",
  "QUEUED",
  "RUNNING",
  "WAITING_APPROVAL",
  "INPUT_REQUIRED",
  "DEGRADED",
  "VERIFYING",
  "COMPLETED",
  "FAILED",
  "CANCELED",
  "PAUSED"
]);
export type UniversalRunStatus = z.infer<typeof universalRunStatusSchema>;

export const universalRunSchema = z
  .object({
    ...universalEntityFields,
    workItemId: universalIdSchema,
    workflowVersion: z.string().min(1),
    /** Optional for legacy payload parsing; execution gates require it. */
    workflowRef: universalIdSchema.optional(),
    workflowDefinitionId: universalIdSchema.optional(),
    workflowDefinitionVersion: z.string().min(1).optional(),
    mode: z.enum(["LIVE", "SIMULATION", "DRY_RUN", "READ_ONLY"]),
    status: universalRunStatusSchema,
    inputSnapshotRef: universalIdSchema,
    policySnapshotRef: universalIdSchema,
    manifestRef: universalIdSchema.optional(),
    manifestVersion: z.string().min(1).optional(),
    policySnapshotVersion: z.string().min(1).optional(),
    approvalRefs: z.array(universalIdSchema).default([]),
    attemptRef: universalIdSchema.optional(),
    attemptNumber: z.number().int().positive().optional(),
    budgetSnapshotRef: universalIdSchema.optional(),
    budgetSnapshotVersion: z.string().min(1).optional(),
    revocationRef: universalIdSchema.optional(),
    /** Optional for legacy non-controlled runs; controlled snapshots must pin it. */
    revocationVersion: z.string().min(1).optional(),
    killSwitchRef: universalIdSchema.optional(),
    /** Optional for legacy non-controlled runs; controlled snapshots must pin it. */
    killSwitchVersion: z.string().min(1).optional(),
    startedAt: utcTimestampSchema.optional(),
    endedAt: utcTimestampSchema.optional()
  })
  .strict()
  .superRefine((run, ctx) => {
    if (
      run.workflowDefinitionId &&
      run.workflowRef &&
      run.workflowDefinitionId !== run.workflowRef
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionId"],
        message: "workflowDefinitionId must match workflowRef"
      });
    }
    if (
      run.workflowDefinitionVersion &&
      run.workflowDefinitionVersion !== run.workflowVersion
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionVersion"],
        message: "workflowDefinitionVersion must match workflowVersion"
      });
    }
  });
export type UniversalRun = z.infer<typeof universalRunSchema>;

// ---------------------------------------------------------------------------
// AC-5 lifecycle and retry boundaries
// ---------------------------------------------------------------------------

const universalAllowedTransitions: Record<string, readonly string[]> = {
  DRAFT: ["READY", "QUEUED", "CANCELED"],
  READY: ["QUEUED", "CANCELED"],
  QUEUED: ["RUNNING", "PAUSED", "CANCELED"],
  RUNNING: [
    "WAITING_APPROVAL",
    "INPUT_REQUIRED",
    "DEGRADED",
    "VERIFYING",
    "COMPLETED",
    "FAILED",
    "PAUSED",
    "CANCELED"
  ],
  WAITING_APPROVAL: ["RUNNING", "PAUSED", "CANCELED"],
  INPUT_REQUIRED: ["RUNNING", "PAUSED", "CANCELED"],
  DEGRADED: ["RUNNING", "FAILED", "PAUSED", "CANCELED"],
  VERIFYING: ["COMPLETED", "FAILED", "PAUSED", "CANCELED"],
  PAUSED: ["QUEUED", "RUNNING", "CANCELED"],
  COMPLETED: [],
  FAILED: ["QUEUED"],
  CANCELED: []
};

export function isUniversalTerminalStatus(
  status: UniversalWorkItemStatus | UniversalRunStatus
): boolean {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELED";
}

export function canTransitionUniversalStatus(
  from: UniversalWorkItemStatus | UniversalRunStatus,
  to: UniversalWorkItemStatus | UniversalRunStatus
): boolean {
  return universalAllowedTransitions[from]?.includes(to) ?? false;
}

export function assertUniversalStatusTransition(
  from: UniversalWorkItemStatus | UniversalRunStatus,
  to: UniversalWorkItemStatus | UniversalRunStatus
): void {
  if (!canTransitionUniversalStatus(from, to)) {
    throw new Error(`Invalid Universal status transition: ${from} -> ${to}`);
  }
}

export function transitionUniversalWorkItem(
  workItem: UniversalWorkItem,
  nextStatus: UniversalWorkItemStatus,
  now = new Date().toISOString()
): UniversalWorkItem {
  const parsed = workItemSchema.parse(workItem);
  assertUniversalStatusTransition(parsed.status, nextStatus);
  return workItemSchema.parse({ ...parsed, status: nextStatus, updatedAt: now });
}

export function transitionUniversalRun(
  run: UniversalRun,
  nextStatus: UniversalRunStatus,
  now = new Date().toISOString()
): UniversalRun {
  const parsed = universalRunSchema.parse(run);
  assertUniversalStatusTransition(parsed.status, nextStatus);
  return universalRunSchema.parse({
    ...parsed,
    status: nextStatus,
    updatedAt: now,
    ...(nextStatus === "RUNNING" && !parsed.startedAt ? { startedAt: now } : {}),
    ...(isUniversalTerminalStatus(nextStatus) ? { endedAt: now } : {}),
    ...(nextStatus === "QUEUED" && parsed.status === "FAILED" ? { endedAt: undefined } : {})
  });
}

export function assertAttemptWithinLimit(attemptNumber: number, maxAttempts: number): void {
  if (!Number.isInteger(attemptNumber) || attemptNumber < 1) {
    throw new Error("Attempt number must be a positive integer");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("maxAttempts must be a positive integer");
  }
  if (attemptNumber > maxAttempts) {
    throw new Error(`Attempt ${attemptNumber} exceeds maxAttempts ${maxAttempts}`);
  }
}

export function assertRetryAllowed(run: UniversalRun, maxAttempts: number): number {
  const parsed = universalRunSchema.parse(run);
  if (parsed.status !== "FAILED") {
    throw new Error(`Only FAILED Universal Runs may be retried; received ${parsed.status}`);
  }
  const nextAttemptNumber = (parsed.attemptNumber ?? 0) + 1;
  assertAttemptWithinLimit(nextAttemptNumber, maxAttempts);
  return nextAttemptNumber;
}

export function retryUniversalRun(
  run: UniversalRun,
  maxAttempts: number,
  now = new Date().toISOString()
): UniversalRun {
  const nextAttemptNumber = assertRetryAllowed(run, maxAttempts);
  return universalRunSchema.parse({
    ...transitionUniversalRun(run, "QUEUED", now),
    attemptNumber: nextAttemptNumber,
    attemptRef: undefined
  });
}

export const evidenceLevelSchema = z.enum(["E0", "E1", "E2", "E3", "E4"]);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

export const evidenceSchema = z
  .object({
    ...universalEntityFields,
    subjectRef: universalIdSchema,
    evidenceLevel: evidenceLevelSchema,
    sourceType: z.string().min(1),
    sourceRef: universalIdSchema,
    observedAt: utcTimestampSchema,
    collectedAt: utcTimestampSchema,
    contentHash: z.string().optional(),
    excerptRef: universalIdSchema.optional(),
    verifierRef: universalIdSchema.optional(),
    status: z.enum(["CURRENT", "SUPERSEDED", "REJECTED"]),
    supersedes: universalIdSchema.optional(),
    retentionPolicy: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type UniversalEvidence = z.infer<typeof evidenceSchema>;

const metricAggregationSchema = z.enum(["COUNT", "SUM", "AVERAGE", "RATE", "PERCENTILE", "CUSTOM"]);

export const metricDefinitionSchema = z
  .object({
    ...universalEntityFields,
    metricKey: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    unit: z.string().min(1),
    aggregation: metricAggregationSchema,
    numerator: z.string().optional(),
    denominator: z.string().optional(),
    timeWindow: z.string().min(1),
    definitionVersion: z.string().min(1),
    sourceEventTypes: z.array(z.string().min(1)).min(1),
    privacyPolicy: z.record(z.string(), z.unknown()).default({}),
    status: z.enum(["DRAFT", "ACTIVE", "RETIRED"])
  })
  .strict()
  .superRefine((definition, ctx) => {
    if (definition.aggregation !== "RATE") return;
    if (!definition.numerator) {
      ctx.addIssue({
        code: "custom",
        path: ["numerator"],
        message: "RATE metric definitions require a non-empty numerator"
      });
    }
    if (!definition.denominator) {
      ctx.addIssue({
        code: "custom",
        path: ["denominator"],
        message: "RATE metric definitions require a non-empty denominator"
      });
    }
  });
export type MetricDefinition = z.infer<typeof metricDefinitionSchema>;

/**
 * A negative sentinel is intentionally outside the normal non-negative
 * metric range. It means "no observation was available" and is never a
 * measured zero or a successful metric value.
 */
export const INSUFFICIENT_DATA_SENTINEL = -1;

export const metricObservationSchema = z
  .object({
    ...universalEntityFields,
    definitionRef: universalIdSchema,
    metricKey: z.string().min(1),
    aggregation: metricAggregationSchema.optional(),
    projectId: universalIdSchema,
    subjectRef: universalIdSchema.optional(),
    value: z.number().finite(),
    unit: z.string().min(1),
    numerator: z.number().finite().nonnegative().optional(),
    denominator: z.number().finite().nonnegative().optional(),
    periodStart: utcTimestampSchema,
    periodEnd: utcTimestampSchema,
    definitionVersion: z.string().min(1),
    sourceEventRefs: z.array(universalIdSchema).min(1),
    evidenceRefs: z.array(universalIdSchema).default([]),
    cohort: z.string().optional(),
    observedAt: utcTimestampSchema,
    confidence: z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH"]),
    status: z.enum(["SIMULATED", "HISTORICAL", "OBSERVED", "INSUFFICIENT_DATA"])
  })
  .strict()
  .refine(projectScopeMatchesObject, projectScopeMismatchMessage)
  .superRefine((observation, ctx) => {
    if (observation.denominator === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["denominator"],
        message: "Metric observation denominator must be greater than zero"
      });
    }
    if (
      observation.status === "INSUFFICIENT_DATA" &&
      observation.value !== INSUFFICIENT_DATA_SENTINEL
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `INSUFFICIENT_DATA must use the sentinel value ${INSUFFICIENT_DATA_SENTINEL}, not an observed metric value`
      });
    }
    if (
      observation.status !== "INSUFFICIENT_DATA" &&
      observation.value === INSUFFICIENT_DATA_SENTINEL
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: `The sentinel value ${INSUFFICIENT_DATA_SENTINEL} is reserved for INSUFFICIENT_DATA`
      });
    }
    if (observation.aggregation === "RATE") {
      if (observation.status === "INSUFFICIENT_DATA") {
        ctx.addIssue({
          code: "custom",
          path: ["status"],
          message:
            "RATE observations must be measured ratios; INSUFFICIENT_DATA must remain unaggregated and use the sentinel value"
        });
      }
      if (observation.numerator === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["numerator"],
          message: "RATE metric observations require a non-negative numerator"
        });
      }
      if (observation.denominator === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["denominator"],
          message: "RATE metric observations require a non-negative denominator"
        });
      }
      if (
        observation.numerator !== undefined &&
        observation.denominator !== undefined &&
        observation.denominator > 0 &&
        observation.value !== observation.numerator / observation.denominator
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "RATE metric observation value must equal numerator divided by denominator"
        });
      }
    }
  });
export type MetricObservation = z.infer<typeof metricObservationSchema>;

export const taskReceiptResultStatusSchema = z.enum([
  "VERIFIED_SUCCESS",
  "SUCCESS_UNVERIFIED",
  "FAILED",
  "DEGRADED",
  "CANCELED",
  "REJECTED"
]);
export type TaskReceiptResultStatus = z.infer<typeof taskReceiptResultStatusSchema>;

export const taskReceiptSchema = z
  .object({
    ...universalEntityFields,
    workItemId: universalIdSchema,
    runId: universalIdSchema,
    actorRef: universalIdSchema,
    capabilityRef: universalIdSchema.optional(),
    workflowVersion: z.string().min(1),
    /** Optional for legacy payload parsing; execution gates require it. */
    workflowRef: universalIdSchema.optional(),
    workflowDefinitionId: universalIdSchema.optional(),
    workflowDefinitionVersion: z.string().min(1).optional(),
    inputSnapshotRef: universalIdSchema,
    manifestRef: universalIdSchema.optional(),
    manifestVersion: z.string().min(1).optional(),
    policySnapshotVersion: z.string().min(1).optional(),
    outputArtifactRefs: z.array(universalIdSchema).default([]),
    outputSnapshotRef: universalIdSchema.optional(),
    evidenceRefs: z.array(universalIdSchema).default([]),
    validationRefs: z.array(universalIdSchema).default([]),
    metricObservationRefs: z.array(universalIdSchema).default([]),
    policySnapshotRef: universalIdSchema,
    approvalRefs: z.array(universalIdSchema).default([]),
    attemptRef: universalIdSchema.optional(),
    attemptNumber: z.number().int().positive().optional(),
    budgetSnapshotRef: universalIdSchema.optional(),
    budgetSnapshotVersion: z.string().min(1).optional(),
    revocationRef: universalIdSchema.optional(),
    /** Optional for legacy non-controlled receipts; controlled snapshots must pin it. */
    revocationVersion: z.string().min(1).optional(),
    killSwitchRef: universalIdSchema.optional(),
    /** Optional for legacy non-controlled receipts; controlled snapshots must pin it. */
    killSwitchVersion: z.string().min(1).optional(),
    costSnapshot: z.record(z.string(), z.unknown()).optional(),
    resultStatus: taskReceiptResultStatusSchema,
    replayRef: universalIdSchema.optional(),
    producedAt: utcTimestampSchema
  })
  .strict()
  .superRefine((receipt, ctx) => {
    if (
      receipt.workflowDefinitionId &&
      receipt.workflowRef &&
      receipt.workflowDefinitionId !== receipt.workflowRef
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionId"],
        message: "workflowDefinitionId must match workflowRef"
      });
    }
    if (
      receipt.workflowDefinitionVersion &&
      receipt.workflowDefinitionVersion !== receipt.workflowVersion
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["workflowDefinitionVersion"],
        message: "workflowDefinitionVersion must match workflowVersion"
      });
    }
    if (receipt.resultStatus === "VERIFIED_SUCCESS") {
      if (receipt.evidenceRefs.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["evidenceRefs"],
          message: "VERIFIED_SUCCESS requires traceable evidenceRefs"
        });
      }
      if (receipt.validationRefs.length === 0) {
        ctx.addIssue({
          code: "custom",
          path: ["validationRefs"],
          message: "VERIFIED_SUCCESS requires traceable validationRefs"
        });
      }
    }
  });
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;

export const receiptValidationSchema = z
  .object({
    ...universalEntityFields,
    receiptRef: universalIdSchema,
    evidenceRefs: z.array(universalIdSchema).min(1),
    validatorRef: universalIdSchema,
    status: z.enum(["PASSED", "FAILED"]),
    validatedAt: utcTimestampSchema
  })
  .strict();
export type ReceiptValidation = z.infer<typeof receiptValidationSchema>;

export interface ReceiptEvidenceChainInput {
  receipt: TaskReceipt;
  validations: readonly ReceiptValidation[];
  evidences: readonly UniversalEvidence[];
}

/**
 * Verifies the object-level links behind a VERIFIED_SUCCESS receipt. String
 * IDs alone are not sufficient: every validation must point back to this
 * receipt, every referenced evidence record must parse, and the validation
 * evidence union must exactly equal the receipt evidence set.
 */
export function assertReceiptEvidenceChain(input: ReceiptEvidenceChainInput): void {
  const receipt = taskReceiptSchema.parse(input.receipt);
  const validations = receiptValidationSchema.array().parse(input.validations);
  const evidences = evidenceSchema.array().parse(input.evidences);

  assertScopeConsistency("Receipt evidence chain", [receipt, ...validations, ...evidences]);

  if (receipt.resultStatus !== "VERIFIED_SUCCESS") return;
  if (receipt.evidenceRefs.length === 0 || receipt.validationRefs.length === 0) {
    throw new Error("VERIFIED_SUCCESS requires evidence and validation references");
  }

  const evidenceById = new Map(evidences.map((evidence) => [evidence.id, evidence]));
  const validationById = new Map(validations.map((validation) => [validation.id, validation]));
  if (evidenceById.size !== evidences.length || validationById.size !== validations.length) {
    throw new Error("Receipt evidence chain records must have unique IDs");
  }
  if (new Set(receipt.evidenceRefs).size !== receipt.evidenceRefs.length) {
    throw new Error("Receipt evidenceRefs must be unique");
  }
  if (new Set(receipt.validationRefs).size !== receipt.validationRefs.length) {
    throw new Error("Receipt validationRefs must be unique");
  }

  const receiptEvidenceIds = new Set(receipt.evidenceRefs);
  const validationEvidenceIds = new Set<string>();
  for (const validationRef of receipt.validationRefs) {
    const validation = validationById.get(validationRef);
    if (!validation || validation.receiptRef !== receipt.id || validation.status !== "PASSED") {
      throw new Error(`Validation ${validationRef} is not a passed validation for receipt ${receipt.id}`);
    }
    for (const evidenceRef of validation.evidenceRefs) {
      const evidence = evidenceById.get(evidenceRef);
      if (!evidence) {
        throw new Error(`Validation ${validation.id} references missing evidence ${evidenceRef}`);
      }
      if (!receiptEvidenceIds.has(evidenceRef)) {
        throw new Error(`Validation ${validation.id} references evidence outside the receipt set`);
      }
      validationEvidenceIds.add(evidenceRef);
    }
  }

  for (const evidenceRef of receipt.evidenceRefs) {
    const evidence = evidenceById.get(evidenceRef);
    if (!evidence) {
      throw new Error(`Receipt references missing evidence ${evidenceRef}`);
    }
  }
  if (
    validationEvidenceIds.size !== receiptEvidenceIds.size ||
    [...validationEvidenceIds].some((evidenceRef) => !receiptEvidenceIds.has(evidenceRef))
  ) {
    throw new Error("Receipt evidenceRefs must match the validation evidence set");
  }
}

export const reviewStatusSchema = z.enum(["PENDING", "APPROVED", "REJECTED", "DEFERRED"]);
export type ReviewStatus = z.infer<typeof reviewStatusSchema>;

export const reviewSchema = z
  .object({
    ...universalEntityFields,
    projectId: universalIdSchema,
    receiptRef: universalIdSchema,
    evidenceRefs: z.array(universalIdSchema).min(1),
    metricObservationRefs: z.array(universalIdSchema).min(1),
    reviewerRef: universalIdSchema,
    approvalRef: universalIdSchema.optional(),
    status: reviewStatusSchema,
    reviewedAt: utcTimestampSchema
  })
  .strict()
  .refine(projectScopeMatchesObject, projectScopeMismatchMessage);
export type UniversalReview = z.infer<typeof reviewSchema>;

export const eventDataClassSchema = z.enum([
  "OPERATIONAL",
  "BEHAVIORAL",
  "FINANCIAL",
  "SENSITIVE"
]);

export const eventEnvelopeSchema = z.object({
  eventId: universalIdSchema,
  schemaVersion: z.string().min(1),
  eventType: z.string().min(1),
  occurredAt: utcTimestampSchema,
  emittedAt: utcTimestampSchema,
  scope: universalScopeSchema,
  actorRef: universalIdSchema,
  subjectRef: universalIdSchema,
  correlationId: universalIdSchema,
  causationId: universalIdSchema.optional(),
  idempotencyKey: universalIdSchema,
  traceId: universalIdSchema,
  dataClass: eventDataClassSchema,
  payload: z.record(z.string(), z.unknown()).default({})
}).strict();
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;

// ---------------------------------------------------------------------------
// AC-1-1 — local Outbox contract
// ---------------------------------------------------------------------------

/**
 * Idempotency scope is the business boundary in which a key is unique.
 * Examples are `workspace:ws_demo` or `project:prj_demo`; it is deliberately
 * separate from EventEnvelope.scope so callers cannot accidentally change
 * tenant/object scope without also choosing a new idempotency namespace.
 */
export const idempotencyScopeSchema = universalIdSchema;
export type IdempotencyScope = z.infer<typeof idempotencyScopeSchema>;

/**
 * Outbox delivery is intentionally small for AC-1-1. FAILED and CANCELED are
 * terminal in this slice; retry scheduling and replay checkpoints remain later
 * work and must not mutate an already terminal event.
 */
export const outboxEventStatusSchema = z.enum([
  "PENDING",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
  "CANCELED"
]);
export type OutboxEventStatus = z.infer<typeof outboxEventStatusSchema>;

/**
 * Extends the existing EventEnvelope semantics without changing the Growth v1
 * EventEnvelope shape. The default status makes enqueue callers explicit about
 * the envelope while keeping the local persistence entry point ergonomic.
 */
export const outboxEventSchema = eventEnvelopeSchema
  .extend({
    idempotencyScope: idempotencyScopeSchema,
    status: outboxEventStatusSchema.default("PENDING")
  })
  .strict();
export type OutboxEvent = z.infer<typeof outboxEventSchema>;
export type OutboxEventInput = z.input<typeof outboxEventSchema>;

const terminalOutboxStatuses = new Set<OutboxEventStatus>([
  "COMPLETED",
  "FAILED",
  "CANCELED"
]);

const allowedOutboxTransitions: Record<OutboxEventStatus, readonly OutboxEventStatus[]> = {
  PENDING: ["PROCESSING", "CANCELED"],
  PROCESSING: ["COMPLETED", "FAILED", "CANCELED"],
  COMPLETED: [],
  FAILED: [],
  CANCELED: []
};

const outboxImmutableFields = [
  "eventId",
  "schemaVersion",
  "eventType",
  "occurredAt",
  "emittedAt",
  "scope",
  "actorRef",
  "subjectRef",
  "correlationId",
  "causationId",
  "idempotencyKey",
  "idempotencyScope",
  "traceId",
  "dataClass",
  "payload"
] as const satisfies readonly (keyof OutboxEvent)[];

function outboxImmutableValue(event: OutboxEvent): string {
  return JSON.stringify(
    Object.fromEntries(outboxImmutableFields.map((field) => [field, event[field]]))
  );
}

/**
 * Enforces append-only identity and terminal-state invariants for persistence
 * transitions. The envelope, payload, and idempotency identity can never be
 * changed by a status update.
 */
export function assertOutboxEventTransition(
  previousInput: OutboxEventInput,
  nextInput: OutboxEventInput
): void {
  const previous = outboxEventSchema.parse(previousInput);
  const next = outboxEventSchema.parse(nextInput);

  if (outboxImmutableValue(previous) !== outboxImmutableValue(next)) {
    throw new Error("Outbox event identity and payload are append-only");
  }
  if (terminalOutboxStatuses.has(previous.status)) {
    throw new Error(`Outbox event status '${previous.status}' is terminal`);
  }
  if (!allowedOutboxTransitions[previous.status].includes(next.status)) {
    throw new Error(
      `Cannot transition outbox event from '${previous.status}' to '${next.status}'`
    );
  }
}

export const validateOutboxEventTransition = assertOutboxEventTransition;

export const policyActionClassSchema = z.enum([
  "READ_ONLY",
  "SIMULATION",
  "CONTROLLED_WRITE"
]);
export type PolicyActionClass = z.infer<typeof policyActionClassSchema>;

export const policyStatusSchema = z.enum(["DRAFT", "ACTIVE", "REVOKED", "RETIRED"]);
export type PolicyStatus = z.infer<typeof policyStatusSchema>;

export const policySchema = z
  .object({
    ...universalEntityFields,
    policyKey: universalIdSchema,
    version: z.string().min(1),
    actionClass: policyActionClassSchema,
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    decision: z.enum(["ALLOW", "DENY", "REQUIRE_APPROVAL", "DEGRADE"]),
    requiresApproval: z.boolean(),
    subjectRef: universalIdSchema.optional(),
    actionRef: universalIdSchema.optional(),
    resourceRef: universalIdSchema.optional(),
    budgetRef: universalIdSchema.optional(),
    revocationRef: universalIdSchema.optional(),
    killSwitchRef: universalIdSchema.optional(),
    status: policyStatusSchema
  })
  .strict()
  .superRefine((policy, ctx) => {
    if (policy.actionClass === "CONTROLLED_WRITE" && !policy.requiresApproval) {
      ctx.addIssue({
        code: "custom",
        path: ["requiresApproval"],
        message: "CONTROLLED_WRITE policies must require approval"
      });
    }
    if (policy.actionClass === "CONTROLLED_WRITE") {
      for (const [field, value] of [
        ["subjectRef", policy.subjectRef],
        ["actionRef", policy.actionRef],
        ["resourceRef", policy.resourceRef]
      ] as const) {
        if (!value) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `CONTROLLED_WRITE policies require ${field}`
          });
        }
      }
    }
  });
export type UniversalPolicy = z.infer<typeof policySchema>;

export const approvalStatusSchema = z.enum([
  "PENDING",
  "APPROVED",
  "REJECTED",
  "EXPIRED",
  "REVOKED"
]);
export type ApprovalStatus = z.infer<typeof approvalStatusSchema>;

export const approvalSchema = z
  .object({
    ...universalEntityFields,
    policyRef: universalIdSchema,
    policyVersion: z.string().min(1).optional(),
    actionClass: policyActionClassSchema,
    subjectRef: universalIdSchema,
    actionRef: universalIdSchema.optional(),
    resourceRef: universalIdSchema.optional(),
    requestedBy: universalIdSchema,
    approverRef: universalIdSchema.optional(),
    status: approvalStatusSchema,
    requestedAt: utcTimestampSchema,
    decidedAt: utcTimestampSchema.optional(),
    decisionNote: z.string().optional()
  })
  .strict()
  .superRefine((approval, ctx) => {
    if (approval.status === "APPROVED" && (!approval.approverRef || !approval.decidedAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "APPROVED approvals require approverRef and decidedAt"
      });
    }
    if (approval.actionClass === "CONTROLLED_WRITE") {
      for (const [field, value] of [
        ["policyVersion", approval.policyVersion],
        ["actionRef", approval.actionRef],
        ["resourceRef", approval.resourceRef]
      ] as const) {
        if (!value) {
          ctx.addIssue({
            code: "custom",
            path: [field],
            message: `CONTROLLED_WRITE approvals require ${field}`
          });
        }
      }
    }
  });
export type UniversalApproval = z.infer<typeof approvalSchema>;

export interface ApprovalBindingInput {
  approval: UniversalApproval;
  scope: UniversalScope;
  policyRef: UniversalId;
  policyVersion: string;
  actionRef: UniversalId;
  resourceRef: UniversalId;
  subjectRef: UniversalId;
  requiredStatus?: ApprovalStatus;
}

/**
 * Checks the complete approval identity before a controlled path may use it.
 * An approval ID alone is intentionally never sufficient authorization.
 */
export function assertApprovalBinding(input: ApprovalBindingInput): void {
  const approval = approvalSchema.parse(input.approval);
  assertScopeConsistency("Approval binding", [
    { id: `${approval.id}:expected`, scope: input.scope },
    approval
  ]);
  if (
    approval.policyRef !== input.policyRef ||
    approval.policyVersion !== input.policyVersion ||
    approval.actionRef !== input.actionRef ||
    approval.resourceRef !== input.resourceRef ||
    approval.subjectRef !== input.subjectRef ||
    approval.status !== (input.requiredStatus ?? "APPROVED")
  ) {
    throw new Error(
      "Approval does not match the required scope, policy/version, action/resource, subject, and status"
    );
  }
}

export const budgetStatusSchema = z.enum(["ACTIVE", "EXHAUSTED", "SUSPENDED", "REVOKED"]);
export type BudgetStatus = z.infer<typeof budgetStatusSchema>;

export const budgetSchema = z
  .object({
    ...universalEntityFields,
    budgetKey: universalIdSchema,
    version: z.string().min(1),
    unit: z.string().min(1),
    limit: z.number().finite().nonnegative(),
    consumed: z.number().finite().nonnegative(),
    subjectRef: universalIdSchema.optional(),
    resourceRef: universalIdSchema.optional(),
    status: budgetStatusSchema
  })
  .strict()
  .refine((budget) => budget.consumed <= budget.limit, "Budget consumed cannot exceed limit");
export type UniversalBudget = z.infer<typeof budgetSchema>;

export const revocationStatusSchema = z.enum(["ACTIVE", "REVOKED"]);
export type RevocationStatus = z.infer<typeof revocationStatusSchema>;

export const revocationSchema = z
  .object({
    ...universalEntityFields,
    /** Resource version; schemaVersion remains the contract format version. */
    version: z.string().min(1).optional(),
    targetRef: universalIdSchema,
    resourceRef: universalIdSchema.optional(),
    reason: z.string().min(1),
    status: revocationStatusSchema,
    effectiveAt: utcTimestampSchema,
    revokedBy: universalIdSchema.optional()
  })
  .strict();
export type UniversalRevocation = z.infer<typeof revocationSchema>;

export const killSwitchStateSchema = z.enum(["ARMED", "TRIGGERED"]);
export type KillSwitchState = z.infer<typeof killSwitchStateSchema>;

export const killSwitchSchema = z
  .object({
    ...universalEntityFields,
    /** Resource version; schemaVersion remains the contract format version. */
    version: z.string().min(1).optional(),
    targetRef: universalIdSchema,
    resourceRef: universalIdSchema.optional(),
    reason: z.string().min(1),
    state: killSwitchStateSchema,
    triggeredAt: utcTimestampSchema.optional(),
    triggeredBy: universalIdSchema.optional()
  })
  .strict()
  .superRefine((killSwitch, ctx) => {
    if (killSwitch.state === "TRIGGERED" && (!killSwitch.triggeredAt || !killSwitch.triggeredBy)) {
      ctx.addIssue({
        code: "custom",
        path: ["state"],
        message: "TRIGGERED kill switches require triggeredAt and triggeredBy"
      });
    }
  });
export type UniversalKillSwitch = z.infer<typeof killSwitchSchema>;

export const adapterStatusSchema = z.enum([
  "DRAFT",
  "CONTRACT_TESTED",
  "SANDBOXED",
  "READ_ONLY_READY",
  "CONTROLLED_WRITE",
  "REVOKED"
]);
export type AdapterStatus = z.infer<typeof adapterStatusSchema>;

export const adapterManifestSchema = z
  .object({
    adapterId: universalIdSchema,
    scope: universalScopeSchema,
    version: z.string().min(1),
    compatibilityRange: semverRangeSchema,
    sourceSystem: z.string().min(1),
    projectRef: universalIdSchema,
    objectMappings: z
      .array(z.object({ sourceType: z.string().min(1), targetType: z.string().min(1) }))
      .min(1),
    eventMappings: z
      .array(z.object({ sourceEvent: z.string().min(1), targetEvent: z.string().min(1) }))
      .min(1),
    readScopes: z.array(z.string()),
    writeScopes: z.array(z.string()),
    inputSchema: z.record(z.string(), z.unknown()).default({}),
    outputSchema: z.record(z.string(), z.unknown()).default({}),
    authRequirements: z.array(z.string()),
    sideEffects: z.array(z.string()),
    simulationOnly: z.boolean().default(false),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]),
    idempotencyStrategy: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    retryPolicy: z.record(z.string(), z.unknown()).default({}),
    rateLimit: z.record(z.string(), z.unknown()).default({}),
    healthCheck: z.string().min(1),
    readinessCheck: z.string().min(1),
    dryRunSupported: z.boolean(),
    rollbackHint: z.string().min(1),
    independentValidationRef: universalIdSchema.optional(),
    evidenceRequirements: z.array(z.string().min(1)).min(1),
    policyRef: universalIdSchema.optional(),
    policyVersion: z.string().min(1).optional(),
    budgetRef: universalIdSchema.optional(),
    budgetVersion: z.string().min(1).optional(),
    approvalRefs: z.array(universalIdSchema).default([]),
    revocationRef: universalIdSchema.optional(),
    revocationVersion: z.string().min(1).optional(),
    killSwitchRef: universalIdSchema.optional(),
    killSwitchVersion: z.string().min(1).optional(),
    controlledWriteBindings: z
      .array(
        z
          .object({ actionRef: universalIdSchema, resourceRef: universalIdSchema })
          .strict()
      )
      .refine(
        (bindings) =>
          new Set(bindings.map((binding) => `${binding.actionRef}\u0000${binding.resourceRef}`)).size ===
          bindings.length,
        "controlledWriteBindings must not contain duplicate action/resource pairs"
      )
      .optional(),
    status: adapterStatusSchema
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.scope.projectId !== manifest.projectRef) {
      ctx.addIssue({
        code: "custom",
        path: ["scope", "projectId"],
        message: "Adapter scope.projectId must match projectRef"
      });
    }
    if (manifest.status !== "CONTROLLED_WRITE") return;
    const requiredRefs: Array<[string, string | undefined]> = [
      ["policyRef", manifest.policyRef],
      ["budgetRef", manifest.budgetRef],
      ["revocationRef", manifest.revocationRef],
      ["killSwitchRef", manifest.killSwitchRef]
    ];
    for (const [field, value] of requiredRefs) {
      if (!value) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `CONTROLLED_WRITE requires ${field}`
        });
      }
    }
    const requiredVersions: Array<[string, string | undefined]> = [
      ["policyVersion", manifest.policyVersion],
      ["budgetVersion", manifest.budgetVersion],
      ["revocationVersion", manifest.revocationVersion],
      ["killSwitchVersion", manifest.killSwitchVersion]
    ];
    for (const [field, value] of requiredVersions) {
      if (!value) {
        ctx.addIssue({
          code: "custom",
          path: [field],
          message: `CONTROLLED_WRITE requires pinned ${field}`
        });
      }
    }
    if ((manifest.controlledWriteBindings ?? []).length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["controlledWriteBindings"],
        message: "CONTROLLED_WRITE requires an action/resource binding"
      });
    }
    if (manifest.approvalRefs.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["approvalRefs"],
        message: "CONTROLLED_WRITE requires approval evidence"
      });
    }
  });
export type AdapterManifest = z.infer<typeof adapterManifestSchema>;

export interface ControlledWriteAuthorizationInput {
  manifest: AdapterManifest;
  /** Required for CONTROLLED_WRITE; optional keeps the legacy call shape type-compatible. */
  actionRef?: UniversalId;
  /** Required for CONTROLLED_WRITE; optional keeps the legacy call shape type-compatible. */
  resourceRef?: UniversalId;
  policy?: UniversalPolicy;
  budget?: UniversalBudget;
  approvals?: readonly UniversalApproval[];
  revocation?: UniversalRevocation;
  killSwitch?: UniversalKillSwitch;
}

/**
 * Pure authorization gate for an adapter that claims CONTROLLED_WRITE.
 * References are not authorization by themselves: the referenced, versioned
 * contracts must be present, active, project-scoped, and mutually consistent.
 */
export function assertControlledWriteAuthorized(
  input: ControlledWriteAuthorizationInput
): void {
  const manifest = adapterManifestSchema.parse(input.manifest);
  if (manifest.status !== "CONTROLLED_WRITE") {
    if (manifest.writeScopes.length > 0) {
      throw new Error("Adapters with write scopes must be CONTROLLED_WRITE");
    }
    return;
  }

  if (!manifest.policyRef || !manifest.budgetRef || !manifest.revocationRef || !manifest.killSwitchRef) {
    throw new Error("CONTROLLED_WRITE requires policy, budget, revocation, and kill-switch references");
  }
  if (manifest.approvalRefs.length === 0) {
    throw new Error("CONTROLLED_WRITE requires approval evidence");
  }
  if (!input.actionRef || !input.resourceRef) {
    throw new Error("CONTROLLED_WRITE requires an actionRef and resourceRef");
  }
  if (
    !(manifest.controlledWriteBindings ?? []).some(
      (binding) => binding.actionRef === input.actionRef && binding.resourceRef === input.resourceRef
    )
  ) {
    throw new Error("CONTROLLED_WRITE action/resource is not declared by the adapter manifest");
  }

  const policy = input.policy ? policySchema.parse(input.policy) : undefined;
  const budget = input.budget ? budgetSchema.parse(input.budget) : undefined;
  const revocation = input.revocation ? revocationSchema.parse(input.revocation) : undefined;
  const killSwitch = input.killSwitch ? killSwitchSchema.parse(input.killSwitch) : undefined;

  if (!policy || policy.id !== manifest.policyRef || policy.status !== "ACTIVE") {
    throw new Error("CONTROLLED_WRITE requires an active referenced policy");
  }
  if (
    policy.actionClass !== "CONTROLLED_WRITE" ||
    !policy.requiresApproval ||
    (policy.decision !== "ALLOW" && policy.decision !== "REQUIRE_APPROVAL")
  ) {
    throw new Error("CONTROLLED_WRITE requires an allow or approval-gated policy");
  }
  if (
    policy.subjectRef !== manifest.adapterId ||
    policy.actionRef !== input.actionRef ||
    policy.resourceRef !== input.resourceRef
  ) {
    throw new Error("CONTROLLED_WRITE policy identity does not match the action/resource subject");
  }
  if (!budget || budget.id !== manifest.budgetRef || budget.status !== "ACTIVE") {
    throw new Error("CONTROLLED_WRITE requires an active referenced budget");
  }
  if (budget.subjectRef !== manifest.adapterId || budget.resourceRef !== input.resourceRef) {
    throw new Error("CONTROLLED_WRITE budget identity does not match the resource subject");
  }
  if (budget.consumed >= budget.limit) {
    throw new Error("CONTROLLED_WRITE is blocked by the budget limit");
  }
  if (!revocation || revocation.id !== manifest.revocationRef) {
    throw new Error("CONTROLLED_WRITE requires a referenced revocation record");
  }
  if (!revocation.version) {
    throw new Error("CONTROLLED_WRITE requires a versioned revocation record");
  }
  if (revocation.status === "ACTIVE") {
    throw new Error("CONTROLLED_WRITE is blocked by revocation");
  }
  if (!killSwitch || killSwitch.id !== manifest.killSwitchRef) {
    throw new Error("CONTROLLED_WRITE requires a referenced kill switch");
  }
  if (!killSwitch.version) {
    throw new Error("CONTROLLED_WRITE requires a versioned kill switch");
  }
  if (killSwitch.state === "TRIGGERED") {
    throw new Error("CONTROLLED_WRITE is blocked by the kill switch");
  }

  if (
    policy.budgetRef !== budget.id ||
    policy.revocationRef !== revocation.id ||
    policy.killSwitchRef !== killSwitch.id
  ) {
    throw new Error("CONTROLLED_WRITE safety references must match the active policy");
  }
  if (
    policy.version !== manifest.policyVersion ||
    budget.version !== manifest.budgetVersion ||
    revocation.version !== manifest.revocationVersion ||
    killSwitch.version !== manifest.killSwitchVersion
  ) {
    throw new Error("CONTROLLED_WRITE safety contracts must match the manifest version pins");
  }

  const approval = input.approvals
    ?.map((candidate) => approvalSchema.parse(candidate))
    .find(
      (candidate) =>
        manifest.approvalRefs.includes(candidate.id) &&
        candidate.scope.projectId === manifest.projectRef &&
        candidate.policyRef === policy.id &&
        candidate.policyVersion === policy.version &&
        candidate.actionClass === policy.actionClass &&
        candidate.subjectRef === manifest.adapterId &&
        candidate.actionRef === input.actionRef &&
        candidate.resourceRef === input.resourceRef
    );
  if (
    !approval ||
    approval.status !== "APPROVED" ||
    approval.scope.projectId !== manifest.projectRef ||
    approval.policyRef !== manifest.policyRef ||
    approval.policyVersion !== policy.version ||
    approval.actionClass !== "CONTROLLED_WRITE" ||
    approval.subjectRef !== manifest.adapterId ||
    approval.actionRef !== input.actionRef ||
    approval.resourceRef !== input.resourceRef
  ) {
    throw new Error("CONTROLLED_WRITE requires an approved matching approval");
  }

  assertApprovalBinding({
    approval,
    scope: manifest.scope,
    policyRef: policy.id,
    policyVersion: policy.version,
    actionRef: input.actionRef,
    resourceRef: input.resourceRef,
    subjectRef: manifest.adapterId
  });

  if (
    revocation.scope.projectId !== manifest.projectRef ||
    revocation.targetRef !== manifest.adapterId ||
    revocation.resourceRef !== input.resourceRef
  ) {
    throw new Error("CONTROLLED_WRITE revocation target does not match the adapter");
  }
  if (
    killSwitch.scope.projectId !== manifest.projectRef ||
    killSwitch.targetRef !== manifest.adapterId ||
    killSwitch.resourceRef !== input.resourceRef
  ) {
    throw new Error("CONTROLLED_WRITE kill switch target does not match the adapter");
  }

  const resources = [policy, budget, approval, revocation, killSwitch];
  try {
    assertScopeConsistency("CONTROLLED_WRITE authorization", [
      { id: manifest.adapterId, scope: manifest.scope },
      ...resources
    ]);
  } catch (error) {
    throw new Error(
      `CONTROLLED_WRITE authorization resources: ${
        error instanceof Error ? error.message : "scope mismatch"
      }`
    );
  }
}

export const validateControlledWriteAuthorization = assertControlledWriteAuthorized;

export interface ContractSnapshotConsistencyInput {
  manifest: AdapterManifest;
  policy?: UniversalPolicy;
  budget?: UniversalBudget;
  approval?: UniversalApproval;
  revocation?: UniversalRevocation;
  killSwitch?: UniversalKillSwitch;
  run?: UniversalRun;
  receipt?: TaskReceipt;
  workflow?: WorkflowDefinition;
}

/**
 * Checks that runtime objects use the exact versions that were authorized.
 * Runtime callers must supply the Workflow snapshot as well as the other
 * snapshots so missing or unrelated workflow identity cannot pass the gate.
 */
export function assertContractSnapshotConsistency(input: ContractSnapshotConsistencyInput): void {
  const manifest = adapterManifestSchema.parse(input.manifest);
  const policy = input.policy ? policySchema.parse(input.policy) : undefined;
  const budget = input.budget ? budgetSchema.parse(input.budget) : undefined;
  const approval = input.approval ? approvalSchema.parse(input.approval) : undefined;
  const revocation = input.revocation ? revocationSchema.parse(input.revocation) : undefined;
  const killSwitch = input.killSwitch ? killSwitchSchema.parse(input.killSwitch) : undefined;
  const run = input.run ? universalRunSchema.parse(input.run) : undefined;
  const receipt = input.receipt ? taskReceiptSchema.parse(input.receipt) : undefined;
  const workflow = input.workflow ? workflowDefinitionSchema.parse(input.workflow) : undefined;

  if ((run || receipt) && !workflow) {
    throw new Error("Contract snapshot requires a Workflow snapshot for runtime validation");
  }

  assertScopeConsistency(
    "Contract snapshot",
    [
      { id: manifest.adapterId, scope: manifest.scope },
      ...(policy ? [policy] : []),
      ...(budget ? [budget] : []),
      ...(approval ? [approval] : []),
      ...(revocation ? [revocation] : []),
      ...(killSwitch ? [killSwitch] : []),
      ...(run ? [run] : []),
      ...(receipt ? [receipt] : []),
      ...(workflow ? [workflow] : [])
    ]
  );

  if (workflow && workflow.scope.projectId !== manifest.projectRef) {
    throw new Error("Workflow snapshot does not match the manifest project");
  }
  if (
    policy &&
    (manifest.policyRef || manifest.policyVersion) &&
    (manifest.policyRef !== policy.id || manifest.policyVersion !== policy.version)
  ) {
    throw new Error("Manifest must pin the exact policy version");
  }
  if (policy && policy.scope.projectId !== manifest.projectRef) {
    throw new Error("Policy snapshot does not match the manifest project");
  }
  if (
    budget &&
    (manifest.budgetRef || manifest.budgetVersion) &&
    (manifest.budgetRef !== budget.id || manifest.budgetVersion !== budget.version)
  ) {
    throw new Error("Manifest must pin the exact budget version");
  }
  if (budget && budget.scope.projectId !== manifest.projectRef) {
    throw new Error("Budget snapshot does not match the manifest project");
  }
  if (approval && policy) {
    if (approval.policyRef !== policy.id || approval.policyVersion !== policy.version) {
      throw new Error("Approval must pin the exact policy version");
    }
    if (policy.actionClass === "CONTROLLED_WRITE") {
      if (
        approval.status !== "APPROVED" ||
        approval.actionClass !== policy.actionClass ||
        approval.subjectRef !== policy.subjectRef ||
        approval.actionRef !== policy.actionRef ||
        approval.resourceRef !== policy.resourceRef
      ) {
        throw new Error("Approval must match the approved controlled action/resource subject");
      }
    }
  }
  if (approval && !policy) {
    throw new Error("Approval snapshot requires its policy snapshot");
  }
  if (approval && approval.scope.projectId !== manifest.projectRef) {
    throw new Error("Approval snapshot does not match the manifest project");
  }
  if (
    revocation &&
    (manifest.revocationRef !== revocation.id || manifest.revocationVersion !== revocation.version)
  ) {
    throw new Error("Manifest must pin the exact revocation resource version");
  }
  if (revocation && revocation.scope.projectId !== manifest.projectRef) {
    throw new Error("Revocation snapshot does not match the manifest project");
  }
  if (
    killSwitch &&
    (manifest.killSwitchRef !== killSwitch.id || manifest.killSwitchVersion !== killSwitch.version)
  ) {
    throw new Error("Manifest must pin the exact kill switch resource version");
  }
  if (killSwitch && killSwitch.scope.projectId !== manifest.projectRef) {
    throw new Error("Kill switch snapshot does not match the manifest project");
  }
  if (manifest.status === "CONTROLLED_WRITE") {
    if (
      !policy ||
      !budget ||
      !approval ||
      !revocation ||
      !killSwitch ||
      !manifest.revocationRef ||
      !manifest.revocationVersion ||
      !manifest.killSwitchRef ||
      !manifest.killSwitchVersion
    ) {
      throw new Error(
        "CONTROLLED_WRITE contract snapshots require policy, budget, approval, revocation, and kill switch versions"
      );
    }

    const binding = manifest.controlledWriteBindings?.[0];
    assertControlledWriteAuthorized({
      manifest,
      actionRef: policy?.actionRef ?? binding?.actionRef,
      resourceRef: policy?.resourceRef ?? binding?.resourceRef,
      policy,
      budget,
      approvals: approval ? [approval] : [],
      revocation,
      killSwitch
    });
  }

  const assertRuntimePins = (
    runtime: UniversalRun | TaskReceipt,
    label: "Run" | "Receipt"
  ): void => {
    if (runtime.manifestRef !== manifest.adapterId || runtime.manifestVersion !== manifest.version) {
      throw new Error(`${label} snapshot does not match the manifest or policy version`);
    }
    if (policy) {
      if (
        runtime.policySnapshotRef !== policy.id ||
        runtime.policySnapshotVersion !== policy.version
      ) {
        throw new Error(`${label} snapshot does not match the manifest or policy version`);
      }
    } else if (runtime.policySnapshotRef || runtime.policySnapshotVersion) {
      throw new Error(`${label} contains an unverified policy snapshot`);
    }
    if (budget) {
      if (
        runtime.budgetSnapshotRef !== budget.id ||
        runtime.budgetSnapshotVersion !== budget.version
      ) {
        throw new Error(`${label} snapshot does not match the budget version`);
      }
    } else if (runtime.budgetSnapshotRef || runtime.budgetSnapshotVersion) {
      throw new Error(`${label} contains an unverified budget snapshot`);
    }
    if (revocation) {
      if (
        runtime.revocationRef !== revocation.id ||
        runtime.revocationVersion !== revocation.version
      ) {
        throw new Error(`${label} snapshot does not match the revocation resource version`);
      }
    } else if (manifest.status === "CONTROLLED_WRITE" && (runtime.revocationRef || runtime.revocationVersion)) {
      throw new Error(`${label} contains an unverified revocation snapshot`);
    }
    if (killSwitch) {
      if (
        runtime.killSwitchRef !== killSwitch.id ||
        runtime.killSwitchVersion !== killSwitch.version
      ) {
        throw new Error(`${label} snapshot does not match the kill switch resource version`);
      }
    } else if (manifest.status === "CONTROLLED_WRITE" && (runtime.killSwitchRef || runtime.killSwitchVersion)) {
      throw new Error(`${label} contains an unverified kill switch snapshot`);
    }
    if (approval && !runtime.approvalRefs.includes(approval.id)) {
      throw new Error(`${label} does not reference the supplied approval snapshot`);
    }
    if (!approval && runtime.approvalRefs.length > 0) {
      throw new Error(`${label} contains unverified approval snapshots`);
    }
    const runtimeWorkflow = workflowBinding(runtime);
    if (
      workflow &&
      (runtimeWorkflow.version === undefined ||
        !versionPinMatches(runtimeWorkflow.version, workflow.version, manifest.compatibilityRange))
    ) {
      throw new Error(`${label} workflow version is not pinned to the workflow definition`);
    }
    if (workflow && runtimeWorkflow.id !== workflow.id) {
      throw new Error(`${label} workflow identity is not pinned to the workflow definition`);
    }
    if (runtime.scope.projectId !== manifest.projectRef) {
      throw new Error(`${label} project scope does not match the manifest project`);
    }
  };

  if (run) assertRuntimePins(run, "Run");
  if (receipt) assertRuntimePins(receipt, "Receipt");
  if (run && receipt) {
    if (
      receipt.runId !== run.id ||
      receipt.inputSnapshotRef !== run.inputSnapshotRef ||
      receipt.policySnapshotRef !== run.policySnapshotRef ||
      receipt.policySnapshotVersion !== run.policySnapshotVersion ||
      receipt.budgetSnapshotRef !== run.budgetSnapshotRef ||
      receipt.budgetSnapshotVersion !== run.budgetSnapshotVersion ||
      receipt.revocationRef !== run.revocationRef ||
      receipt.revocationVersion !== run.revocationVersion ||
      receipt.killSwitchRef !== run.killSwitchRef ||
      receipt.killSwitchVersion !== run.killSwitchVersion ||
      workflowBinding(receipt).version !== workflowBinding(run).version ||
      workflowBinding(receipt).id !== workflowBinding(run).id
    ) {
      throw new Error("Receipt must match the pinned Run snapshot");
    }
  }
}

export const projectPackManifestSchema = z.object({
  packId: universalIdSchema,
  scope: universalScopeSchema,
  projectId: universalIdSchema,
  version: z.string().min(1),
  status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "RETIRED"]).default("ACTIVE"),
  compatibilityRange: semverRangeSchema,
  projectTypeKey: z.string().min(1),
  lifecycleProfile: z.array(z.string().min(1)).min(1),
  objectiveProfiles: z.array(z.string().min(1)).min(1),
  metricDefinitions: z.array(universalIdSchema).min(1),
  workflowDefinitions: z.array(universalIdSchema).min(1),
  workflowRefs: z.array(universalIdSchema).min(1).optional(),
  capabilityRefs: z.array(universalIdSchema),
  adapterRefs: z.array(universalIdSchema).min(1),
  approvalPolicy: z.record(z.string(), z.unknown()).default({}),
  budgetPolicy: z.record(z.string(), z.unknown()).default({}),
  evidenceRules: z.record(z.string(), z.unknown()).default({}),
  frontendModuleRegistry: z.array(universalIdSchema).min(1),
  localizationRefs: z.array(universalIdSchema)
}).strict().refine(
  (pack) => pack.scope.projectId === pack.projectId,
  "Pack scope.projectId must match projectId"
);
export type ProjectPackManifest = z.infer<typeof projectPackManifestSchema>;

export const attemptStatusSchema = z.enum(["RUNNING", "COMPLETED", "FAILED", "CANCELED"]);
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;

export const attemptIdentitySchema = z
  .object({
    ...universalEntityFields,
    runId: universalIdSchema,
    workItemId: universalIdSchema,
    attemptNumber: z.number().int().positive(),
    idempotencyKey: universalIdSchema,
    workflowVersion: z.string().min(1),
    /** Optional for legacy attempt payload parsing; replay gates require it. */
    workflowRef: universalIdSchema.optional(),
    status: attemptStatusSchema,
    startedAt: utcTimestampSchema,
    endedAt: utcTimestampSchema.optional(),
    checkpointRef: universalIdSchema.optional()
  })
  .strict();
export type AttemptIdentity = z.infer<typeof attemptIdentitySchema>;

export const replayCheckpointStatusSchema = z.enum(["WRITABLE", "VERIFIED", "INVALIDATED"]);
export type ReplayCheckpointStatus = z.infer<typeof replayCheckpointStatusSchema>;

export const replayCheckpointSchema = z
  .object({
    ...universalEntityFields,
    runId: universalIdSchema,
    workItemId: universalIdSchema,
    attemptId: universalIdSchema,
    sequence: z.number().int().positive(),
    workflowVersion: z.string().min(1),
    /** Optional for legacy checkpoint parsing; replay gates require it. */
    workflowRef: universalIdSchema.optional(),
    stateHash: z.string().min(1),
    sourceEventRefs: sourceRefsSchema,
    status: replayCheckpointStatusSchema
  })
  .strict();
export type ReplayCheckpoint = z.infer<typeof replayCheckpointSchema>;

export const auditEventSchema = z
  .object({
    ...universalEntityFields,
    runId: universalIdSchema,
    attemptId: universalIdSchema,
    receiptRef: universalIdSchema.optional(),
    sequence: z.number().int().positive(),
    eventType: z.string().min(1),
    actorRef: universalIdSchema,
    subjectRef: universalIdSchema,
    idempotencyKey: universalIdSchema,
    occurredAt: utcTimestampSchema,
    payload: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type AuditEvent = z.infer<typeof auditEventSchema>;

type ScopedContractRecord = {
  id: UniversalId;
  scope: UniversalScope;
};

const scopeDimensions = ["organizationId", "workspaceId", "projectId"] as const;

/**
 * Compares the complete declared tenant identity, including presence. A
 * record that silently drops organization/workspace context is not allowed to
 * join a richer object chain. This is an application-level contract check;
 * it is not a database RLS implementation.
 */
export function assertScopeConsistency(
  label: string,
  records: readonly ScopedContractRecord[]
): void {
  if (records.length < 2) return;
  const reference = records[0].scope;
  for (const record of records.slice(1)) {
    for (const dimension of scopeDimensions) {
      if (record.scope[dimension] !== reference[dimension]) {
        throw new Error(
          `${label} scope mismatch on ${dimension}: ${record.id} is not in the same organization/workspace/project boundary`
        );
      }
    }
  }
}

type WorkflowBindingRecord = {
  workflowRef?: UniversalId;
  workflowDefinitionId?: UniversalId;
  workflowVersion?: string;
  workflowDefinitionVersion?: string;
};

function workflowBinding(record: WorkflowBindingRecord): {
  id: UniversalId | undefined;
  version: string | undefined;
} {
  return {
    id: record.workflowDefinitionId ?? record.workflowRef,
    version: record.workflowDefinitionVersion ?? record.workflowVersion
  };
}

export interface ProjectPackConsistencyInput {
  pack: ProjectPackManifest;
  project?: UniversalProject;
  workflows?: readonly WorkflowDefinition[];
  adapters?: readonly AdapterManifest[];
  workflow?: WorkflowDefinition;
  adapter?: AdapterManifest;
  run?: UniversalRun;
  receipt?: TaskReceipt;
}

export interface AdapterSafetySnapshot {
  policy?: UniversalPolicy;
  budget?: UniversalBudget;
  approvals?: readonly UniversalApproval[];
  revocation?: UniversalRevocation;
  killSwitch?: UniversalKillSwitch;
  actionRef?: UniversalId;
  resourceRef?: UniversalId;
}

/**
 * Resolves Pack -> Project -> Workflow -> Adapter -> Run/Receipt bindings.
 * IDs and versions are checked together so an object from another project or
 * a same-version object from another project cannot be borrowed.
 */
export function assertProjectPackConsistency(input: ProjectPackConsistencyInput): void {
  const pack = projectPackManifestSchema.parse(input.pack);
  const project = input.project ? projectSchema.parse(input.project) : undefined;
  const workflows = [
    ...(input.workflows ?? []),
    ...(input.workflow ? [input.workflow] : [])
  ].map((workflow) => workflowDefinitionSchema.parse(workflow));
  const adapters = [
    ...(input.adapters ?? []),
    ...(input.adapter ? [input.adapter] : [])
  ].map((adapter) => adapterManifestSchema.parse(adapter));
  const run = input.run ? universalRunSchema.parse(input.run) : undefined;
  const receipt = input.receipt ? taskReceiptSchema.parse(input.receipt) : undefined;
  const workflowRefs = pack.workflowRefs ?? pack.workflowDefinitions;

  if (pack.workflowRefs && JSON.stringify(pack.workflowRefs) !== JSON.stringify(pack.workflowDefinitions)) {
    throw new Error("Pack workflowRefs must match workflowDefinitions");
  }
  if (pack.scope.projectId !== pack.projectId) {
    throw new Error("Pack scope does not match the Pack project");
  }
  if (project) {
    if (project.id !== pack.projectId || project.packId !== pack.packId || !versionPinMatches(project.packVersion, pack.version, pack.compatibilityRange)) {
      throw new Error("Project must bind to the exact Pack project and version");
    }
    if (project.scope.projectId !== pack.projectId) {
      throw new Error("Project scope does not match the Pack project");
    }
  }
  for (const workflow of workflows) {
    if (!workflowRefs.includes(workflow.id)) {
      throw new Error(`Workflow ${workflow.id} is not registered by the Pack`);
    }
    if (
      workflow.packId !== pack.packId ||
      !versionPinMatches(workflow.version, pack.version, pack.compatibilityRange) ||
      workflow.scope.projectId !== pack.projectId
    ) {
      throw new Error(`Workflow ${workflow.id} does not match the Pack project/version`);
    }
    for (const node of workflow.nodes) {
      for (const capabilityRef of node.capabilityRefs) {
        if (!pack.capabilityRefs.includes(capabilityRef)) {
          throw new Error(
            `Workflow ${workflow.id} references capability ${capabilityRef} not registered by the Pack`
          );
        }
      }
    }
  }
  for (const adapter of adapters) {
    if (!pack.adapterRefs.includes(adapter.adapterId)) {
      throw new Error(`Adapter ${adapter.adapterId} is not registered by the Pack`);
    }
    if (
      !versionPinMatches(adapter.version, pack.version, pack.compatibilityRange) ||
      adapter.projectRef !== pack.projectId ||
      adapter.scope.projectId !== pack.projectId
    ) {
      throw new Error(`Adapter ${adapter.adapterId} does not match the Pack project/version`);
    }
  }
  const adaptersById = new Map(adapters.map((candidate) => [candidate.adapterId, candidate]));
  const workflowsById = new Map(workflows.map((candidate) => [candidate.id, candidate]));
  const scoped = [
    { id: pack.packId, scope: pack.scope },
    ...(project ? [project] : []),
    ...workflows,
    ...adapters.map((candidate) => ({ id: candidate.adapterId, scope: candidate.scope })),
    ...(run ? [run] : []),
    ...(receipt ? [receipt] : [])
  ];
  assertScopeConsistency("Pack contract", scoped);
  for (const runtime of [run, receipt].filter((value): value is UniversalRun | TaskReceipt => Boolean(value))) {
    if (runtime.scope.projectId !== pack.projectId) {
      throw new Error("Runtime object does not match the Pack project");
    }
    const runtimeWorkflow = workflowBinding(runtime);
    if (!runtimeWorkflow.id) {
      throw new Error("Runtime must bind to a Pack-registered workflow identity");
    }
    if (!workflowRefs.includes(runtimeWorkflow.id)) {
      throw new Error("Runtime workflow identity is not registered by the Pack");
    }
    if (
      runtimeWorkflow.version === undefined ||
      !versionPinMatches(runtimeWorkflow.version, pack.version, pack.compatibilityRange)
    ) {
      throw new Error("Runtime workflow version does not match the Pack workflow version");
    }
    const runtimeWorkflowSnapshot = workflowsById.get(runtimeWorkflow.id);
    if (workflows.length > 0 && !runtimeWorkflowSnapshot) {
      throw new Error("Runtime workflow identity does not match a supplied Pack workflow snapshot");
    }
    if (
      runtimeWorkflowSnapshot &&
      (runtimeWorkflow.version === undefined ||
        !versionPinMatches(runtimeWorkflow.version, runtimeWorkflowSnapshot.version))
    ) {
      throw new Error("Runtime workflow identity/version does not match the Pack workflow snapshot");
    }
    if (!runtime.manifestRef || !runtime.manifestVersion) {
      throw new Error("Runtime must bind to a Pack-registered adapter manifest");
    }
    if (!pack.adapterRefs.includes(runtime.manifestRef)) {
      throw new Error("Runtime adapter manifest is not registered by the Pack");
    }
    if (runtime.manifestVersion !== pack.version) {
      throw new Error("Runtime adapter snapshot version does not match the Pack version");
    }
    const runtimeAdapter = adaptersById.get(runtime.manifestRef);
    if (adapters.length > 0 && !runtimeAdapter) {
      throw new Error("Runtime adapter snapshot does not match a supplied Pack adapter snapshot");
    }
    if (runtimeAdapter && runtime.manifestVersion !== runtimeAdapter.version) {
      throw new Error("Runtime adapter snapshot does not match the Pack adapter snapshot");
    }
  }
  if (run && receipt) {
    if (receipt.runId !== run.id || receipt.workItemId !== run.workItemId) {
      throw new Error("Receipt must bind to the Pack-scoped Run and WorkItem");
    }
    if (
      workflowBinding(receipt).id !== workflowBinding(run).id ||
      workflowBinding(receipt).version !== workflowBinding(run).version ||
      receipt.manifestRef !== run.manifestRef ||
      receipt.manifestVersion !== run.manifestVersion
    ) {
      throw new Error("Receipt must bind to the same Pack workflow and adapter identity as the Run");
    }
  }
}

export const projectPackStatusSchema = z.enum(["DRAFT", "ACTIVE", "PAUSED", "RETIRED"]);
export type ProjectPackStatus = z.infer<typeof projectPackStatusSchema>;

export const registrySnapshotRefSchema = z.object({
  ref: universalIdSchema,
  version: z.string().min(1)
}).strict();
export type RegistrySnapshotRef = z.infer<typeof registrySnapshotRefSchema>;

const registrySecurityFields = {
  policySnapshotRef: universalIdSchema.optional(),
  policySnapshotVersion: z.string().min(1).optional(),
  budgetSnapshotRef: universalIdSchema.optional(),
  budgetSnapshotVersion: z.string().min(1).optional(),
  revocationRef: universalIdSchema.optional(),
  revocationVersion: z.string().min(1).optional(),
  killSwitchRef: universalIdSchema.optional(),
  killSwitchVersion: z.string().min(1).optional(),
  approvalRefs: z.array(universalIdSchema).default([]),
  rollbackPlan: z.string().min(1),
  independentValidationRef: universalIdSchema.optional()
};

export const projectPackRegistryEntrySchema = z
  .object({
    id: universalIdSchema,
    projectId: universalIdSchema,
    packId: universalIdSchema,
    version: z.string().min(1),
    scope: universalScopeSchema,
    status: projectPackStatusSchema,
    manifestSnapshot: projectPackManifestSchema,
    ...registrySecurityFields,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.projectId !== entry.manifestSnapshot.projectId ||
      entry.packId !== entry.manifestSnapshot.packId ||
      !versionPinMatches(entry.version, entry.manifestSnapshot.version, entry.manifestSnapshot.compatibilityRange)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["manifestSnapshot"],
        message: "Pack registry identity/version must match the manifest snapshot"
      });
    }
    if (entry.scope.projectId !== entry.projectId) {
      ctx.addIssue({
        code: "custom",
        path: ["scope", "projectId"],
        message: "Pack registry scope.projectId must match projectId"
      });
    }
    if (entry.manifestSnapshot.status !== entry.status) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Pack registry status must match the manifest snapshot status"
      });
    }
    if (!sameVersionedPair(entry.policySnapshotRef, entry.policySnapshotVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["policySnapshotRef"],
        message: "Pack registry policy snapshot ref and version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.budgetSnapshotRef, entry.budgetSnapshotVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["budgetSnapshotRef"],
        message: "Pack registry budget snapshot ref and version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.revocationRef, entry.revocationVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["revocationRef"],
        message: "Pack registry revocation ref and resource version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.killSwitchRef, entry.killSwitchVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["killSwitchRef"],
        message: "Pack registry kill switch ref and resource version must be supplied together"
      });
    }
  });
export type ProjectPackRegistryEntry = z.infer<typeof projectPackRegistryEntrySchema>;

export const adapterRegistryEntrySchema = z
  .object({
    id: universalIdSchema,
    projectId: universalIdSchema,
    packId: universalIdSchema,
    packVersion: z.string().min(1),
    adapterId: universalIdSchema,
    version: z.string().min(1),
    scope: universalScopeSchema,
    status: adapterStatusSchema,
    manifestSnapshot: adapterManifestSchema,
    ...registrySecurityFields,
    createdAt: utcTimestampSchema,
    updatedAt: utcTimestampSchema
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (
      entry.projectId !== entry.manifestSnapshot.projectRef ||
      entry.adapterId !== entry.manifestSnapshot.adapterId ||
      !versionPinMatches(entry.version, entry.manifestSnapshot.version, entry.manifestSnapshot.compatibilityRange)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["manifestSnapshot"],
        message: "Adapter registry identity/version must match the manifest snapshot"
      });
    }
    if (entry.scope.projectId !== entry.projectId) {
      ctx.addIssue({
        code: "custom",
        path: ["scope", "projectId"],
        message: "Adapter registry scope.projectId must match projectId"
      });
    }
    if (entry.manifestSnapshot.status !== entry.status) {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "Adapter registry status must match the manifest snapshot status"
      });
    }
    if (!sameVersionedPair(entry.policySnapshotRef, entry.policySnapshotVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["policySnapshotRef"],
        message: "Adapter registry policy snapshot ref and version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.budgetSnapshotRef, entry.budgetSnapshotVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["budgetSnapshotRef"],
        message: "Adapter registry budget snapshot ref and version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.revocationRef, entry.revocationVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["revocationRef"],
        message: "Adapter registry revocation ref and resource version must be supplied together"
      });
    }
    if (!sameVersionedPair(entry.killSwitchRef, entry.killSwitchVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["killSwitchRef"],
        message: "Adapter registry kill switch ref and resource version must be supplied together"
      });
    }
  });
export type AdapterRegistryEntry = z.infer<typeof adapterRegistryEntrySchema>;

// Compatibility aliases make the registry vocabulary discoverable to callers
// that use either the ProjectPack or Pack naming convention.
export const packRegistryEntrySchema = projectPackRegistryEntrySchema;
export type PackRegistryEntry = ProjectPackRegistryEntry;

function sameVersionedPair(ref?: string, version?: string): boolean {
  return (ref === undefined) === (version === undefined);
}

const packStatusTransitions: Record<ProjectPackStatus, readonly ProjectPackStatus[]> = {
  DRAFT: ["ACTIVE", "RETIRED"],
  ACTIVE: ["PAUSED", "RETIRED"],
  PAUSED: ["ACTIVE", "RETIRED"],
  RETIRED: []
};

const packWorkflowStatuses: Record<ProjectPackStatus, readonly WorkflowDefinition["status"][]> = {
  DRAFT: ["DRAFT"],
  ACTIVE: ["DRAFT", "ACTIVE"],
  PAUSED: ["DRAFT", "ACTIVE"],
  RETIRED: ["RETIRED"]
};

const packAdapterStatuses: Record<ProjectPackStatus, readonly AdapterStatus[]> = {
  DRAFT: ["DRAFT", "CONTRACT_TESTED"],
  ACTIVE: ["CONTRACT_TESTED", "SANDBOXED", "READ_ONLY_READY", "CONTROLLED_WRITE"],
  PAUSED: ["SANDBOXED", "READ_ONLY_READY", "REVOKED"],
  RETIRED: ["REVOKED"]
};

const adapterStatusTransitions: Record<AdapterStatus, readonly AdapterStatus[]> = {
  DRAFT: ["CONTRACT_TESTED", "REVOKED"],
  CONTRACT_TESTED: ["SANDBOXED", "REVOKED"],
  SANDBOXED: ["READ_ONLY_READY", "REVOKED"],
  READ_ONLY_READY: ["CONTROLLED_WRITE", "REVOKED"],
  CONTROLLED_WRITE: ["REVOKED"],
  REVOKED: []
};

export function assertProjectPackStatusTransition(
  previous: ProjectPackStatus,
  next: ProjectPackStatus
): void {
  if (previous === next) return;
  if (!packStatusTransitions[previous]?.includes(next)) {
    throw new Error(`Cannot transition Project Pack from '${previous}' to '${next}'`);
  }
}

export const assertPackStatusTransition = assertProjectPackStatusTransition;

export function assertAdapterStatusTransition(previous: AdapterStatus, next: AdapterStatus): void {
  if (previous === next) return;
  if (!adapterStatusTransitions[previous]?.includes(next)) {
    throw new Error(`Cannot transition Adapter from '${previous}' to '${next}'`);
  }
}

export interface AdapterRegistryConsistencyInput {
  pack: ProjectPackManifest;
  adapter: AdapterManifest;
  project?: UniversalProject;
  workflows?: readonly WorkflowDefinition[];
  policy?: UniversalPolicy;
  budget?: UniversalBudget;
  approvals?: readonly UniversalApproval[];
  revocation?: UniversalRevocation;
  killSwitch?: UniversalKillSwitch;
  actionRef?: UniversalId;
  resourceRef?: UniversalId;
}

/**
 * Registry-level gate. It is deliberately stricter than parsing a manifest:
 * a registry record must be bound to one Pack/project/version and a write
 * adapter must carry every executable safety snapshot before it can register.
 */
export function assertAdapterRegistryConsistency(input: AdapterRegistryConsistencyInput): void {
  const pack = projectPackManifestSchema.parse(input.pack);
  const adapter = adapterManifestSchema.parse(input.adapter);
  if (pack.status === "RETIRED") {
    throw new Error("Retired Project Packs cannot register executable Adapters");
  }
  assertProjectPackConsistency({
    pack,
    project: input.project,
    workflows: input.workflows,
    adapter
  });

  for (const workflowInput of input.workflows ?? []) {
    const workflow = workflowDefinitionSchema.parse(workflowInput);
    if (!packWorkflowStatuses[pack.status].includes(workflow.status)) {
      throw new Error(
        `Workflow status '${workflow.status}' is incompatible with Project Pack status '${pack.status}'`
      );
    }
  }

  if (!packAdapterStatuses[pack.status].includes(adapter.status)) {
    throw new Error(
      `Adapter status '${adapter.status}' is incompatible with Project Pack status '${pack.status}'`
    );
  }

  if (adapter.simulationOnly) {
    if (
      adapter.status !== "SANDBOXED" ||
      adapter.writeScopes.length !== 0 ||
      adapter.sideEffects.length !== 1 ||
      adapter.sideEffects[0] !== "none" ||
      !adapter.dryRunSupported
    ) {
      throw new Error("simulationOnly adapters must be SANDBOXED, dry-run capable, side-effect free, and write-scoped empty");
    }
  }

  if (adapter.status === "CONTROLLED_WRITE" || adapter.writeScopes.length > 0) {
    if (!adapter.rollbackHint.trim() || !adapter.independentValidationRef) {
      throw new Error("CONTROLLED_WRITE registration requires rollback and independent validation evidence");
    }
    assertControlledWriteAuthorized({
      manifest: adapter,
      actionRef: input.actionRef,
      resourceRef: input.resourceRef,
      policy: input.policy,
      budget: input.budget,
      approvals: input.approvals,
      revocation: input.revocation,
      killSwitch: input.killSwitch
    });
  }
}

export interface ProjectPackRegistryConsistencyInput {
  pack: ProjectPackManifest;
  project?: UniversalProject;
  workflows?: readonly WorkflowDefinition[];
  adapters?: readonly AdapterManifest[];
  adapterSafety?: Readonly<Record<string, AdapterSafetySnapshot>>;
}

export function assertProjectPackRegistryConsistency(
  input: ProjectPackRegistryConsistencyInput
): void {
  const pack = projectPackManifestSchema.parse(input.pack);
  const workflows = (input.workflows ?? []).map((workflow) => workflowDefinitionSchema.parse(workflow));
  const adapters = (input.adapters ?? []).map((adapter) => adapterManifestSchema.parse(adapter));
  assertProjectPackConsistency({
    pack,
    project: input.project,
    workflows,
    adapters
  });
  if (new Set(pack.adapterRefs).size !== pack.adapterRefs.length) {
    throw new Error("Pack adapterRefs must be unique");
  }
  if (new Set((pack.workflowRefs ?? pack.workflowDefinitions)).size !== (pack.workflowRefs ?? pack.workflowDefinitions).length) {
    throw new Error("Pack workflow references must be unique");
  }
  for (const workflow of workflows) {
    if (!packWorkflowStatuses[pack.status].includes(workflow.status)) {
      throw new Error(
        `Workflow status '${workflow.status}' is incompatible with Project Pack status '${pack.status}'`
      );
    }
  }
  for (const adapter of adapters) {
    assertAdapterRegistryConsistency({
      pack,
      adapter,
      project: input.project,
      workflows,
      ...(input.adapterSafety?.[adapter.adapterId] ?? {})
    });
  }
}

export interface MetricDefinitionRegistryConsistencyInput {
  definitions: readonly MetricDefinition[];
  observations: readonly MetricObservation[];
  pack?: ProjectPackManifest;
}

/** Ensures every observation resolves to a registered, same-version metric definition. */
export function assertMetricDefinitionRegistryConsistency(
  input: MetricDefinitionRegistryConsistencyInput
): void {
  const definitions = metricDefinitionSchema.array().parse(input.definitions);
  const observations = metricObservationSchema.array().parse(input.observations);
  const pack = input.pack ? projectPackManifestSchema.parse(input.pack) : undefined;
  const definitionById = new Map(definitions.map((definition) => [definition.id, definition]));
  if (definitionById.size !== definitions.length) {
    throw new Error("Metric definition registry IDs must be unique");
  }
  if (new Set(definitions.map((definition) => `${definition.metricKey}\u0000${definition.definitionVersion}`)).size !== definitions.length) {
    throw new Error("Metric definition registry versions must be unique per metric key");
  }
  assertScopeConsistency("Metric definition registry", [...definitions, ...observations]);
  for (const definition of definitions) {
    if (pack && (!pack.metricDefinitions.includes(definition.id) || definition.scope.projectId !== pack.projectId)) {
      throw new Error(`Metric definition ${definition.id} is not registered by the Pack project`);
    }
  }
  for (const observation of observations) {
    const definition = definitionById.get(observation.definitionRef);
    if (!definition) {
      throw new Error(`Metric observation ${observation.id} references missing definition ${observation.definitionRef}`);
    }
    if (
      observation.metricKey !== definition.metricKey ||
      observation.definitionVersion !== definition.definitionVersion ||
      observation.projectId !== definition.scope.projectId
    ) {
      throw new Error(`Metric observation ${observation.id} does not match its metric definition version/project`);
    }
    if (
      observation.status === "INSUFFICIENT_DATA" &&
      observation.aggregation !== undefined
    ) {
      throw new Error(
        `INSUFFICIENT_DATA observation ${observation.id} must remain unaggregated`
      );
    }
    if (
      observation.status !== "INSUFFICIENT_DATA" &&
      observation.aggregation !== definition.aggregation
    ) {
      throw new Error(
        `Metric observation ${observation.id} does not match its metric definition aggregation`
      );
    }
    if (definition.aggregation === "RATE" && observation.status !== "INSUFFICIENT_DATA") {
      if (!definition.numerator || !definition.denominator) {
        throw new Error(
          `RATE metric definition ${definition.id} must declare numerator and denominator`
        );
      }
      if (observation.numerator === undefined || observation.denominator === undefined) {
        throw new Error(
          `RATE metric observation ${observation.id} must close the numerator/denominator contract`
        );
      }
    }
    if (pack && observation.projectId !== pack.projectId) {
      throw new Error(`Metric observation ${observation.id} does not match the Pack project`);
    }
  }
}

export const assertMetricRegistryConsistency = assertMetricDefinitionRegistryConsistency;

export interface ExecutionIdentityConsistencyInput {
  workItem: UniversalWorkItem;
  run: UniversalRun;
  receipt: TaskReceipt;
  workflow?: WorkflowDefinition;
  evidences: readonly UniversalEvidence[];
  validations: readonly ReceiptValidation[];
  observations: readonly MetricObservation[];
  reviews: readonly UniversalReview[];
  approvals?: readonly UniversalApproval[];
}

/** Verifies the object-level identity graph behind one execution result. */
export function assertExecutionIdentityConsistency(input: ExecutionIdentityConsistencyInput): void {
  const workItem = workItemSchema.parse(input.workItem);
  const run = universalRunSchema.parse(input.run);
  const receipt = taskReceiptSchema.parse(input.receipt);
  const workflow = input.workflow ? workflowDefinitionSchema.parse(input.workflow) : undefined;
  const evidences = evidenceSchema.array().parse(input.evidences);
  const validations = receiptValidationSchema.array().parse(input.validations);
  const observations = metricObservationSchema.array().parse(input.observations);
  const reviews = reviewSchema.array().parse(input.reviews);
  const approvals = approvalSchema.array().parse(input.approvals ?? []);
  if (!workflow) {
    throw new Error("Execution identity chain requires a Workflow snapshot");
  }
  assertScopeConsistency("Execution identity chain", [
    workItem,
    run,
    receipt,
    workflow,
    ...evidences,
    ...validations,
    ...observations,
    ...reviews,
    ...approvals
  ]);
  if (run.workItemId !== workItem.id || receipt.workItemId !== workItem.id || receipt.runId !== run.id) {
    throw new Error("WorkItem, Run, and Receipt must form one identity chain");
  }
  const workItemWorkflow = workflowBinding(workItem);
  const runWorkflow = workflowBinding(run);
  const receiptWorkflow = workflowBinding(receipt);
  // AC-1 WorkItems only carried the workflow identity. Treat the definition
  // version as the supplied snapshot version for that legacy shape.
  const workItemWorkflowVersion = workItemWorkflow.version ?? workflow.version;
  if (
    !runWorkflow.id ||
    !receiptWorkflow.id ||
    runWorkflow.version === undefined ||
    receiptWorkflow.version === undefined ||
    workItemWorkflow.id !== workflow.id ||
    workItemWorkflowVersion !== workflow.version ||
    runWorkflow.id !== workflow.id ||
    receiptWorkflow.id !== workflow.id ||
    !versionPinMatches(runWorkflow.version, workflow.version) ||
    !versionPinMatches(receiptWorkflow.version, workflow.version) ||
    runWorkflow.id !== workItemWorkflow.id ||
    receiptWorkflow.id !== workItemWorkflow.id ||
    !versionPinMatches(receiptWorkflow.version, runWorkflow.version)
  ) {
    throw new Error("WorkItem, Run, and Receipt must bind to one workflow identity/version");
  }
  const runApprovalRefs = new Set(run.approvalRefs);
  const receiptApprovalRefs = new Set(receipt.approvalRefs);
  if (
    runApprovalRefs.size !== run.approvalRefs.length ||
    receiptApprovalRefs.size !== receipt.approvalRefs.length ||
    runApprovalRefs.size !== receiptApprovalRefs.size ||
    [...runApprovalRefs].some((approvalRef) => !receiptApprovalRefs.has(approvalRef))
  ) {
    throw new Error("Run and Receipt must reference the same Approval identities");
  }
  const approvalById = new Map(approvals.map((approval) => [approval.id, approval]));
  if (approvalById.size !== approvals.length) {
    throw new Error("Execution Approval IDs must be unique");
  }
  for (const approvalRef of runApprovalRefs) {
    const approval = approvalById.get(approvalRef);
    if (!approval) {
      throw new Error(`Execution references missing Approval ${approvalRef}`);
    }
    if (approval.status !== "APPROVED") {
      throw new Error(`Execution Approval ${approval.id} must be APPROVED`);
    }
  }
  if (observations.some((observation) => observation.projectId !== workItem.scope.projectId)) {
    throw new Error("Metric observations must match the execution project");
  }
  const evidenceIds = new Set(evidences.map((evidence) => evidence.id));
  const observationIds = new Set(observations.map((observation) => observation.id));
  const validationById = new Map(validations.map((validation) => [validation.id, validation]));
  if (evidenceIds.size !== evidences.length || validationById.size !== validations.length) {
    throw new Error("Execution evidence and validation IDs must be unique");
  }
  for (const evidenceRef of receipt.evidenceRefs) {
    if (!evidenceIds.has(evidenceRef)) {
      throw new Error(`Receipt references missing execution evidence ${evidenceRef}`);
    }
  }
  const receiptEvidenceIds = new Set(receipt.evidenceRefs);
  for (const validationRef of receipt.validationRefs) {
    const validation = validationById.get(validationRef);
    if (!validation || validation.receiptRef !== receipt.id) {
      throw new Error(`Receipt references a missing validation ${validationRef}`);
    }
    if (validation.status !== "PASSED") {
      throw new Error(`Receipt validation ${validation.id} must be PASSED`);
    }
    if (
      validation.evidenceRefs.some(
        (evidenceRef) => !evidenceIds.has(evidenceRef) || !receiptEvidenceIds.has(evidenceRef)
      )
    ) {
      throw new Error(`Receipt validation ${validation.id} references evidence outside the Receipt set`);
    }
  }
  for (const validation of validations) {
    if (validation.receiptRef !== receipt.id) {
      throw new Error(`Validation ${validation.id} does not belong to the Receipt`);
    }
    if (validation.evidenceRefs.some((evidenceRef) => !evidenceIds.has(evidenceRef))) {
      throw new Error(`Validation ${validation.id} references missing execution evidence`);
    }
  }
  for (const review of reviews) {
    if (review.receiptRef !== receipt.id || review.projectId !== workItem.scope.projectId) {
      throw new Error(`Review ${review.id} does not belong to the execution chain`);
    }
    if (review.approvalRef && !approvals.some((approval) => approval.id === review.approvalRef)) {
      throw new Error(`Review ${review.id} references a missing Approval`);
    }
    if (review.evidenceRefs.some((evidenceRef) => !evidenceIds.has(evidenceRef))) {
      throw new Error(`Review ${review.id} references missing execution evidence`);
    }
    if (review.metricObservationRefs.some((observationRef) => !observationIds.has(observationRef))) {
      throw new Error(`Review ${review.id} references missing metric observation`);
    }
  }
}

export const validateExecutionIdentityConsistency = assertExecutionIdentityConsistency;

export interface AuditReplayConsistencyInput {
  run: UniversalRun;
  receipt: TaskReceipt;
  attempts: readonly AttemptIdentity[];
  checkpoints: readonly ReplayCheckpoint[];
  auditEvents: readonly AuditEvent[];
}

/**
 * Validates the minimum in-memory audit/replay chain. It deliberately does
 * not persist an outbox or execute a replay service.
 */
export function assertAuditReplayConsistency(input: AuditReplayConsistencyInput): void {
  const run = universalRunSchema.parse(input.run);
  const receipt = taskReceiptSchema.parse(input.receipt);
  const attempts = attemptIdentitySchema.array().parse(input.attempts);
  const checkpoints = replayCheckpointSchema.array().parse(input.checkpoints);
  const auditEvents = auditEventSchema.array().parse(input.auditEvents);
  assertScopeConsistency("Audit/replay chain", [run, receipt, ...attempts, ...checkpoints, ...auditEvents]);
  if (receipt.runId !== run.id || receipt.workItemId !== run.workItemId) {
    throw new Error("Audit/replay receipt must bind to the Run and WorkItem");
  }
  if (attempts.length === 0 || checkpoints.length === 0 || auditEvents.length === 0) {
    throw new Error("Audit/replay chain requires an attempt, checkpoint, and audit event");
  }
  if (!run.attemptRef || !receipt.attemptRef) {
    throw new Error("Run and Receipt must reference an Attempt identity");
  }
  if (run.attemptRef !== receipt.attemptRef) {
    throw new Error("Run and Receipt must reference the same Attempt identity");
  }
  if (!run.workflowRef || !receipt.workflowRef || run.workflowRef !== receipt.workflowRef) {
    throw new Error("Run and Receipt must reference the same Workflow identity");
  }
  const attemptById = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
  const auditIds = new Set<string>();
  const auditSequences = new Set<number>();
  const auditIdempotencyKeys = new Set<string>();
  const attemptIdempotencyKeys = new Set<string>();
  const attemptNumbers = new Set<number>();
  if (attemptById.size !== attempts.length || checkpointById.size !== checkpoints.length) {
    throw new Error("Audit/replay attempt and checkpoint IDs must be unique");
  }
  for (const attempt of attempts) {
    if (
      attemptIdempotencyKeys.has(attempt.idempotencyKey) ||
      attemptNumbers.has(attempt.attemptNumber)
    ) {
      throw new Error("Audit/replay attempts must resolve to one same Attempt identity");
    }
    attemptIdempotencyKeys.add(attempt.idempotencyKey);
    attemptNumbers.add(attempt.attemptNumber);
  }
  const runAttempt = attemptById.get(run.attemptRef);
  if (!runAttempt || receipt.attemptRef !== runAttempt.id) {
    throw new Error("Run and Receipt attemptRef must resolve to the same Attempt identity");
  }
  for (const attempt of attempts) {
    if (
      attempt.runId !== run.id ||
      attempt.workItemId !== run.workItemId ||
      attempt.workflowVersion !== run.workflowVersion ||
      attempt.workflowRef !== run.workflowRef ||
      (run.attemptNumber !== undefined && attempt.attemptNumber !== run.attemptNumber) ||
      (receipt.attemptNumber !== undefined && attempt.attemptNumber !== receipt.attemptNumber)
    ) {
      throw new Error(`Attempt ${attempt.id} does not bind to the Run identity/version`);
    }
    if (attempt.checkpointRef && !checkpointById.has(attempt.checkpointRef)) {
      throw new Error(`Attempt ${attempt.id} checkpointRef must resolve to a provided checkpoint`);
    }
  }
  for (const checkpoint of checkpoints) {
    if (
      checkpoint.runId !== run.id ||
      checkpoint.workItemId !== run.workItemId ||
      !attemptById.has(checkpoint.attemptId) ||
      checkpoint.attemptId !== runAttempt.id ||
      checkpoint.workflowVersion !== run.workflowVersion ||
      checkpoint.workflowRef !== run.workflowRef ||
      checkpoint.status !== "VERIFIED"
    ) {
      throw new Error(`Replay checkpoint ${checkpoint.id} does not bind to the Run/Attempt`);
    }
  }
  if (!receipt.replayRef || !checkpointById.has(receipt.replayRef)) {
    throw new Error("Receipt must reference an existing replay checkpoint");
  }
  const replayCheckpoint = checkpointById.get(receipt.replayRef);
  if (!replayCheckpoint || replayCheckpoint.attemptId !== runAttempt.id) {
    throw new Error("Receipt replay checkpoint must reference the same Attempt identity as the Run");
  }
  if (!runAttempt.checkpointRef || runAttempt.checkpointRef !== receipt.replayRef) {
    throw new Error("Replay ref must resolve through the same Attempt checkpointRef");
  }
  if (run.attemptRef && !attemptById.has(run.attemptRef)) {
    throw new Error("Run attemptRef must resolve to an Attempt identity");
  }
  if (receipt.attemptRef && !attemptById.has(receipt.attemptRef)) {
    throw new Error("Receipt attemptRef must resolve to an Attempt identity");
  }
  if (receipt.attemptRef && run.attemptRef && receipt.attemptRef !== run.attemptRef) {
    throw new Error("Run and Receipt must reference the same Attempt identity");
  }
  for (const auditEvent of auditEvents) {
    if (
      auditIds.has(auditEvent.id) ||
      auditSequences.has(auditEvent.sequence) ||
      auditIdempotencyKeys.has(auditEvent.idempotencyKey)
    ) {
      throw new Error("Audit event IDs, sequence numbers, and idempotency keys must be unique");
    }
    auditIds.add(auditEvent.id);
    auditSequences.add(auditEvent.sequence);
    auditIdempotencyKeys.add(auditEvent.idempotencyKey);
    if (
      auditEvent.runId !== run.id ||
      auditEvent.attemptId !== runAttempt.id ||
      auditEvent.receiptRef !== receipt.id
    ) {
      throw new Error(`Audit event ${auditEvent.id} does not bind to the Run/Attempt/Receipt`);
    }
  }
}

export const validateAuditReplayConsistency = assertAuditReplayConsistency;

export function validateWorkflowGraph(workflow: WorkflowDefinition): void {
  // Re-parse here as well as at workflowDefinitionSchema's entry point so a
  // direct helper call cannot bypass strict node/edge object boundaries.
  const nodes = workflowNodeSchema.array().parse(workflow.nodes);
  const edges = workflowEdgeSchema.array().parse(workflow.edges);
  const nodeIds = new Set(nodes.map((node) => node.nodeId));
  if (nodeIds.size !== nodes.length) {
    throw new Error("Workflow node IDs must be unique");
  }
  if (new Set(workflow.approvalPoints).size !== workflow.approvalPoints.length) {
    throw new Error("Workflow approval points must be unique");
  }
  for (const approvalPoint of workflow.approvalPoints) {
    if (!nodeIds.has(approvalPoint)) {
      throw new Error(`Workflow approval point references an unknown node: ${approvalPoint}`);
    }
  }
  const declaredApprovalPoints = new Set(workflow.approvalPoints);
  for (const node of nodes) {
    if (node.approvalPoint !== declaredApprovalPoints.has(node.nodeId)) {
      throw new Error(
        `Workflow approval point declaration must match node approvalPoint: ${node.nodeId}`
      );
    }
  }
  if (workflow.approvalPoints.length > 0 && Object.keys(workflow.approvalPolicy).length === 0) {
    throw new Error("Workflow approval points require an approval policy");
  }

  const adjacency = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const nodeId of nodeIds) {
    adjacency.set(nodeId, []);
    indegree.set(nodeId, 0);
  }

  const edgeKeys = new Set<string>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      throw new Error(`Workflow edge references an unknown node: ${edge.from} -> ${edge.to}`);
    }
    if (edge.failureRoute && !nodeIds.has(edge.failureRoute)) {
      throw new Error(`Workflow failure route references an unknown node: ${edge.failureRoute}`);
    }
    const edgeKey = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(edgeKey)) {
      throw new Error(`Workflow edges must not contain duplicate edges: ${edge.from} -> ${edge.to}`);
    }
    edgeKeys.add(edgeKey);
    adjacency.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...indegree.entries()]
    .filter(([, degree]) => degree === 0)
    .map(([nodeId]) => nodeId);
  let visited = 0;
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (!nodeId) continue;
    visited += 1;
    for (const nextId of adjacency.get(nodeId) ?? []) {
      const nextDegree = (indegree.get(nextId) ?? 0) - 1;
      indegree.set(nextId, nextDegree);
      if (nextDegree === 0) queue.push(nextId);
    }
  }

  if (visited !== workflow.nodes.length) {
    throw new Error("Workflow graph must be acyclic in the AC-1 foundation");
  }
}

export function validateEventChain(events: readonly EventEnvelope[]): EventEnvelope[] {
  if (events.length === 0) {
    throw new Error("Event chain requires at least one event");
  }

  const parsed = eventEnvelopeSchema.array().parse(events);
  const eventIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  const first = parsed[0];

  for (const [index, event] of parsed.entries()) {
    if (eventIds.has(event.eventId)) {
      throw new Error(`Duplicate event ID: ${event.eventId}`);
    }
    if (idempotencyKeys.has(event.idempotencyKey)) {
      throw new Error(`Duplicate idempotency key: ${event.idempotencyKey}`);
    }
    eventIds.add(event.eventId);
    idempotencyKeys.add(event.idempotencyKey);

    if (event.correlationId !== first.correlationId) {
      throw new Error("Event chain must keep one correlation ID");
    }
    if (JSON.stringify(event.scope) !== JSON.stringify(first.scope)) {
      throw new Error("Event chain must keep one scope");
    }

    if (index === 0 && event.causationId) {
      throw new Error("The first event cannot have a causation ID");
    }
    if (index > 0 && event.causationId !== parsed[index - 1].eventId) {
      throw new Error("Each event must causally reference its previous event");
    }
  }

  return parsed;
}

/** Maps the current Growth v1 spelling at the compatibility boundary. */
export function normalizeLegacyRunStatus(status: string): UniversalRunStatus | string {
  return status === "cancelled" || status === "CANCELLED" ? "CANCELED" : status;
}

// ---------------------------------------------------------------------------
// Growth v1 -> Universal WorkItem compatibility boundary (AC-4-0)
// ---------------------------------------------------------------------------

export interface GrowthRunCompatibility {
  templateType: "content_acquisition" | "private_conversion" | "weekly_review";
  templateVersion: "2.0.0";
  packId: "pack_growth_v1";
  packVersion: "1.0.0";
  workflowId: string;
  workflowVersion: "1.0.0";
  adapterId: string;
  adapterVersion: "1.0.0";
  simulationOnly: true;
  adapterStatus: "SANDBOXED" | "READ_ONLY_READY";
  writeScopes: readonly [];
  sideEffects: readonly ["none"];
}

/** The only supported Growth Run identity map. Keep this map single-source. */
export const growthRunCompatibilityCatalog = Object.freeze({
  content_acquisition: {
    templateType: "content_acquisition",
    templateVersion: "2.0.0",
    packId: "pack_growth_v1",
    packVersion: "1.0.0",
    workflowId: "workflow_growth_content_acquisition",
    workflowVersion: "1.0.0",
    adapterId: "adapter_growth_content_acquisition",
    adapterVersion: "1.0.0",
    simulationOnly: true,
    adapterStatus: "SANDBOXED",
    writeScopes: [],
    sideEffects: ["none"]
  },
  private_conversion: {
    templateType: "private_conversion",
    templateVersion: "2.0.0",
    packId: "pack_growth_v1",
    packVersion: "1.0.0",
    workflowId: "workflow_growth_private_conversion",
    workflowVersion: "1.0.0",
    adapterId: "adapter_growth_private_conversion",
    adapterVersion: "1.0.0",
    simulationOnly: true,
    adapterStatus: "SANDBOXED",
    writeScopes: [],
    sideEffects: ["none"]
  },
  weekly_review: {
    templateType: "weekly_review",
    templateVersion: "2.0.0",
    packId: "pack_growth_v1",
    packVersion: "1.0.0",
    workflowId: "workflow_growth_weekly_review",
    workflowVersion: "1.0.0",
    adapterId: "adapter_growth_weekly_review",
    adapterVersion: "1.0.0",
    simulationOnly: true,
    adapterStatus: "SANDBOXED",
    writeScopes: [],
    sideEffects: ["none"]
  }
} as const satisfies Record<GrowthRunCompatibility["templateType"], GrowthRunCompatibility>);

export const growthRunCompatibilitySchema = z.object({
  templateType: z.enum(["content_acquisition", "private_conversion", "weekly_review"]),
  templateVersion: z.literal("2.0.0"),
  packId: z.literal("pack_growth_v1"),
  packVersion: z.literal("1.0.0"),
  workflowId: universalIdSchema,
  workflowVersion: z.literal("1.0.0"),
  adapterId: universalIdSchema,
  adapterVersion: z.literal("1.0.0"),
  simulationOnly: z.literal(true),
  adapterStatus: z.enum(["SANDBOXED", "READ_ONLY_READY"]),
  writeScopes: z.array(z.never()),
  sideEffects: z.tuple([z.literal("none")])
}).strict();

export const growthRunCompatibilityMap = growthRunCompatibilityCatalog;

export function getGrowthRunCompatibility(templateType: string): GrowthRunCompatibility {
  const compatibility = (growthRunCompatibilityCatalog as Record<string, GrowthRunCompatibility>)[templateType];
  if (!compatibility) throw new Error(`Unsupported Growth Run template for Universal WorkItem: ${templateType}`);
  return compatibility;
}

export function normalizeGrowthRunStatus(status: string): UniversalRunStatus {
  const normalized = normalizeLegacyRunStatus(status);
  const statusMap: Record<string, UniversalRunStatus> = {
    draft: "DRAFT",
    queued: "QUEUED",
    running: "RUNNING",
    waiting_approval: "WAITING_APPROVAL",
    completed: "COMPLETED",
    failed: "FAILED",
    cancelled: "CANCELED",
    DRAFT: "DRAFT",
    QUEUED: "QUEUED",
    RUNNING: "RUNNING",
    WAITING_APPROVAL: "WAITING_APPROVAL",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED",
    CANCELED: "CANCELED"
  };
  const mapped = statusMap[normalized];
  if (!mapped) throw new Error(`Unsupported Legacy Run status for Universal WorkItem: ${status}`);
  return mapped;
}

function growthEntity(scope: UniversalScope, createdBy: string, now: string, sourceRef: string) {
  return {
    schemaVersion: "1.0",
    scope,
    createdBy,
    createdAt: now,
    updatedAt: now,
    sourceRefs: [sourceRef],
    metadata: { simulationOnly: true }
  };
}

/** Build the explicit Growth Pack snapshot used by local compatibility tests and callers. */
export function createGrowthPackSnapshot(
  scope: UniversalScope,
  createdBy: string,
  now: string
): ProjectPackManifest {
  void createdBy;
  void now;
  if (!scope.projectId) throw new Error("Growth Pack snapshot requires explicit scope.projectId");
  return projectPackManifestSchema.parse({
    packId: "pack_growth_v1",
    scope,
    projectId: scope.projectId,
    version: "1.0.0",
    status: "ACTIVE",
    compatibilityRange: ">=1.0.0 <2.0.0",
    projectTypeKey: "growth_operations",
    lifecycleProfile: ["DISCOVER", "PLAN", "EXECUTE", "REVIEW", "PAUSE", "RETIRE"],
    objectiveProfiles: ["content_acquisition", "private_conversion", "weekly_review"],
    metricDefinitions: ["metric_growth_run_success_rate"],
    workflowDefinitions: Object.values(growthRunCompatibilityCatalog).map((item) => item.workflowId),
    workflowRefs: Object.values(growthRunCompatibilityCatalog).map((item) => item.workflowId),
    capabilityRefs: ["capability_growth_simulation"],
    adapterRefs: Object.values(growthRunCompatibilityCatalog).map((item) => item.adapterId),
    approvalPolicy: { private_conversion: "manual" },
    budgetPolicy: { mode: "SIMULATION_ONLY" },
    evidenceRules: { resultStatus: "SUCCESS_UNVERIFIED" },
    frontendModuleRegistry: ["GrowthWorkItem", "GrowthRun", "GrowthReceipt"],
    localizationRefs: ["locale_zh_cn", "locale_en_us"]
  });
}

/** Build one immutable workflow snapshot for a catalogued Growth template. */
export function createGrowthWorkflowSnapshot(
  templateType: string,
  scope: UniversalScope,
  createdBy: string,
  now: string
): WorkflowDefinition {
  const compatibility = getGrowthRunCompatibility(templateType);
  if (!scope.projectId) throw new Error("Growth Workflow snapshot requires explicit scope.projectId");
  const approval = compatibility.templateType === "private_conversion";
  return workflowDefinitionSchema.parse({
    ...growthEntity(scope, createdBy, now, `growth-workflow:${compatibility.workflowId}@1.0.0`),
    id: compatibility.workflowId,
    packId: compatibility.packId,
    packVersion: compatibility.packVersion,
    projectId: scope.projectId,
    version: compatibility.workflowVersion,
    inputSchema: { legacyRun: "Run.input" },
    outputSchema: { outputPayload: "Run.outputPayload" },
    nodes: [{
      nodeId: "simulate",
      kind: approval ? "simulate_preview" : "simulate",
      capabilityRefs: ["capability_growth_simulation"],
      riskClass: "LOW",
      timeoutMs: 5000,
      approvalPoint: approval,
      produces: ["outputPayload"],
      consumes: ["legacyRun"]
    }],
    edges: [],
    retryPolicy: { maxAttempts: 0 },
    failurePolicy: { mode: "explicit_failure" },
    approvalPoints: approval ? ["simulate"] : [],
    approvalPolicy: approval ? { mode: "manual", simulationOnly: true } : {},
    status: "ACTIVE"
  });
}

/** Build one simulation-only, read-only Growth Adapter manifest. */
export function createGrowthAdapterSnapshot(
  templateType: string,
  scope: UniversalScope,
  createdBy: string,
  now: string
): AdapterManifest {
  void createdBy;
  void now;
  const compatibility = getGrowthRunCompatibility(templateType);
  if (!scope.projectId) throw new Error("Growth Adapter snapshot requires explicit scope.projectId");
  const actionType = compatibility.templateType === "content_acquisition"
    ? "mcp_generate_brief"
    : compatibility.templateType === "private_conversion"
      ? "mcp_generate_conversion_copy"
      : "mcp_generate_review";
  return adapterManifestSchema.parse({
    adapterId: compatibility.adapterId,
    scope,
    version: compatibility.adapterVersion,
    compatibilityRange: ">=1.0.0 <2.0.0",
    sourceSystem: "GROWTH_SIMULATION",
    projectRef: scope.projectId,
    objectMappings: [{ sourceType: "LegacyRun", targetType: "UniversalWorkItem" }],
    eventMappings: [{ sourceEvent: "legacy.run.completed", targetEvent: "work_item.completed" }],
    readScopes: ["growth:simulation:read"],
    writeScopes: [],
    inputSchema: { actionType },
    outputSchema: { outputPayload: "Run.outputPayload" },
    authRequirements: [],
    sideEffects: ["none"],
    simulationOnly: true,
    riskClass: "LOW",
    idempotencyStrategy: "legacy_run_id",
    timeoutMs: 5000,
    retryPolicy: { maxAttempts: 0 },
    rateLimit: { mode: "local" },
    healthCheck: "local_contract",
    readinessCheck: "simulation_only",
    dryRunSupported: true,
    rollbackHint: "delete_local_work_item_binding",
    evidenceRequirements: ["legacy_run_ref", "snapshot_refs"],
    status: compatibility.adapterStatus
  });
}
