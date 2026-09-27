import { createHash, randomUUID } from "node:crypto";
import { eq, and, or, sql, lte, gt, inArray, desc } from "drizzle-orm";
import { z } from "zod";

import {
  closeDatabase,
  createDb,
  createInMemoryDb,
  workspaces,
  workspaceMembers,
  runs,
  workItems,
  approvalRequests,
  memoryRecords,
  agents,
  artifacts,
  knowledgeEntries,
  schedules,
  teamRuns,
  teams,
  teamMembers,
  industryBenchmarks,
  subscriptions,
  usageCounters,
  productEvents,
  outboxEvents,
  runEvents,
  evidenceRecords,
  receipts,
  workflowDefinitions,
  projectPackRegistry,
  adapterRegistry,
  attempts,
  replayCheckpoints,
  universalAuditEvents,
  metricDefinitions as metricDefinitionsTable,
  metricObservations as metricObservationsTable,
  jobs,
  type Database
} from "@neuroclaw/db";
import {
  DrizzleMemoryStore,
  type MemoryRecord,
  type MemoryRecordType,
  type MemoryStore,
  type UpdateMemoryRecordInput
} from "@neuroclaw/memory";
import { getTraceLog, type TraceLog } from "@neuroclaw/observability";
import {
  applyApprovalDecision,
  assertRunInput,
  assertTemplateType,
  transitionRun,
  planMonthlyRunQuota,
  TRIAL_MONTHLY_RUN_QUOTA,
  type ApprovalDecision,
  type ApprovalRequest,
  type Run,
  type RunStepResult,
  type RuntimeEvent,
  type Template,
  type TemplateInputPayload,
  type TemplateOutputPayload,
  type Workspace,
  type WorkspacePlan,
  type CreateAgentInput,
  type UpdateAgentInput,
  type SavePlaybookInput,
  type OutboxEvent,
  type OutboxEventInput,
  type OutboxEventStatus,
  assertOutboxEventTransition,
  outboxEventSchema,
  OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
  outboxDeliveryIntentSchema,
  outboxDeliveryPayloadSchema,
  type OutboxDeliveryIntent,
  runtimeEventSchema,
  assertReceiptEvidenceChain,
  assertMetricDefinitionRegistryConsistency,
  assertProjectPackConsistency,
  assertProjectPackRegistryConsistency,
  assertAdapterRegistryConsistency,
  assertAdapterStatusTransition,
  assertProjectPackStatusTransition,
  assertScopeConsistency,
  evidenceSchema,
  metricDefinitionSchema,
  metricObservationSchema,
  receiptValidationSchema,
  taskReceiptSchema,
  type UniversalEvidence,
  type MetricDefinition,
  type MetricObservation,
  type ReceiptValidation,
  type UniversalScope,
  type UniversalWorkItem,
  type UniversalRun,
  type TaskReceipt,
  type GrowthRunCompatibility,
  type WorkflowDefinition,
  type ProjectPackManifest,
  type ProjectPackRegistryEntry,
  type AdapterManifest,
  type AdapterRegistryEntry,
  type ProjectPackStatus,
  type AdapterStatus,
  type UniversalPolicy,
  type UniversalBudget,
  type UniversalApproval,
  type UniversalRevocation,
  type UniversalKillSwitch,
  type AdapterSafetySnapshot,
  workflowDefinitionSchema,
  adapterManifestSchema,
  projectPackManifestSchema,
  projectPackRegistryEntrySchema,
  adapterRegistryEntrySchema,
  validateWorkflowGraph,
  getGrowthRunCompatibility,
  normalizeGrowthRunStatus,
  universalScopeSchema,
  workItemSchema,
  universalRunSchema,
  assertExecutionIdentityConsistency,
  assertAuditReplayConsistency,
  attemptIdentitySchema,
  replayCheckpointSchema,
  auditEventSchema,
  type AttemptIdentity,
  type ReplayCheckpoint,
  type AuditEvent,
  type AuditReplayConsistencyInput,
  type SimulationAdapterInput,
  type SimulationProjectIntegrationBundle,
  type SimulationProjectIntegrationConfigInput,
  buildSimulationProjectIntegration,
  buildSimulationAdapterInputs,
  pilotSimulationIntegrationConfigs,
  assertSimulationOnlyAdapter,
  pilotPackManifests,
  pilotAdapterManifests,
  simulationProjectIntegrationConfigSchema,
} from "@neuroclaw/shared";
import {
  builtinRegistry,
  globalRegistry,
  listTemplates as listBuiltinTemplates
} from "@neuroclaw/templates";
import { TemporalWorkerSkeleton, type JobPayload } from "@neuroclaw/temporal-worker";
import { generateStructuredForAgent, embedText, isEmbeddingEnabled } from "@neuroclaw/agent-core";
import { playbooks as playbooksTable } from "@neuroclaw/db";
import { resolveOutboxDispatchConfig } from "./outbox-dispatcher.js";
import {
  buildMonthlyArchive,
  DEFAULT_TZ_OFFSET_MINUTES,
  type MonthlyArchiveAggregate
} from "./monthly-archive.js";

export interface CreateWorkspaceInput {
  name: string;
  plan: WorkspacePlan;
}

export interface CreateRunInput {
  workspaceId: string;
  templateType: string;
  input: Record<string, unknown>;
}

export interface GrowthSnapshotRefs {
  pack: string;
  workflow: string;
  adapter: string;
}

/** Explicit inputs for the AC-4-0 compatibility wrapper. */
export interface MaterializeGrowthRunInput {
  legacyRunId: string;
  projectId: string;
  initiativeId: string;
  assigneeRef: string;
  scope: UniversalScope;
  packId?: string;
  packRef?: string;
  packVersion?: string;
  workflowRef?: string;
  workflowId?: string;
  workflowVersion?: string;
  adapterRef?: string;
  adapterId?: string;
  adapterVersion?: string;
  packSnapshot?: ProjectPackManifest;
  workflowSnapshot?: WorkflowDefinition;
  adapterSnapshot?: AdapterManifest;
  /** Aliases kept for callers that name snapshots by their contract object. */
  pack?: ProjectPackManifest;
  workflow?: WorkflowDefinition;
  adapter?: AdapterManifest;
  packSnapshotRef?: string;
  workflowSnapshotRef?: string;
  adapterSnapshotRef?: string;
  snapshotRefs?: GrowthSnapshotRefs;
  inputSnapshotRef: string;
  policySnapshotRef: string;
  policySnapshotVersion?: string;
  outputArtifactRefs?: readonly string[];
  outputSnapshotRef?: string;
  approvalRefs?: readonly string[];
  createdBy?: string;
}

export interface MaterializedGrowthRun {
  workItem: UniversalWorkItem;
  universalWorkItem: UniversalWorkItem;
  run: UniversalRun;
  universalRun: UniversalRun;
  receipt?: TaskReceipt;
  inserted: boolean;
  compatibility: GrowthRunCompatibility;
}

export interface EnqueueOutboxEventResult {
  event: OutboxEvent;
  /** False means the compound idempotency key already existed. */
  inserted: boolean;
  /** Compatibility fields for callers that only need the durable identity. */
  eventId: string;
  status: OutboxEventStatus;
}

/**
 * W2 §2.5: transaction handle for the runs-projection + delivery-intent write.
 * Derived from the Drizzle database so both writers share one type without
 * leaking generics through method signatures.
 */
type DbTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Wave 1 wiring: durable identity of one persisted runtime event stream. */
export interface RunRuntimeEventWiringResult {
  /** Persisted Outbox event ids, in execution order. */
  eventIds: string[];
  /** Replay checkpoint id, absent when the run has no replayable stream. */
  checkpointId?: string;
}

/** One row of the append-only `run_events` log, as returned to callers. */
export interface RunEventHistoryEntry {
  eventId: string;
  runId: string;
  sequence: number;
  eventType: string;
  occurredAt: string;
  emittedAt: string;
  payload: Record<string, unknown>;
}

export class IdempotencyConflictError extends Error {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(message: string) {
    super(message);
  }
}

export class NotFoundError extends Error {
  constructor(
    message: string,
    public readonly code = "NOT_FOUND"
  ) {
    super(message);
  }
}

/** Monthly run quota exceeded (Round K, audit P0-B3) — HTTP maps to 402. */
export class QuotaExceededError extends Error {
  constructor(
    message: string,
    public readonly code = "QUOTA_EXCEEDED",
    public readonly detail: { plan: WorkspacePlan | "trial"; quota: number; used: number } = {
      plan: "trial",
      quota: 0,
      used: 0
    }
  ) {
    super(message);
  }
}

function currentMonth(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

// ---------------------------------------------------------------------------
// DB row ↔ domain type mappers
// ---------------------------------------------------------------------------

type RunInsert = typeof runs.$inferInsert;

function runToInsert(run: Run): RunInsert {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    templateType: run.templateType,
    status: run.status,
    input: JSON.stringify(run.input),
    outputPayload: run.outputPayload ? JSON.stringify(run.outputPayload) : null,
    failureReason: run.failureReason ?? null,
    currentStep: run.currentStep,
    approvalStatus: run.approvalStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    stepResults: run.stepResults ? JSON.stringify(run.stepResults) : null,
    teamId: run.teamId ?? null,
    relayId: run.relayId ?? null
  };
}

type RunSelect = typeof runs.$inferSelect;

function rowToRun(row: RunSelect): Run {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    templateType: row.templateType as Run["templateType"],
    status: row.status as Run["status"],
    input: JSON.parse(row.input) as TemplateInputPayload,
    outputPayload: row.outputPayload
      ? (JSON.parse(row.outputPayload) as TemplateOutputPayload)
      : undefined,
    failureReason: row.failureReason ?? undefined,
    currentStep: row.currentStep,
    approvalStatus: row.approvalStatus as Run["approvalStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    stepResults: row.stepResults
      ? (JSON.parse(row.stepResults) as RunStepResult[])
      : undefined,
    ...(row.teamId ? { teamId: row.teamId } : {}),
    ...(row.relayId ? { relayId: row.relayId } : {})
  };
}

type WorkItemInsert = typeof workItems.$inferInsert;
type WorkItemSelect = typeof workItems.$inferSelect;

function growthWorkItemToInsert(
  materialized: MaterializedGrowthRun,
  input: MaterializeGrowthRunInput,
  now: string
): WorkItemInsert {
  const { workItem, run, receipt } = materialized;
  return {
    id: workItem.id,
    legacyRunId: input.legacyRunId,
    projectId: input.projectId,
    initiativeId: input.initiativeId,
    assigneeRef: input.assigneeRef,
    organizationId: input.scope.organizationId ?? null,
    workspaceId: input.scope.workspaceId ?? null,
    scopeProjectId: input.scope.projectId!,
    packId: materialized.compatibility.packId,
    packVersion: materialized.compatibility.packVersion,
    workflowRef: materialized.compatibility.workflowId,
    workflowVersion: materialized.compatibility.workflowVersion,
    adapterRef: materialized.compatibility.adapterId,
    adapterVersion: materialized.compatibility.adapterVersion,
    packSnapshotRef: input.packSnapshotRef ?? input.snapshotRefs!.pack,
    workflowSnapshotRef: input.workflowSnapshotRef ?? input.snapshotRefs!.workflow,
    adapterSnapshotRef: input.adapterSnapshotRef ?? input.snapshotRefs!.adapter,
    inputSnapshotRef: input.inputSnapshotRef,
    policySnapshotRef: input.policySnapshotRef,
    workItemJson: JSON.stringify(workItem),
    runJson: JSON.stringify(run),
    receiptJson: receipt ? JSON.stringify(receipt) : null,
    createdAt: now,
    updatedAt: now
  };
}

function rowToMaterializedGrowthRun(row: WorkItemSelect): MaterializedGrowthRun {
  const workItem = workItemSchema.parse(JSON.parse(row.workItemJson));
  const run = universalRunSchema.parse(JSON.parse(row.runJson));
  const receipt = row.receiptJson
    ? taskReceiptSchema.parse(JSON.parse(row.receiptJson))
    : undefined;
  const rowScope: UniversalScope = {
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    projectId: row.scopeProjectId
  };
  assertScopeConsistency("WorkItem persistence row", [
    workItem,
    run,
    ...(receipt ? [receipt] : []),
    { id: `${row.id}:row`, scope: rowScope }
  ]);
  if (
    workItem.id !== row.id ||
    workItem.legacyRunId !== row.legacyRunId ||
    run.workItemId !== workItem.id ||
    workItem.projectId !== row.projectId ||
    workItem.scope.projectId !== row.scopeProjectId ||
    workItem.scope.workspaceId !== (row.workspaceId ?? undefined) ||
    workItem.scope.organizationId !== (row.organizationId ?? undefined) ||
    workItem.packRef !== row.packId ||
    workItem.packVersion !== row.packVersion ||
    workItem.workflowRef !== row.workflowRef ||
    workItem.workflowVersion !== row.workflowVersion ||
    workItem.adapterRef !== row.adapterRef ||
    workItem.adapterVersion !== row.adapterVersion ||
    workItem.inputSnapshotRef !== row.inputSnapshotRef ||
    workItem.approvalPolicyRef !== row.policySnapshotRef ||
    (receipt && (receipt.workItemId !== workItem.id || receipt.runId !== run.id))
  ) {
    throw new Error(`WorkItem persistence identity/scope/version mismatch: ${row.id}`);
  }
  return {
    workItem,
    universalWorkItem: workItem,
    run,
    universalRun: run,
    ...(receipt ? { receipt } : {}),
    inserted: false,
    compatibility: getGrowthRunCompatibility(workItem.kind.replace("GROWTH_", "").toLowerCase())
  };
}

type OutboxEventInsert = typeof outboxEvents.$inferInsert;
type OutboxEventSelect = typeof outboxEvents.$inferSelect;

function normalizePersistedUtcTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace(".000Z", "Z");
}

function outboxEventToInsert(event: OutboxEvent, now: string): OutboxEventInsert {
  return {
    eventId: event.eventId,
    idempotencyScope: event.idempotencyScope,
    idempotencyKey: event.idempotencyKey,
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    occurredAt: event.occurredAt,
    emittedAt: event.emittedAt,
    scope: JSON.stringify(event.scope),
    actorRef: event.actorRef,
    subjectRef: event.subjectRef,
    correlationId: event.correlationId,
    causationId: event.causationId ?? null,
    traceId: event.traceId,
    dataClass: event.dataClass,
    payload: JSON.stringify(event.payload),
    status: event.status,
    createdAt: now,
    updatedAt: now
  };
}

function rowToOutboxEvent(row: OutboxEventSelect): OutboxEvent {
  return outboxEventSchema.parse({
    eventId: row.eventId,
    schemaVersion: row.schemaVersion,
    eventType: row.eventType,
    occurredAt: normalizePersistedUtcTimestamp(row.occurredAt),
    emittedAt: normalizePersistedUtcTimestamp(row.emittedAt),
    scope: JSON.parse(row.scope) as Record<string, string>,
    actorRef: row.actorRef,
    subjectRef: row.subjectRef,
    correlationId: row.correlationId,
    ...(row.causationId ? { causationId: row.causationId } : {}),
    idempotencyKey: row.idempotencyKey,
    traceId: row.traceId,
    dataClass: row.dataClass,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    idempotencyScope: row.idempotencyScope,
    status: row.status
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function outboxIdentitySnapshot(event: OutboxEvent): string {
  const { status: _status, ...immutable } = event;
  return canonicalJson(immutable);
}

/**
 * W2 §2.5: the strict `outbox.delivery.v1` intent stored in an outbox event
 * payload, when the payload is one — otherwise undefined (other event types
 * share the same table).
 */
function storedDeliveryIntent(event: OutboxEvent): OutboxDeliveryIntent | undefined {
  const parsed = outboxDeliveryPayloadSchema.safeParse(event.payload);
  return parsed.success ? parsed.data.deliveryIntent : undefined;
}

type RunEventInsert = typeof runEvents.$inferInsert;
type RunEventSelect = typeof runEvents.$inferSelect;

function runEventToInsert(event: {
  eventId: string;
  runId: string;
  attemptId: string | null;
  sequence: number;
  schemaVersion: string;
  eventType: string;
  actorRef: string;
  subjectRef: string;
  correlationId: string;
  traceId: string;
  idempotencyKey: string;
  occurredAt: string;
  emittedAt: string;
  dataClass: string;
  payload: Record<string, unknown>;
  createdAt: string;
}): RunEventInsert {
  return {
    eventId: event.eventId,
    runId: event.runId,
    attemptId: event.attemptId,
    sequence: event.sequence,
    schemaVersion: event.schemaVersion,
    eventType: event.eventType,
    actorRef: event.actorRef,
    subjectRef: event.subjectRef,
    correlationId: event.correlationId,
    traceId: event.traceId,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    emittedAt: event.emittedAt,
    dataClass: event.dataClass,
    payload: JSON.stringify(event.payload),
    createdAt: event.createdAt
  };
}

// ---------------------------------------------------------------------------
// Wave 1 wiring — RuntimeEvent stream persistence + replay checkpoint
//
// The runtime worker already returns `RuntimeExecutionResult.events`, but the
// control plane used to drop them. These helpers define the deterministic
// identity of one persisted runtime event so that:
//   * re-persisting the same outcome is idempotent (same event id/key), and
//   * a resumed execution appends a genuinely different event (new id/key)
//     instead of colliding with the first attempt's row.
// ---------------------------------------------------------------------------

const RUNTIME_EVENT_SCHEMA_VERSION = "1.0";
const RUNTIME_EVENT_ACTOR_REF = "runtime-worker";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable projection used for both the event identity and the checkpoint hash. */
function normalizeRuntimeEvent(event: RuntimeEvent): {
  type: RuntimeEvent["type"];
  runId: string;
  stepId: string | null;
  details: string;
  approvalDecision?: { approved: boolean };
} {
  return {
    type: event.type,
    runId: event.runId,
    stepId: event.stepId ?? null,
    details: event.details,
    // W1b approval parity: the decision is part of what the event *says*, so
    // it is part of the content identity. Only present when set, so every
    // pre-W1b event digests byte-identically to before.
    ...(event.approvalDecision ? { approvalDecision: event.approvalDecision } : {})
  };
}

/**
 * Content digest of one runtime event. Deliberately independent of `sequence`:
 * the identity of an event is what it says, not where it happens to sit, so a
 * resumed execution that re-emits an already-recorded event is recognised as
 * the same row instead of colliding with it.
 */
function runtimeEventDigest(event: RuntimeEvent): string {
  return sha256Hex(canonicalJson(normalizeRuntimeEvent(event)));
}

function runtimeEventStreamHash(events: readonly RuntimeEvent[]): string {
  return sha256Hex(canonicalJson(events.map(normalizeRuntimeEvent)));
}

/**
 * R-W1a fix. A worker that retries a step can emit the same event twice inside
 * one stream. Content identity is what makes an event an event, so the second
 * copy is the same event, not a second one — it is dropped here, before
 * identity assignment. Previously both copies resolved to the same `eventId`,
 * which made the replay checkpoint's `sourceEventRefs` non-unique and aborted
 * the whole persistence call with a `ZodError`. Malformed events still reject.
 */
function dedupeRuntimeEventStream(events: readonly RuntimeEvent[]): RuntimeEvent[] {
  const seen = new Set<string>();
  const unique: RuntimeEvent[] = [];
  for (const rawEvent of events) {
    const event = runtimeEventSchema.parse(rawEvent);
    const digest = runtimeEventDigest(event);
    if (seen.has(digest)) continue;
    seen.add(digest);
    unique.push(event);
  }
  return unique;
}

/**
 * The `runs` row's own timestamps, read back from the database. Used verbatim as
 * the log's identity baseline so a rebuild is byte-equal to the row.
 */
interface PersistedRunClock {
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/**
 * Identity baseline persisted alongside the first event of a stream so the log
 * alone can rebuild the `runs` row (the fields the event vocabulary cannot
 * express). Timestamps come from the persisted row, not from the in-memory
 * outcome, so the rebuild is byte-equal rather than merely the same instant.
 */
function runEventRunBase(run: Run, clock: PersistedRunClock): Record<string, unknown> {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    templateType: run.templateType,
    input: run.input,
    createdAt: clock.createdAt,
    updatedAt: clock.updatedAt,
    ...(clock.startedAt ? { startedAt: clock.startedAt } : {}),
    ...(clock.completedAt ? { completedAt: clock.completedAt } : {})
  };
}

/**
 * Rebuild the worker-facing RuntimeEvent from its persisted `run_events` row.
 * A payload that no longer satisfies the shared contract rejects instead of
 * silently producing a partial replay stream.
 */
function runEventToRuntimeEvent(row: RunEventSelect): RuntimeEvent {
  const payload = JSON.parse(row.payload) as {
    runId?: unknown;
    type?: unknown;
    stepId?: unknown;
    details?: unknown;
    approvalDecision?: { approved: boolean } | undefined;
  };
  return runtimeEventSchema.parse({
    type: payload.type,
    runId: payload.runId,
    ...(typeof payload.stepId === "string" ? { stepId: payload.stepId } : {}),
    details: payload.details,
    ...(payload.approvalDecision ? { approvalDecision: payload.approvalDecision } : {})
  });
}

/**
 * One `run_events` row → the caller-facing history/tail entry. Shared by the
 * full-history read and the `sequence > cursor` tail read (W1b) so the SSE
 * route and the history endpoint see byte-identical payloads.
 */
function runEventRowToHistoryEntry(row: RunEventSelect): RunEventHistoryEntry {
  return {
    eventId: row.eventId,
    runId: row.runId,
    sequence: row.sequence,
    eventType: row.eventType,
    occurredAt: row.occurredAt,
    emittedAt: row.emittedAt,
    payload: JSON.parse(row.payload) as Record<string, unknown>
  };
}

type EvidenceInsert = typeof evidenceRecords.$inferInsert;
type ReceiptInsert = typeof receipts.$inferInsert;
type MetricDefinitionInsert = typeof metricDefinitionsTable.$inferInsert;
type MetricObservationInsert = typeof metricObservationsTable.$inferInsert;

function jsonValue(value: unknown): string {
  return JSON.stringify(value);
}

type WorkflowDefinitionInsert = typeof workflowDefinitions.$inferInsert;

function workflowDefinitionRowId(workflowId: string, version: string): string {
  // JSON encoding is unambiguous even when user-controlled IDs contain ':'.
  return `workflow_definition:${JSON.stringify([workflowId, version])}`;
}

function workflowDefinitionToInsert(workflow: WorkflowDefinition): WorkflowDefinitionInsert {
  return {
    id: workflowDefinitionRowId(workflow.id, workflow.version),
    workflowDefinitionId: workflow.id,
    version: workflow.version,
    packId: workflow.packId,
    packVersion: workflow.packVersion ?? workflow.version,
    ...scopeColumns(workflow.scope),
    schemaVersion: workflow.schemaVersion,
    createdBy: workflow.createdBy,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    sourceRefs: jsonValue(workflow.sourceRefs),
    inputSchema: jsonValue(workflow.inputSchema),
    outputSchema: jsonValue(workflow.outputSchema),
    nodes: jsonValue(workflow.nodes),
    edges: jsonValue(workflow.edges),
    retryPolicy: jsonValue(workflow.retryPolicy),
    failurePolicy: jsonValue(workflow.failurePolicy),
    approvalPoints: jsonValue(workflow.approvalPoints),
    approvalPolicy: jsonValue(workflow.approvalPolicy),
    status: workflow.status,
    rawJson: jsonValue(workflow)
  };
}

function rowToWorkflowDefinition(row: typeof workflowDefinitions.$inferSelect): WorkflowDefinition {
  const workflow = workflowDefinitionSchema.parse(JSON.parse(row.rawJson));
  if (
    workflow.id !== row.workflowDefinitionId ||
    workflow.version !== row.version ||
    workflowDefinitionRowId(workflow.id, workflow.version) !== row.id
  ) {
    throw new Error(`WorkflowDefinition row identity/version mismatch: ${row.id}`);
  }
  if (workflow.packId !== row.packId || (workflow.packVersion ?? workflow.version) !== row.packVersion) {
    throw new Error(`WorkflowDefinition row Pack/version mismatch: ${row.id}`);
  }
  assertScopeConsistency("WorkflowDefinition row", [
    workflow,
    { id: row.workflowDefinitionId, scope: scopeFromRow(row) }
  ]);
  return workflow;
}

function assertPersistableWorkflowDefinition(
  workflow: WorkflowDefinition,
  pack?: ProjectPackManifest
): void {
  if (workflow.projectId && workflow.projectId !== workflow.scope.projectId) {
    throw new Error("WorkflowDefinition projectId must match scope.projectId");
  }
  validateWorkflowGraph(workflow);
  if (pack) {
    assertProjectPackConsistency({ pack, workflow });
    const allowedCapabilities = new Set(pack.capabilityRefs);
    for (const node of workflow.nodes) {
      for (const capabilityRef of node.capabilityRefs) {
        if (!allowedCapabilities.has(capabilityRef)) {
          throw new Error(
            `Workflow node ${node.nodeId} references a capability not registered by the Pack: ${capabilityRef}`
          );
        }
      }
    }
  }
}

type PackRegistryInsert = typeof projectPackRegistry.$inferInsert;
type AdapterRegistryInsert = typeof adapterRegistry.$inferInsert;

export interface RegistrySecuritySnapshots {
  policy?: UniversalPolicy;
  budget?: UniversalBudget;
  approvals?: readonly UniversalApproval[];
  revocation?: UniversalRevocation;
  killSwitch?: UniversalKillSwitch;
  actionRef?: string;
  resourceRef?: string;
  rollbackPlan?: string;
  independentValidationRef?: string;
}

export interface ProjectPackRegistryOptions extends RegistrySecuritySnapshots {
  project?: import("@neuroclaw/shared").UniversalProject;
  workflows?: readonly WorkflowDefinition[];
  adapters?: readonly AdapterManifest[];
  adapterSafety?: Readonly<Record<string, AdapterSafetySnapshot>>;
  status?: ProjectPackStatus;
}

export interface AdapterRegistryOptions extends RegistrySecuritySnapshots {
  pack: ProjectPackManifest;
  project?: import("@neuroclaw/shared").UniversalProject;
  workflows?: readonly WorkflowDefinition[];
}

function registryRowId(kind: "pack" | "adapter", identity: string, version: string): string {
  return `${kind}_registry:${JSON.stringify([identity, version])}`;
}

function registrySecurityValues(security: RegistrySecuritySnapshots) {
  return {
    ...(security.policy ? {
      policySnapshotRef: security.policy.id,
      policySnapshotVersion: security.policy.version
    } : {}),
    ...(security.budget ? {
      budgetSnapshotRef: security.budget.id,
      budgetSnapshotVersion: security.budget.version
    } : {}),
    ...(security.revocation ? {
      revocationRef: security.revocation.id,
      revocationVersion: security.revocation.version
    } : {}),
    ...(security.killSwitch ? {
      killSwitchRef: security.killSwitch.id,
      killSwitchVersion: security.killSwitch.version
    } : {}),
    approvalRefs: (security.approvals ?? []).map((approval) => approval.id),
    rollbackPlan: security.rollbackPlan ?? "local_registry_snapshot_revert",
    ...(security.independentValidationRef
      ? { independentValidationRef: security.independentValidationRef }
      : {})
  };
}

function packRegistryToInsert(entry: ProjectPackRegistryEntry): PackRegistryInsert {
  return {
    id: entry.id,
    packId: entry.packId,
    version: entry.version,
    ...scopeColumns(entry.scope),
    projectId: entry.projectId,
    projectScopeId: entry.scope.projectId!,
    status: entry.status,
    manifestSnapshot: jsonValue(entry.manifestSnapshot),
    policySnapshotRef: entry.policySnapshotRef ?? null,
    policySnapshotVersion: entry.policySnapshotVersion ?? null,
    budgetSnapshotRef: entry.budgetSnapshotRef ?? null,
    budgetSnapshotVersion: entry.budgetSnapshotVersion ?? null,
    revocationRef: entry.revocationRef ?? null,
    revocationVersion: entry.revocationVersion ?? null,
    killSwitchRef: entry.killSwitchRef ?? null,
    killSwitchVersion: entry.killSwitchVersion ?? null,
    approvalRefs: jsonValue(entry.approvalRefs),
    rollbackPlan: entry.rollbackPlan,
    independentValidationRef: entry.independentValidationRef ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function adapterRegistryToInsert(entry: AdapterRegistryEntry): AdapterRegistryInsert {
  return {
    id: entry.id,
    packId: entry.packId,
    packVersion: entry.packVersion,
    adapterId: entry.adapterId,
    version: entry.version,
    ...scopeColumns(entry.scope),
    projectId: entry.projectId,
    projectScopeId: entry.scope.projectId!,
    status: entry.status,
    manifestSnapshot: jsonValue(entry.manifestSnapshot),
    policySnapshotRef: entry.policySnapshotRef ?? null,
    policySnapshotVersion: entry.policySnapshotVersion ?? null,
    budgetSnapshotRef: entry.budgetSnapshotRef ?? null,
    budgetSnapshotVersion: entry.budgetSnapshotVersion ?? null,
    revocationRef: entry.revocationRef ?? null,
    revocationVersion: entry.revocationVersion ?? null,
    killSwitchRef: entry.killSwitchRef ?? null,
    killSwitchVersion: entry.killSwitchVersion ?? null,
    approvalRefs: jsonValue(entry.approvalRefs),
    rollbackPlan: entry.rollbackPlan,
    independentValidationRef: entry.independentValidationRef ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt
  };
}

function scopeFromRegistryRow(row: {
  organizationId: string | null;
  workspaceId: string | null;
  projectScopeId: string;
}): UniversalScope {
  return {
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    projectId: row.projectScopeId
  };
}

function rowToProjectPackRegistryEntry(
  row: typeof projectPackRegistry.$inferSelect
): ProjectPackRegistryEntry {
  const manifestSnapshot = projectPackManifestSchema.parse(JSON.parse(row.manifestSnapshot));
  const entry = projectPackRegistryEntrySchema.parse({
    id: row.id,
    projectId: row.projectId,
    packId: row.packId,
    version: row.version,
    scope: scopeFromRegistryRow(row),
    status: row.status,
    manifestSnapshot,
    ...(row.policySnapshotRef ? { policySnapshotRef: row.policySnapshotRef } : {}),
    ...(row.policySnapshotVersion ? { policySnapshotVersion: row.policySnapshotVersion } : {}),
    ...(row.budgetSnapshotRef ? { budgetSnapshotRef: row.budgetSnapshotRef } : {}),
    ...(row.budgetSnapshotVersion ? { budgetSnapshotVersion: row.budgetSnapshotVersion } : {}),
    ...(row.revocationRef ? { revocationRef: row.revocationRef } : {}),
    ...(row.revocationVersion ? { revocationVersion: row.revocationVersion } : {}),
    ...(row.killSwitchRef ? { killSwitchRef: row.killSwitchRef } : {}),
    ...(row.killSwitchVersion ? { killSwitchVersion: row.killSwitchVersion } : {}),
    approvalRefs: JSON.parse(row.approvalRefs) as string[],
    rollbackPlan: row.rollbackPlan,
    ...(row.independentValidationRef ? { independentValidationRef: row.independentValidationRef } : {}),
    createdAt: normalizePersistedUtcTimestamp(row.createdAt),
    updatedAt: normalizePersistedUtcTimestamp(row.updatedAt)
  });
  assertScopeConsistency("Project Pack registry row", [
    { id: entry.id, scope: entry.scope },
    { id: entry.manifestSnapshot.packId, scope: entry.manifestSnapshot.scope }
  ]);
  return entry;
}

function rowToAdapterRegistryEntry(row: typeof adapterRegistry.$inferSelect): AdapterRegistryEntry {
  const manifestSnapshot = adapterManifestSchema.parse(JSON.parse(row.manifestSnapshot));
  const entry = adapterRegistryEntrySchema.parse({
    id: row.id,
    projectId: row.projectId,
    packId: row.packId,
    packVersion: row.packVersion,
    adapterId: row.adapterId,
    version: row.version,
    scope: scopeFromRegistryRow(row),
    status: row.status,
    manifestSnapshot,
    ...(row.policySnapshotRef ? { policySnapshotRef: row.policySnapshotRef } : {}),
    ...(row.policySnapshotVersion ? { policySnapshotVersion: row.policySnapshotVersion } : {}),
    ...(row.budgetSnapshotRef ? { budgetSnapshotRef: row.budgetSnapshotRef } : {}),
    ...(row.budgetSnapshotVersion ? { budgetSnapshotVersion: row.budgetSnapshotVersion } : {}),
    ...(row.revocationRef ? { revocationRef: row.revocationRef } : {}),
    ...(row.revocationVersion ? { revocationVersion: row.revocationVersion } : {}),
    ...(row.killSwitchRef ? { killSwitchRef: row.killSwitchRef } : {}),
    ...(row.killSwitchVersion ? { killSwitchVersion: row.killSwitchVersion } : {}),
    approvalRefs: JSON.parse(row.approvalRefs) as string[],
    rollbackPlan: row.rollbackPlan,
    ...(row.independentValidationRef ? { independentValidationRef: row.independentValidationRef } : {}),
    createdAt: normalizePersistedUtcTimestamp(row.createdAt),
    updatedAt: normalizePersistedUtcTimestamp(row.updatedAt)
  });
  assertScopeConsistency("Adapter registry row", [
    { id: entry.id, scope: entry.scope },
    { id: entry.adapterId, scope: entry.manifestSnapshot.scope }
  ]);
  return entry;
}

type WorkflowDefinitionPersistenceOptions =
  | { pack?: ProjectPackManifest }
  | ProjectPackManifest;

function packFromWorkflowOptions(
  options: WorkflowDefinitionPersistenceOptions
): ProjectPackManifest | undefined {
  return "packId" in options ? options : options.pack;
}

function scopeColumns(scope: UniversalScope) {
  return {
    organizationId: scope.organizationId ?? null,
    workspaceId: scope.workspaceId ?? null,
    projectId: scope.projectId ?? null
  };
}

function scopeFromRow(row: {
  organizationId: string | null;
  workspaceId: string | null;
  projectId: string | null;
}): UniversalScope {
  const scope = {
    ...(row.organizationId ? { organizationId: row.organizationId } : {}),
    ...(row.workspaceId ? { workspaceId: row.workspaceId } : {}),
    ...(row.projectId ? { projectId: row.projectId } : {})
  };
  return scope;
}

function assertExpectedScope(
  label: string,
  record: { id: string; scope: UniversalScope },
  expectedScope?: UniversalScope
): void {
  if (!expectedScope) return;
  assertScopeConsistency(label, [
    { id: `${record.id}:expected`, scope: expectedScope },
    record
  ]);
}

function sameScope(left: UniversalScope, right: UniversalScope): boolean {
  return ["organizationId", "workspaceId", "projectId"].every(
    (dimension) => left[dimension as keyof UniversalScope] === right[dimension as keyof UniversalScope]
  );
}

function assertMaterializedBindingContext(
  existing: MaterializedGrowthRun,
  candidate: MaterializedGrowthRun
): void {
  const sameStableContext =
    existing.workItem.id === candidate.workItem.id &&
    existing.workItem.projectId === candidate.workItem.projectId &&
    existing.workItem.initiativeId === candidate.workItem.initiativeId &&
    existing.workItem.assigneeRef === candidate.workItem.assigneeRef &&
    sameScope(existing.workItem.scope, candidate.workItem.scope) &&
    existing.workItem.packRef === candidate.workItem.packRef &&
    existing.workItem.packVersion === candidate.workItem.packVersion &&
    existing.workItem.workflowRef === candidate.workItem.workflowRef &&
    existing.workItem.workflowVersion === candidate.workItem.workflowVersion &&
    existing.workItem.adapterRef === candidate.workItem.adapterRef &&
    existing.workItem.adapterVersion === candidate.workItem.adapterVersion &&
    existing.workItem.inputSnapshotRef === candidate.workItem.inputSnapshotRef &&
    existing.workItem.approvalPolicyRef === candidate.workItem.approvalPolicyRef &&
    existing.workItem.metadata.packSnapshotRef === candidate.workItem.metadata.packSnapshotRef &&
    existing.workItem.metadata.workflowSnapshotRef === candidate.workItem.metadata.workflowSnapshotRef &&
    existing.workItem.metadata.adapterSnapshotRef === candidate.workItem.metadata.adapterSnapshotRef &&
    canonicalJson(existing.workItem.metadata.packSnapshot) ===
      canonicalJson(candidate.workItem.metadata.packSnapshot) &&
    canonicalJson(existing.workItem.metadata.workflowSnapshot) ===
      canonicalJson(candidate.workItem.metadata.workflowSnapshot) &&
    canonicalJson(existing.workItem.metadata.adapterSnapshot) ===
      canonicalJson(candidate.workItem.metadata.adapterSnapshot);
  if (!sameStableContext) {
    throw new Error("Legacy Run is already bound to a different Universal WorkItem context");
  }
}

function assertMaterializedRowMatchesCandidate(
  row: WorkItemSelect,
  candidate: WorkItemInsert
): void {
  const queryableFields: Array<keyof WorkItemSelect> = [
    "legacyRunId",
    "projectId",
    "initiativeId",
    "assigneeRef",
    "organizationId",
    "workspaceId",
    "scopeProjectId",
    "packId",
    "packVersion",
    "workflowRef",
    "workflowVersion",
    "adapterRef",
    "adapterVersion",
    "packSnapshotRef",
    "workflowSnapshotRef",
    "adapterSnapshotRef",
    "inputSnapshotRef",
    "policySnapshotRef"
  ];
  if (queryableFields.some((field) => row[field] !== candidate[field])) {
    throw new Error("Legacy Run is already bound to a conflicting queryable snapshot context");
  }
  const storedWorkItem = workItemSchema.parse(JSON.parse(row.workItemJson));
  const candidateWorkItem = workItemSchema.parse(JSON.parse(candidate.workItemJson));
  const storedRun = universalRunSchema.parse(JSON.parse(row.runJson));
  const candidateRun = universalRunSchema.parse(JSON.parse(candidate.runJson));
  const stableSnapshotContext = (workItem: UniversalWorkItem, run: UniversalRun) => ({
    workItemId: workItem.id,
    legacyRunId: workItem.legacyRunId,
    projectId: workItem.projectId,
    scope: workItem.scope,
    packRef: workItem.packRef,
    packVersion: workItem.packVersion,
    workflowRef: workItem.workflowRef,
    workflowVersion: workItem.workflowVersion,
    adapterRef: workItem.adapterRef,
    adapterVersion: workItem.adapterVersion,
    packSnapshotRef: workItem.metadata.packSnapshotRef,
    workflowSnapshotRef: workItem.metadata.workflowSnapshotRef,
    adapterSnapshotRef: workItem.metadata.adapterSnapshotRef,
    packSnapshot: workItem.metadata.packSnapshot,
    workflowSnapshot: workItem.metadata.workflowSnapshot,
    adapterSnapshot: workItem.metadata.adapterSnapshot,
    runId: run.id,
    runWorkItemId: run.workItemId,
    runWorkflowRef: run.workflowRef,
    runWorkflowVersion: run.workflowVersion,
    runManifestRef: run.manifestRef,
    runManifestVersion: run.manifestVersion,
    runInputSnapshotRef: run.inputSnapshotRef,
    runPolicySnapshotRef: run.policySnapshotRef,
    runPolicySnapshotVersion: run.policySnapshotVersion
  });
  if (canonicalJson(stableSnapshotContext(storedWorkItem, storedRun)) !==
      canonicalJson(stableSnapshotContext(candidateWorkItem, candidateRun))) {
    throw new Error("Legacy Run is already bound to a conflicting Universal snapshot");
  }
}

function evidenceToInsert(evidence: UniversalEvidence): EvidenceInsert {
  return {
    ...scopeColumns(evidence.scope),
    id: evidence.id,
    schemaVersion: evidence.schemaVersion,
    createdBy: evidence.createdBy,
    createdAt: evidence.createdAt,
    updatedAt: evidence.updatedAt,
    sourceRefs: jsonValue(evidence.sourceRefs),
    subjectRef: evidence.subjectRef,
    evidenceLevel: evidence.evidenceLevel,
    sourceType: evidence.sourceType,
    sourceRef: evidence.sourceRef,
    observedAt: evidence.observedAt,
    collectedAt: evidence.collectedAt,
    contentHash: evidence.contentHash ?? null,
    excerptRef: evidence.excerptRef ?? null,
    verifierRef: evidence.verifierRef ?? null,
    status: evidence.status,
    supersedes: evidence.supersedes ?? null,
    retentionPolicy: jsonValue(evidence.retentionPolicy),
    rawJson: jsonValue(evidence)
  };
}

function rowToEvidence(row: typeof evidenceRecords.$inferSelect): UniversalEvidence {
  const evidence = evidenceSchema.parse(JSON.parse(row.rawJson));
  if (evidence.id !== row.id) throw new Error(`Evidence row identity mismatch: ${row.id}`);
  assertScopeConsistency("Evidence row", [
    evidence,
    { id: row.id, scope: scopeFromRow(row) }
  ]);
  return evidence;
}

function receiptToInsert(
  receipt: TaskReceipt,
  validations: readonly ReceiptValidation[]
): ReceiptInsert {
  return {
    ...scopeColumns(receipt.scope),
    id: receipt.id,
    schemaVersion: receipt.schemaVersion,
    createdBy: receipt.createdBy,
    createdAt: receipt.createdAt,
    updatedAt: receipt.updatedAt,
    sourceRefs: jsonValue(receipt.sourceRefs),
    workItemId: receipt.workItemId,
    runId: receipt.runId,
    actorRef: receipt.actorRef,
    capabilityRef: receipt.capabilityRef ?? null,
    workflowVersion: receipt.workflowVersion,
    workflowRef: receipt.workflowRef ?? null,
    inputSnapshotRef: receipt.inputSnapshotRef,
    manifestRef: receipt.manifestRef ?? null,
    manifestVersion: receipt.manifestVersion ?? null,
    policySnapshotVersion: receipt.policySnapshotVersion ?? null,
    outputArtifactRefs: jsonValue(receipt.outputArtifactRefs),
    evidenceRefs: jsonValue(receipt.evidenceRefs),
    validationRefs: jsonValue(receipt.validationRefs),
    metricObservationRefs: jsonValue(receipt.metricObservationRefs),
    policySnapshotRef: receipt.policySnapshotRef,
    approvalRefs: jsonValue(receipt.approvalRefs),
    attemptRef: receipt.attemptRef ?? null,
    attemptNumber: receipt.attemptNumber ?? null,
    budgetSnapshotRef: receipt.budgetSnapshotRef ?? null,
    budgetSnapshotVersion: receipt.budgetSnapshotVersion ?? null,
    revocationRef: receipt.revocationRef ?? null,
    killSwitchRef: receipt.killSwitchRef ?? null,
    costSnapshot: receipt.costSnapshot ? jsonValue(receipt.costSnapshot) : null,
    resultStatus: receipt.resultStatus,
    replayRef: receipt.replayRef ?? null,
    producedAt: receipt.producedAt,
    validationJson: jsonValue(validations),
    rawJson: jsonValue(receipt)
  };
}

function rowToReceipt(row: typeof receipts.$inferSelect): TaskReceipt {
  const receipt = taskReceiptSchema.parse(JSON.parse(row.rawJson));
  if (receipt.id !== row.id) throw new Error(`Receipt row identity mismatch: ${row.id}`);
  assertScopeConsistency("Receipt row", [
    receipt,
    { id: row.id, scope: scopeFromRow(row) }
  ]);
  return receipt;
}

type AttemptInsert = typeof attempts.$inferInsert;
type ReplayCheckpointInsert = typeof replayCheckpoints.$inferInsert;
type UniversalAuditEventInsert = typeof universalAuditEvents.$inferInsert;

function attemptToInsert(attempt: AttemptIdentity): AttemptInsert {
  return {
    ...scopeColumns(attempt.scope),
    id: attempt.id,
    schemaVersion: attempt.schemaVersion,
    createdBy: attempt.createdBy,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
    sourceRefs: jsonValue(attempt.sourceRefs),
    runId: attempt.runId,
    workItemId: attempt.workItemId,
    attemptNumber: attempt.attemptNumber,
    idempotencyKey: attempt.idempotencyKey,
    workflowVersion: attempt.workflowVersion,
    workflowRef: attempt.workflowRef ?? null,
    status: attempt.status,
    startedAt: attempt.startedAt,
    endedAt: attempt.endedAt ?? null,
    checkpointRef: attempt.checkpointRef ?? null,
    rawJson: jsonValue(attempt)
  };
}

function rowToAttempt(row: typeof attempts.$inferSelect): AttemptIdentity {
  const attempt = attemptIdentitySchema.parse(JSON.parse(row.rawJson));
  if (
    attempt.id !== row.id ||
    attempt.runId !== row.runId ||
    attempt.workItemId !== row.workItemId ||
    attempt.attemptNumber !== row.attemptNumber ||
    attempt.idempotencyKey !== row.idempotencyKey ||
    attempt.workflowVersion !== row.workflowVersion ||
    (attempt.workflowRef ?? null) !== row.workflowRef ||
    attempt.status !== row.status ||
    attempt.startedAt !== normalizePersistedUtcTimestamp(row.startedAt) ||
    (attempt.endedAt ?? null) !== (row.endedAt ? normalizePersistedUtcTimestamp(row.endedAt) : null) ||
    (attempt.checkpointRef ?? null) !== row.checkpointRef
  ) {
    throw new Error(`Attempt persistence identity/version mismatch: ${row.id}`);
  }
  assertScopeConsistency("Attempt row", [attempt, { id: row.id, scope: scopeFromRow(row) }]);
  return attempt;
}

function replayCheckpointToInsert(checkpoint: ReplayCheckpoint): ReplayCheckpointInsert {
  return {
    ...scopeColumns(checkpoint.scope),
    id: checkpoint.id,
    schemaVersion: checkpoint.schemaVersion,
    createdBy: checkpoint.createdBy,
    createdAt: checkpoint.createdAt,
    updatedAt: checkpoint.updatedAt,
    sourceRefs: jsonValue(checkpoint.sourceRefs),
    runId: checkpoint.runId,
    workItemId: checkpoint.workItemId,
    attemptId: checkpoint.attemptId,
    sequence: checkpoint.sequence,
    workflowVersion: checkpoint.workflowVersion,
    workflowRef: checkpoint.workflowRef ?? null,
    stateHash: checkpoint.stateHash,
    sourceEventRefs: jsonValue(checkpoint.sourceEventRefs),
    status: checkpoint.status,
    rawJson: jsonValue(checkpoint)
  };
}

function rowToReplayCheckpoint(row: typeof replayCheckpoints.$inferSelect): ReplayCheckpoint {
  const checkpoint = replayCheckpointSchema.parse(JSON.parse(row.rawJson));
  if (
    checkpoint.id !== row.id ||
    checkpoint.runId !== row.runId ||
    checkpoint.workItemId !== row.workItemId ||
    checkpoint.attemptId !== row.attemptId ||
    checkpoint.sequence !== row.sequence ||
    checkpoint.workflowVersion !== row.workflowVersion ||
    (checkpoint.workflowRef ?? null) !== row.workflowRef ||
    checkpoint.stateHash !== row.stateHash ||
    JSON.stringify(checkpoint.sourceEventRefs) !== row.sourceEventRefs ||
    checkpoint.status !== row.status
  ) {
    throw new Error(`Replay checkpoint persistence identity/version mismatch: ${row.id}`);
  }
  assertScopeConsistency("Replay checkpoint row", [checkpoint, { id: row.id, scope: scopeFromRow(row) }]);
  return checkpoint;
}

function universalAuditEventToInsert(event: AuditEvent): UniversalAuditEventInsert {
  return {
    ...scopeColumns(event.scope),
    id: event.id,
    schemaVersion: event.schemaVersion,
    createdBy: event.createdBy,
    createdAt: event.createdAt,
    updatedAt: event.updatedAt,
    sourceRefs: jsonValue(event.sourceRefs),
    runId: event.runId,
    attemptId: event.attemptId,
    receiptRef: event.receiptRef ?? null,
    sequence: event.sequence,
    eventType: event.eventType,
    actorRef: event.actorRef,
    subjectRef: event.subjectRef,
    idempotencyKey: event.idempotencyKey,
    occurredAt: event.occurredAt,
    payload: jsonValue(event.payload),
    rawJson: jsonValue(event)
  };
}

function rowToUniversalAuditEvent(row: typeof universalAuditEvents.$inferSelect): AuditEvent {
  const event = auditEventSchema.parse(JSON.parse(row.rawJson));
  if (
    event.id !== row.id ||
    event.runId !== row.runId ||
    event.attemptId !== row.attemptId ||
    (event.receiptRef ?? null) !== row.receiptRef ||
    event.sequence !== row.sequence ||
    event.eventType !== row.eventType ||
    event.actorRef !== row.actorRef ||
    event.subjectRef !== row.subjectRef ||
    event.idempotencyKey !== row.idempotencyKey ||
    event.occurredAt !== normalizePersistedUtcTimestamp(row.occurredAt) ||
    jsonValue(event.payload) !== row.payload
  ) {
    throw new Error(`Universal Audit persistence identity/version mismatch: ${row.id}`);
  }
  assertScopeConsistency("Universal Audit row", [event, { id: row.id, scope: scopeFromRow(row) }]);
  return event;
}

function metricDefinitionToInsert(definition: MetricDefinition): MetricDefinitionInsert {
  return {
    ...scopeColumns(definition.scope),
    id: definition.id,
    schemaVersion: definition.schemaVersion,
    createdBy: definition.createdBy,
    createdAt: definition.createdAt,
    updatedAt: definition.updatedAt,
    sourceRefs: jsonValue(definition.sourceRefs),
    metricKey: definition.metricKey,
    name: definition.name,
    description: definition.description,
    unit: definition.unit,
    aggregation: definition.aggregation,
    numerator: definition.numerator ?? null,
    denominator: definition.denominator ?? null,
    timeWindow: definition.timeWindow,
    definitionVersion: definition.definitionVersion,
    sourceEventTypes: jsonValue(definition.sourceEventTypes),
    privacyPolicy: jsonValue(definition.privacyPolicy),
    status: definition.status,
    rawJson: jsonValue(definition)
  };
}

function rowToMetricDefinition(row: typeof metricDefinitionsTable.$inferSelect): MetricDefinition {
  const definition = metricDefinitionSchema.parse(JSON.parse(row.rawJson));
  if (definition.id !== row.id) {
    throw new Error(`Metric definition row identity mismatch: ${row.id}`);
  }
  assertScopeConsistency("Metric definition row", [
    definition,
    { id: row.id, scope: scopeFromRow(row) }
  ]);
  return definition;
}

function metricObservationToInsert(observation: MetricObservation): MetricObservationInsert {
  return {
    ...scopeColumns(observation.scope),
    id: observation.id,
    projectId: observation.projectId,
    schemaVersion: observation.schemaVersion,
    createdBy: observation.createdBy,
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
    sourceRefs: jsonValue(observation.sourceRefs),
    definitionRef: observation.definitionRef,
    metricKey: observation.metricKey,
    aggregation: observation.aggregation ?? null,
    subjectRef: observation.subjectRef ?? null,
    value: observation.value,
    unit: observation.unit,
    numerator: observation.numerator ?? null,
    denominator: observation.denominator ?? null,
    periodStart: observation.periodStart,
    periodEnd: observation.periodEnd,
    definitionVersion: observation.definitionVersion,
    sourceEventRefs: jsonValue(observation.sourceEventRefs),
    evidenceRefs: jsonValue(observation.evidenceRefs),
    cohort: observation.cohort ?? null,
    observedAt: observation.observedAt,
    confidence: observation.confidence,
    status: observation.status,
    rawJson: jsonValue(observation)
  };
}

function rowToMetricObservation(row: typeof metricObservationsTable.$inferSelect): MetricObservation {
  const observation = metricObservationSchema.parse(JSON.parse(row.rawJson));
  if (observation.id !== row.id) {
    throw new Error(`Metric observation row identity mismatch: ${row.id}`);
  }
  if (observation.projectId !== row.projectId) {
    throw new Error(`Metric observation project identity mismatch: ${row.id}`);
  }
  assertScopeConsistency("Metric observation row", [
    observation,
    { id: row.id, scope: scopeFromRow(row) }
  ]);
  return observation;
}

export interface ReceiptPersistenceRelations {
  validations?: readonly ReceiptValidation[];
  evidences?: readonly UniversalEvidence[];
  metricDefinitions?: readonly MetricDefinition[];
  metricObservations?: readonly MetricObservation[];
}

export interface EvidenceReceiptMetricsPersistenceInput extends ReceiptPersistenceRelations {
  evidences: readonly UniversalEvidence[];
  receipt: TaskReceipt;
  metricDefinitions: readonly MetricDefinition[];
  metricObservations: readonly MetricObservation[];
}

function uniqueIds(label: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must contain unique IDs`);
}

function assertReceiptRelations(
  receipt: TaskReceipt,
  relations: ReceiptPersistenceRelations
): void {
  const validations = receiptValidationSchema.array().parse(relations.validations ?? []);
  const evidences = evidenceSchema.array().parse(relations.evidences ?? []);
  const definitions = metricDefinitionSchema.array().parse(relations.metricDefinitions ?? []);
  const observations = metricObservationSchema.array().parse(relations.metricObservations ?? []);

  assertScopeConsistency("Receipt persistence", [receipt, ...validations, ...evidences, ...definitions, ...observations]);
  uniqueIds("Receipt evidenceRefs", receipt.evidenceRefs);
  uniqueIds("Receipt validationRefs", receipt.validationRefs);
  uniqueIds("Receipt metricObservationRefs", receipt.metricObservationRefs);

  const evidenceById = new Map(evidences.map((record) => [record.id, record]));
  const validationById = new Map(validations.map((record) => [record.id, record]));
  const observationById = new Map(observations.map((record) => [record.id, record]));
  if (evidenceById.size !== evidences.length || validationById.size !== validations.length) {
    throw new Error("Receipt persistence relations must have unique IDs");
  }
  if (observationById.size !== observations.length || new Map(definitions.map((record) => [record.id, record])).size !== definitions.length) {
    throw new Error("Receipt metric relations must have unique IDs");
  }

  for (const evidenceRef of receipt.evidenceRefs) {
    if (!evidenceById.has(evidenceRef)) {
      throw new Error(`Receipt references missing Evidence ${evidenceRef}`);
    }
  }
  for (const validationRef of receipt.validationRefs) {
    const validation = validationById.get(validationRef);
    if (!validation || validation.receiptRef !== receipt.id) {
      throw new Error(`Receipt references missing or mismatched Validation ${validationRef}`);
    }
    if (validation.evidenceRefs.some((evidenceRef) => !evidenceById.has(evidenceRef))) {
      throw new Error(`Validation ${validation.id} references missing Evidence`);
    }
  }
  if (receipt.metricObservationRefs.length > 0) {
    for (const observationRef of receipt.metricObservationRefs) {
      const observation = observationById.get(observationRef);
      if (!observation) {
        throw new Error(`Receipt references missing MetricObservation ${observationRef}`);
      }
      if (observation.evidenceRefs.some((evidenceRef) => !receipt.evidenceRefs.includes(evidenceRef))) {
        throw new Error(`MetricObservation ${observation.id} references evidence outside the Receipt`);
      }
    }
    assertMetricDefinitionRegistryConsistency({ definitions, observations });
  } else if (observations.length > 0) {
    throw new Error("Metric observations supplied without Receipt metricObservationRefs");
  }

  if (receipt.resultStatus === "VERIFIED_SUCCESS") {
    assertReceiptEvidenceChain({ receipt, validations, evidences });
  }
}

/** Estimated USD cost for a token count (opt-in via env, audit R1 计费数据积累). */
function estimateCostUsd(totalTokens: number): number | null {
  const perMillion = Number(process.env.NEUROCLAW_AI_COST_USD_PER_1M_TOKENS);
  if (!Number.isFinite(perMillion) || perMillion <= 0) return null;
  return Math.round((totalTokens / 1_000_000) * perMillion * 1e6) / 1e6;
}

// ---------------------------------------------------------------------------
// ControlPlaneService
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Team playbooks — server-side relay orchestration registry (J5)
// ---------------------------------------------------------------------------

export interface TeamStep {
  templateType: string;
  roleKey: string;
  feedFrom: string[];
}

export const TEAM_PLAYBOOKS: Record<string, TeamStep[]> = {
  sprint: [
    { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
    {
      templateType: "private_conversion",
      roleKey: "conversion",
      feedFrom: ["contentAngles", "channelRecommendations"]
    },
    { templateType: "weekly_review", roleKey: "review", feedFrom: ["conversionDraft"] }
  ],
  contentReview: [
    { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
    { templateType: "weekly_review", roleKey: "review", feedFrom: ["contentAngles"] }
  ]
};

function carriedSummary(payload: Record<string, unknown>, feedFrom: string[]): string {
  return feedFrom
    .map((field) => {
      const value = payload[field];
      if (Array.isArray(value)) return value.join("; ");
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// W3 · simulation project-integration HTTP surface (design B1 §W3).
// ---------------------------------------------------------------------------

/**
 * Route-level constant for the integration contract version. Intentionally not
 * sourced from `compatibilityRange` — true semver evaluation is P-1 scope;
 * this value only pins the response shape so P-1 can swap it later.
 */
export const INTEGRATION_CONTRACT_VERSION = "1.0.0";

/** Summary row for `GET /api/integration/projects`. */
export interface SimulationIntegrationSummary {
  projectKey: string;
  projectId: string;
  packId: string;
  packVersion: string;
  typeKey: string;
  status: string;
}

/**
 * Adapter projection with the hard-coded fixture health constants removed:
 * `readiness` is the constant "READY" and `evidenceAt` a fixed timestamp, so
 * neither may be exposed as a health signal (B1 §W3 hard requirement 2).
 */
export type SimulationAdapterInputView = Omit<SimulationAdapterInput, "readiness" | "evidenceAt">;

export interface SimulationIntegrationRecord {
  summary: SimulationIntegrationSummary;
  bundle: SimulationProjectIntegrationBundle;
  adapterInput: SimulationAdapterInputView;
}

function stripAdapterHealthFields(input: SimulationAdapterInput): SimulationAdapterInputView {
  const { readiness: _readiness, evidenceAt: _evidenceAt, ...view } = input;
  return view;
}

export const REGISTRY_CONTRACT_VERSION = "1.0.0";

export class RegistryConflictError extends Error {
  readonly code = "REGISTRY_CONFLICT";

  constructor(message = "registry identity already exists") {
    super(message);
    this.name = "RegistryConflictError";
  }
}

const registryDisplayNameSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes("AdapterManifest"), "name must not reference internal AdapterManifest");

export const registryPackPersistRequestSchema = z
  .object({
    pack: z
      .object({
        packId: z.string().min(1),
        version: z.string().min(1),
        name: registryDisplayNameSchema.optional(),
        projectId: z.string().min(1).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const registryAdapterPersistRequestSchema = z
  .object({
    adapter: z
      .object({
        adapterId: z.string().min(1),
        packId: z.string().min(1),
        packVersion: z.string().min(1),
        name: registryDisplayNameSchema,
        simulationOnly: z.literal(true),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const registrySimulateRequestSchema = z
  .object({
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

export type RegistrySourceMode = "db" | "fixture" | "dual";

export interface RegistryCoverageReport {
  pilotProjectsCovered: string;
  packVersionsMatchFixtures: boolean;
  source: RegistrySourceMode;
}

export interface RegistryListResponse<T> {
  items: T[];
  source?: RegistrySourceMode;
}

export interface RegistryProjectAggregate<T> {
  projectId: string;
  packs: T[];
}

export class ControlPlaneService {
  readonly db: Database;
  private readonly memoryStore: MemoryStore;
  private readonly traceLog: TraceLog;
  private readonly temporalWorker: TemporalWorkerSkeleton;
  /** FIFO cache for materialized registry packs (keyed by projectKey). */
  private readonly registryPackCache = new Map<string, unknown>();
  private readonly registryCacheMax = Number(process.env.NEUROCLAW_REGISTRY_CACHE_MAX ?? 500);
  /**
   * durable = true decouples Run execution from HTTP requests
   * (202 + background job loop); inline keeps legacy behavior for unit tests.
   * (Round J, audit P0-C1)
   */
  readonly durable: boolean;
  /** Merged registry: builtin employees + DB-backed custom agents. */
  readonly registry = globalRegistry;

  private constructor(
    temporalWorker: TemporalWorkerSkeleton,
    db: Database,
    options: { durable?: boolean; memoryStore?: MemoryStore; traceLog?: TraceLog } = {}
  ) {
    this.temporalWorker = temporalWorker;
    this.db = db;
    this.durable = options.durable ?? false;
    this.memoryStore = options.memoryStore ?? new DrizzleMemoryStore(db);
    this.traceLog = options.traceLog ?? getTraceLog();
  }

  static async create(
    temporalWorker?: TemporalWorkerSkeleton,
    db?: Database,
    memoryStore?: MemoryStore,
    traceLog?: TraceLog,
    options: { durable?: boolean } = {}
  ): Promise<ControlPlaneService> {
    // Honor DATABASE_URL when no explicit db is provided (Round N fix: the
    // previous default always used an in-memory database, so a configured
    // persistent URL was silently ignored outside tests).
    const database = db ?? (await createDb());

    // Load custom agents into the merged registry BEFORE the worker boots.
    const service = new ControlPlaneService(
      temporalWorker ?? new TemporalWorkerSkeleton(database),
      database,
      { durable: options.durable, memoryStore, traceLog }
    );
    await service.loadCustomAgents();
    return service;
  }

  /** Load custom agents from the agents table into the global registry. */
  async loadCustomAgents(): Promise<number> {
    const rows = await this.db.select().from(agents);
    for (const row of rows) {
      if (row.status === "inactive") continue;
      globalRegistry.register(this.agentRowToTemplate(row));
    }
    return rows.length;
  }

  private agentRowToTemplate(row: typeof agents.$inferSelect): Template {
    const base = builtinRegistry.get(row.baseEngine);
    let focusAreas: string[] = [];
    try {
      focusAreas = row.focusAreas ? (JSON.parse(row.focusAreas) as string[]) : [];
    } catch {
      focusAreas = [];
    }
    const description = [row.description ?? "", focusAreas.length ? `Focus: ${focusAreas.join(", ")}` : ""]
      .filter(Boolean)
      .join(" · ");

    return {
      ...(base ?? listBuiltinTemplates()[0]),
      id: `agt_${row.slug}`,
      type: row.slug,
      name: row.name,
      version: "1.0.0",
      status: row.status === "inactive" ? "inactive" : "active",
      description,
      persona: row.persona,
      baseEngine: row.baseEngine
    };
  }

  async createAgent(input: CreateAgentInput): Promise<Template> {
    const existing = await this.db.select().from(agents).where(eq(agents.slug, input.slug));
    if (existing.length > 0) {
      throw new Error(`Agent slug already exists: ${input.slug}`);
    }

    const row = {
      id: `agent_${randomUUID()}`,
      slug: input.slug,
      name: input.name,
      baseEngine: input.baseEngine,
      persona: input.persona,
      description: input.description ?? null,
      focusAreas: JSON.stringify(input.focusAreas ?? []),
      outputStyle: input.outputStyle ?? "structured",
      toolNames: JSON.stringify(input.toolNames ?? []),
      status: "active" as const,
      createdAt: new Date().toISOString()
    };

    await this.db.insert(agents).values(row);

    const template = this.agentRowToTemplate(row);
    globalRegistry.register(template);

    this.traceLog.record({
      scope: "control-plane",
      action: "create_agent",
      metadata: { slug: input.slug }
    });
    return template;
  }

  async listAgents() {
    const rows = await this.db.select().from(agents).orderBy(desc(agents.createdAt));
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      baseEngine: row.baseEngine,
      persona: row.persona,
      description: row.description ?? "",
      outputStyle: row.outputStyle,
      status: row.status,
      createdAt: row.createdAt
    }));
  }

  async updateAgentStatus(agentId: string, status: "active" | "inactive"): Promise<void> {
    await this.updateAgent(agentId, { status });
  }

  /** J7: edit custom agents (name/persona/description/focus/status), sync registry */
  async updateAgent(agentId: string, patch: UpdateAgentInput): Promise<void> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId));
    if (rows.length === 0) {
      throw new NotFoundError(`Agent not found: ${agentId}`);
    }
    const row = rows[0];
    const next = {
      ...row,
      name: patch.name ?? row.name,
      persona: patch.persona ?? row.persona,
      description: patch.description ?? row.description,
      focusAreas: patch.focusAreas ? JSON.stringify(patch.focusAreas) : row.focusAreas,
      status: patch.status ?? (row.status as "active" | "inactive")
    };

    await this.db
      .update(agents)
      .set({
        name: next.name,
        persona: next.persona,
        description: next.description,
        focusAreas: next.focusAreas,
        status: next.status
      })
      .where(eq(agents.id, agentId));

    if (next.status === "inactive") {
      globalRegistry.unregister(row.slug);
    } else {
      globalRegistry.register(
        this.agentRowToTemplate({ ...next, description: next.description ?? null })
      );
    }
  }

  /**
   * Release all resources held by the service: stop the temporal worker,
   * close the database connection. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this.traceLog.record({
      scope: "control-plane",
      action: "shutdown"
    });
    await this.temporalWorker.shutdown();
    await closeDatabase(this.db);
  }

  async createWorkspace(input: CreateWorkspaceInput, ownerId?: string): Promise<Workspace> {
    const span = this.traceLog.startSpan("control-plane", "createWorkspace", {
      plan: input.plan
    });
    try {
      if (!input.name.trim()) {
        throw new Error("Workspace name is required");
      }

      const workspace: Workspace = {
        id: `ws_${randomUUID()}`,
        name: input.name,
        plan: input.plan,
        createdAt: new Date().toISOString()
      };

      await this.db.insert(workspaces).values({
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        createdAt: workspace.createdAt
      });

      // Seed the creating user as workspace admin (multi-tenant ACL baseline).
      if (ownerId) {
        await this.addWorkspaceMember(workspace.id, ownerId, "admin");
      }

      await this.ensureSubscription(workspace.id);
      await this.recordProductEvent(workspace.id, ownerId ?? null, "workspace.created", {
        plan: input.plan
      });

      this.traceLog.record({
        scope: "control-plane",
        action: "create_workspace",
        metadata: {
          workspaceId: workspace.id
        }
      });

      span.setAttribute("workspaceId", workspace.id);
      return workspace;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  // -------------------------------------------------------------------------
  // Workspace membership ACL (Round J, audit P0-C4 IDOR fix)
  // -------------------------------------------------------------------------

  async addWorkspaceMember(workspaceId: string, userId: string, role: "admin" | "operator" | "viewer"): Promise<void> {
    await this.db.insert(workspaceMembers).values({
      id: `wsm_${randomUUID()}`,
      workspaceId,
      userId,
      role,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * Membership check with legacy-bootstrap rule: a workspace that has no
   * member rows at all is accessible to any authenticated caller (pre-ACL
   * databases), but once membership exists access is strictly scoped.
   */
  async isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: workspaceMembers.id })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    if (rows.length > 0) return true;

    const total = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, workspaceId));
    return (total[0]?.count ?? 0) === 0;
  }

  // -------------------------------------------------------------------------
  // Billing & usage quotas (Round K, audit P0-B3)
  // -------------------------------------------------------------------------

  /** Auto-provision a trial subscription when none exists (no-card baseline). */
  async ensureSubscription(workspaceId: string): Promise<typeof subscriptions.$inferSelect> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId));
    if (rows.length > 0) return rows[0];

    const row = {
      id: `sub_${randomUUID()}`,
      workspaceId,
      plan: "starter" as WorkspacePlan,
      status: "trialing",
      monthlyRunQuota: TRIAL_MONTHLY_RUN_QUOTA,
      startedAt: new Date().toISOString(),
      renewsAt: null,
      cancelledAt: null
    };
    await this.db.insert(subscriptions).values(row);
    return row;
  }

  private async currentUsageRow(
    workspaceId: string,
    month = currentMonth()
  ): Promise<typeof usageCounters.$inferSelect | null> {
    const rows = await this.db
      .select()
      .from(usageCounters)
      .where(and(eq(usageCounters.workspaceId, workspaceId), eq(usageCounters.month, month)));
    return rows[0] ?? null;
  }

  /** Atomic upsert-increment; concurrent creates never lose counts. */
  private async incrementUsage(
    workspaceId: string,
    delta: { runsCreated?: number; runsCompleted?: number; tokens?: number }
  ): Promise<void> {
    const runsCreated = delta.runsCreated ?? 0;
    const runsCompleted = delta.runsCompleted ?? 0;
    const tokens = delta.tokens ?? 0;
    await this.db
      .insert(usageCounters)
      .values({
        id: `usg_${randomUUID()}`,
        workspaceId,
        month: currentMonth(),
        runsCreated,
        runsCompleted,
        tokensUsed: tokens
      })
      .onConflictDoUpdate({
        target: [usageCounters.workspaceId, usageCounters.month],
        set: {
          runsCreated: sql`${usageCounters.runsCreated} + ${runsCreated}`,
          runsCompleted: sql`${usageCounters.runsCompleted} + ${runsCompleted}`,
          tokensUsed: sql`${usageCounters.tokensUsed} + ${tokens}`
        }
      });
  }

  /** Quota gate before run creation; throws QuotaExceededError (402). */
  async checkRunQuota(workspaceId: string): Promise<void> {
    const subscription = await this.ensureSubscription(workspaceId);
    if (subscription.monthlyRunQuota === 0) return; // unlimited
    const usage = await this.currentUsageRow(workspaceId);
    const used = usage?.runsCreated ?? 0;
    if (used >= subscription.monthlyRunQuota) {
      throw new QuotaExceededError(
        `Monthly run quota exceeded for plan '${subscription.plan}' (${used}/${subscription.monthlyRunQuota}). Upgrade the plan or wait for the next cycle.`,
        "QUOTA_EXCEEDED",
        {
          plan: subscription.status === "trialing" ? "trial" : (subscription.plan as WorkspacePlan),
          quota: subscription.monthlyRunQuota,
          used
        }
      );
    }
  }

  async getBillingSummary(workspaceId: string) {
    const subscription = await this.ensureSubscription(workspaceId);
    const usage = (await this.currentUsageRow(workspaceId)) ?? {
      month: currentMonth(),
      runsCreated: 0,
      runsCompleted: 0,
      tokensUsed: 0
    };
    const unlimited = subscription.monthlyRunQuota === 0;
    return {
      plan: subscription.plan,
      status: subscription.status,
      monthlyRunQuota: subscription.monthlyRunQuota,
      startedAt: subscription.startedAt,
      renewsAt: subscription.renewsAt ?? undefined,
      usage: {
        month: usage.month,
        runsCreated: usage.runsCreated,
        runsCompleted: usage.runsCompleted,
        tokensUsed: usage.tokensUsed,
        quotaRemaining: unlimited ? null : Math.max(0, subscription.monthlyRunQuota - usage.runsCreated)
      }
    };
  }

  /**
   * Switch plan. Real payment gateway stays reserved — this carries the
   * manual-provisioning semantic until checkout ships (audit R1-D).
   */
  async changePlan(workspaceId: string, plan: WorkspacePlan): Promise<void> {
    const existing = await this.ensureSubscription(workspaceId);
    await this.db
      .update(subscriptions)
      .set({
        plan,
        status: "active",
        monthlyRunQuota: planMonthlyRunQuota[plan],
        renewsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        cancelledAt: null
      })
      .where(eq(subscriptions.id, existing.id));

    await this.recordProductEvent(workspaceId, null, "subscription.plan_changed", {
      from: existing.plan,
      to: plan
    });
    this.traceLog.record({
      scope: "control-plane",
      action: "billing_plan_changed",
      metadata: { workspaceId, from: existing.plan, to: plan }
    });
  }

  async recordProductEvent(
    workspaceId: string | null,
    userId: string | null,
    eventType: string,
    payload?: Record<string, unknown>
  ): Promise<void> {
    await this.db.insert(productEvents).values({
      id: `evt_${randomUUID()}`,
      workspaceId,
      userId,
      eventType,
      payload: payload ? JSON.stringify(payload) : null,
      createdAt: new Date().toISOString()
    });
  }

  // -------------------------------------------------------------------------
  // Universal kernel Outbox (AC-1-1)
  // -------------------------------------------------------------------------

  /**
   * Validate and persist one universal event in a local transaction. The
   * database unique constraint is the authoritative duplicate guard; a
   * repeated request returns the existing event without a second business
   * effect. Product analytics remains on recordProductEvent for compatibility.
   *
   * Scope note (W1a): this is the *delivery* Outbox — it owns the mutable
   * `status` lifecycle (PENDING → PROCESSING → COMPLETED/FAILED) that the
   * dispatcher drives. The runtime step-event stream is NOT routed through it
   * any more; it lives in the append-only `run_events` log. Retained here
   * because the delivery path still needs the transition + idempotency
   * semantics that `run_events` deliberately does not have.
   */
  async enqueueOutboxEvent(input: OutboxEventInput): Promise<EnqueueOutboxEventResult> {
    const event = outboxEventSchema.parse(input);
    if (event.status !== "PENDING") {
      throw new Error("New Outbox events must start in PENDING status");
    }
    const now = new Date().toISOString();

    return this.db.transaction((tx) => this.persistOutboxEventInTx(tx, event, now));
  }

  /**
   * Shared insert/read-back body of the Outbox enqueue, callable inside a
   * caller-owned transaction so an event can commit atomically with its source
   * write (W2 §2.5). The database unique constraint is the authoritative
   * duplicate guard; the identity snapshot compare rejects a key reused for a
   * different envelope.
   */
  private async persistOutboxEventInTx(
    tx: DbTransaction,
    event: OutboxEvent,
    now: string
  ): Promise<EnqueueOutboxEventResult> {
    const insertedRows = await tx
      .insert(outboxEvents)
      .values(outboxEventToInsert(event, now))
      .onConflictDoNothing({
        target: [outboxEvents.idempotencyScope, outboxEvents.idempotencyKey]
      })
      .returning({ eventId: outboxEvents.eventId });

    const persistedRows = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.idempotencyScope, event.idempotencyScope),
          eq(outboxEvents.idempotencyKey, event.idempotencyKey)
        )
      )
      .limit(1);
    const persisted = persistedRows[0];
    if (!persisted) {
      throw new Error("Outbox insert did not produce a readable event");
    }

    const storedEvent = rowToOutboxEvent(persisted);
    if (outboxIdentitySnapshot(storedEvent) !== outboxIdentitySnapshot(event)) {
      throw new IdempotencyConflictError(
        `Idempotency key '${event.idempotencyScope}:${event.idempotencyKey}' is already bound to a different event`
      );
    }

    return {
      event: storedEvent,
      inserted: insertedRows.length > 0,
      eventId: storedEvent.eventId,
      status: storedEvent.status
    };
  }

  /**
   * W2 §2.5: enqueue one adapter-produced delivery intent **inside the
   * caller's transaction** — the same transaction that writes the `runs`
   * projection — so a run write can never commit without its delivery intent,
   * and a failing enqueue never leaves a half-written outcome. Use
   * `persistRunProjection` (the only caller); there is deliberately no
   * non-transactional overload.
   *
   * Identity semantics (`outbox.delivery.v1`): the intent itself is the
   * payload identity. Re-enqueueing the same intent (a retried or resumed job
   * re-emitting the same step outcome) returns the existing event, while the
   * same idempotency key bound to a *different* intent is a conflict that
   * fails the whole transaction — `enqueueOutboxEvent`'s same-key-different-
   * payload guard at intent granularity (a retry's fresh envelope timestamps
   * are audit metadata, not identity).
   */
  async enqueueDeliveryIntentInTx(
    tx: DbTransaction,
    input: { run: Run; intent: OutboxDeliveryIntent }
  ): Promise<EnqueueOutboxEventResult> {
    const intent = outboxDeliveryIntentSchema.parse(input.intent);
    const existingRows = await tx
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.idempotencyScope, OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE),
          eq(outboxEvents.idempotencyKey, intent.idempotencyKey)
        )
      )
      .limit(1);
    if (existingRows[0]) {
      const stored = rowToOutboxEvent(existingRows[0]);
      const storedIntent = storedDeliveryIntent(stored);
      if (!storedIntent || canonicalJson(storedIntent) !== canonicalJson(intent)) {
        throw new IdempotencyConflictError(
          `Idempotency key '${OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE}:${intent.idempotencyKey}' is already bound to a different delivery intent`
        );
      }
      return { event: stored, inserted: false, eventId: stored.eventId, status: stored.status };
    }

    // Fresh envelope; the timestamp is canonicalized so the insert read-back
    // snapshot compare cannot trip on the `.000Z` normalization edge.
    const now = normalizePersistedUtcTimestamp(new Date().toISOString());
    const event = outboxEventSchema.parse({
      eventId: `evt_outbox_delivery_${input.run.id}_${sha256Hex(intent.idempotencyKey).slice(0, 12)}`,
      schemaVersion: "1.0",
      eventType: "growth.outbox.delivery_intent_recorded",
      occurredAt: now,
      emittedAt: now,
      scope: { workspaceId: input.run.workspaceId },
      actorRef: RUNTIME_EVENT_ACTOR_REF,
      subjectRef: input.run.id,
      correlationId: input.run.id,
      idempotencyKey: intent.idempotencyKey,
      idempotencyScope: OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
      traceId: `trace_${input.run.id}`,
      dataClass: "OPERATIONAL",
      payload: { deliveryIntent: intent },
      status: "PENDING"
    });
    return this.persistOutboxEventInTx(tx, event, now);
  }

  /**
   * W2 §2.5: read the adapter-recorded delivery intents out of a run's step
   * results. The runtime notification adapter (intent mode) embeds the intent
   * at `stepResult.payload.deliveryIntent`; anything that fails the strict
   * `outbox.delivery.v1` schema is traced and skipped. A malformed payload
   * must never block the run projection write, and it must never be enqueued
   * half-validated either.
   */
  private collectRunDeliveryIntents(run: Run): OutboxDeliveryIntent[] {
    const intents: OutboxDeliveryIntent[] = [];
    for (const step of run.stepResults ?? []) {
      const candidate = step.payload?.deliveryIntent;
      if (candidate === undefined) continue;
      const parsed = outboxDeliveryIntentSchema.safeParse(candidate);
      if (!parsed.success) {
        this.traceLog.record({
          scope: "control-plane",
          action: "outbox_delivery_intent_skipped",
          metadata: {
            runId: run.id,
            stepId: step.stepId,
            reason: parsed.error.issues.map((issue) => issue.message).join("; ")
          }
        });
        continue;
      }
      intents.push(parsed.data);
    }
    return intents;
  }

  /**
   * W2 §2.5: the single transactional write path for the `runs` projection.
   *
   * `insert` writes a brand-new row (inline `createRun`), `update` rewrites an
   * existing one (durable job loop, inline approval resume). When the outbox
   * kill switch is ON, every delivery intent carried in `run.stepResults` is
   * enqueued **inside the same transaction**: the run projection can never
   * commit without its delivery intent, and a failing enqueue (e.g. an
   * idempotency key already bound to a different intent) rolls the projection
   * write back with it — closing the A4 double-write window.
   *
   * Switch OFF (the default, `NEUROCLAW_OUTBOX_DISPATCH_ENABLED !== "1"`) keeps
   * the previous behavior byte-for-byte: the row is written and nothing else
   * happens.
   */
  async persistRunProjection(run: Run, mode: "insert" | "update"): Promise<void> {
    const { enabled } = resolveOutboxDispatchConfig();
    await this.db.transaction(async (tx) => {
      if (mode === "insert") {
        await tx.insert(runs).values(runToInsert(run));
      } else {
        await tx.update(runs).set(runToInsert(run)).where(eq(runs.id, run.id));
      }

      if (!enabled) return;

      for (const intent of this.collectRunDeliveryIntents(run)) {
        await this.enqueueDeliveryIntentInTx(tx, { run, intent });
      }
    });
  }

  /**
   * Apply only the executable Outbox status transitions defined by the shared
   * contract. Envelope identity and payload remain immutable.
   */
  async transitionOutboxEvent(
    eventId: string,
    status: OutboxEventStatus
  ): Promise<OutboxEvent> {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.eventId, eventId))
        .limit(1);
      const currentRow = rows[0];
      if (!currentRow) {
        throw new NotFoundError(`Outbox event not found: ${eventId}`);
      }

      const current = rowToOutboxEvent(currentRow);
      const next = outboxEventSchema.parse({ ...current, status });
      assertOutboxEventTransition(current, next);
      const updatedRows = await tx
        .update(outboxEvents)
        .set({ status: next.status, updatedAt: new Date().toISOString() })
        .where(eq(outboxEvents.eventId, eventId))
        .returning();
      const updated = updatedRows[0];
      if (!updated) {
        throw new Error(`Outbox event update lost event: ${eventId}`);
      }
      return rowToOutboxEvent(updated);
    });
  }

  // -------------------------------------------------------------------------
  // AC-1-2 Evidence / Receipt / Metric foundation
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // AC-2-0 immutable WorkflowDefinition foundation
  // -------------------------------------------------------------------------

  /**
   * Persist one validated workflow snapshot. The identity/version pair is
   * insert-only: the database unique index is the final race-safe guard and
   * this method never converts a conflict into an update.
   */
  async persistWorkflowDefinition(
    input:
      | WorkflowDefinition
      | { workflowDefinition: WorkflowDefinition; pack?: ProjectPackManifest },
    options: WorkflowDefinitionPersistenceOptions = {}
  ): Promise<WorkflowDefinition> {
    const workflow = workflowDefinitionSchema.parse(
      "workflowDefinition" in input ? input.workflowDefinition : input
    );
    const pack =
      "workflowDefinition" in input
        ? input.pack ?? packFromWorkflowOptions(options)
        : packFromWorkflowOptions(options);
    assertPersistableWorkflowDefinition(workflow, pack);

    const existing = await this.db
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.workflowDefinitionId, workflow.id),
          eq(workflowDefinitions.version, workflow.version)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      throw new Error(
        `WorkflowDefinition ${workflow.id}@${workflow.version} already exists and is immutable`
      );
    }

    await this.db.insert(workflowDefinitions).values(workflowDefinitionToInsert(workflow));
    return workflow;
  }

  async writeWorkflowDefinition(
    input:
      | WorkflowDefinition
      | { workflowDefinition: WorkflowDefinition; pack?: ProjectPackManifest },
    options: WorkflowDefinitionPersistenceOptions = {}
  ): Promise<WorkflowDefinition> {
    return this.persistWorkflowDefinition(input, options);
  }

  async saveWorkflowDefinition(
    input:
      | WorkflowDefinition
      | { workflowDefinition: WorkflowDefinition; pack?: ProjectPackManifest },
    options: WorkflowDefinitionPersistenceOptions = {}
  ): Promise<WorkflowDefinition> {
    return this.persistWorkflowDefinition(input, options);
  }

  async getWorkflowDefinition(
    workflowDefinitionId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<WorkflowDefinition | undefined> {
    const rows = await this.db
      .select()
      .from(workflowDefinitions)
      .where(
        and(
          eq(workflowDefinitions.workflowDefinitionId, workflowDefinitionId),
          eq(workflowDefinitions.version, version)
        )
      )
      .limit(1);
    const workflow = rows[0] ? rowToWorkflowDefinition(rows[0]) : undefined;
    if (workflow) assertExpectedScope("WorkflowDefinition read", workflow, expectedScope);
    return workflow;
  }

  async readWorkflowDefinition(
    workflowDefinitionId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<WorkflowDefinition | undefined> {
    return this.getWorkflowDefinition(workflowDefinitionId, version, expectedScope);
  }

  async listWorkflowDefinitions(scope?: UniversalScope): Promise<WorkflowDefinition[]> {
    const rows = await this.db
      .select()
      .from(workflowDefinitions)
      .orderBy(desc(workflowDefinitions.updatedAt));
    return rows
      .map(rowToWorkflowDefinition)
      .filter((workflow) => !scope || sameScope(workflow.scope, scope));
  }

  // -------------------------------------------------------------------------
  // AC-3-0 Project Pack / Adapter Registry
  // -------------------------------------------------------------------------

  /** Persist one immutable Pack manifest snapshot in the local registry. */
  async persistProjectPack(
    input: ProjectPackManifest,
    options: ProjectPackRegistryOptions = {}
  ): Promise<ProjectPackManifest> {
    const pack = projectPackManifestSchema.parse(input);
    const status = options.status ?? pack.status;
    if (status !== pack.status) {
      throw new Error("Project Pack registry status must match the manifest status");
    }
    assertProjectPackRegistryConsistency({
      pack,
      project: options.project,
      workflows: options.workflows,
      adapters: options.adapters,
      adapterSafety: Object.fromEntries(
        (options.adapters ?? []).map((adapter) => [
          adapter.adapterId,
          {
            policy: options.adapterSafety?.[adapter.adapterId]?.policy ?? options.policy,
            budget: options.adapterSafety?.[adapter.adapterId]?.budget ?? options.budget,
            approvals: options.adapterSafety?.[adapter.adapterId]?.approvals ?? options.approvals,
            revocation:
              options.adapterSafety?.[adapter.adapterId]?.revocation ?? options.revocation,
            killSwitch:
              options.adapterSafety?.[adapter.adapterId]?.killSwitch ?? options.killSwitch,
            actionRef:
              options.adapterSafety?.[adapter.adapterId]?.actionRef ??
              options.actionRef ??
              (adapter.controlledWriteBindings?.length === 1
                ? adapter.controlledWriteBindings[0]?.actionRef
                : undefined),
            resourceRef:
              options.adapterSafety?.[adapter.adapterId]?.resourceRef ??
              options.resourceRef ??
              (adapter.controlledWriteBindings?.length === 1
                ? adapter.controlledWriteBindings[0]?.resourceRef
                : undefined)
          }
        ])
      )
    });
    const now = new Date().toISOString();
    const entry = projectPackRegistryEntrySchema.parse({
      id: registryRowId("pack", pack.packId, pack.version),
      projectId: pack.projectId,
      packId: pack.packId,
      version: pack.version,
      scope: pack.scope,
      status,
      manifestSnapshot: pack,
      ...registrySecurityValues(options),
      createdAt: now,
      updatedAt: now
    });

    const existing = await this.db
      .select({ id: projectPackRegistry.id })
      .from(projectPackRegistry)
      .where(and(eq(projectPackRegistry.packId, pack.packId), eq(projectPackRegistry.version, pack.version)))
      .limit(1);
    if (existing.length > 0) {
      throw new Error(`Project Pack ${pack.packId}@${pack.version} already exists and is immutable`);
    }
    await this.db.insert(projectPackRegistry).values(packRegistryToInsert(entry));
    return pack;
  }

  async registerProjectPack(input: ProjectPackManifest, options: ProjectPackRegistryOptions = {}) {
    return this.persistProjectPack(input, options);
  }

  async writeProjectPack(input: ProjectPackManifest, options: ProjectPackRegistryOptions = {}) {
    return this.persistProjectPack(input, options);
  }

  async persistPack(input: ProjectPackManifest, options: ProjectPackRegistryOptions = {}) {
    return this.persistProjectPack(input, options);
  }

  async persistPackManifest(input: ProjectPackManifest, options: ProjectPackRegistryOptions = {}) {
    return this.persistProjectPack(input, options);
  }

  async registerPack(input: ProjectPackManifest, options: ProjectPackRegistryOptions = {}) {
    return this.persistProjectPack(input, options);
  }

  async getProjectPack(
    packId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<ProjectPackManifest | undefined> {
    const rows = await this.db
      .select()
      .from(projectPackRegistry)
      .where(and(eq(projectPackRegistry.packId, packId), eq(projectPackRegistry.version, version)))
      .limit(1);
    if (!rows[0]) return undefined;
    const entry = rowToProjectPackRegistryEntry(rows[0]);
    assertExpectedScope("Project Pack registry read", entry, expectedScope);
    return entry.manifestSnapshot;
  }

  async readProjectPack(packId: string, version: string, expectedScope?: UniversalScope) {
    return this.getProjectPack(packId, version, expectedScope);
  }

  async getProjectPackRegistryEntry(
    packId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<ProjectPackRegistryEntry | undefined> {
    const rows = await this.db
      .select()
      .from(projectPackRegistry)
      .where(and(eq(projectPackRegistry.packId, packId), eq(projectPackRegistry.version, version)))
      .limit(1);
    if (!rows[0]) return undefined;
    const entry = rowToProjectPackRegistryEntry(rows[0]);
    assertExpectedScope("Project Pack registry entry read", entry, expectedScope);
    return entry;
  }

  async readProjectPackRegistryEntry(packId: string, version: string, expectedScope?: UniversalScope) {
    return this.getProjectPackRegistryEntry(packId, version, expectedScope);
  }

  async getPack(packId: string, version: string, expectedScope?: UniversalScope) {
    return this.getProjectPack(packId, version, expectedScope);
  }

  async readPack(packId: string, version: string, expectedScope?: UniversalScope) {
    return this.getProjectPack(packId, version, expectedScope);
  }

  async listProjectPacks(scope?: UniversalScope): Promise<ProjectPackManifest[]> {
    const rows = await this.db.select().from(projectPackRegistry).orderBy(desc(projectPackRegistry.updatedAt));
    return rows
      .map(rowToProjectPackRegistryEntry)
      .filter((entry) => !scope || sameScope(entry.scope, scope))
      .map((entry) => entry.manifestSnapshot);
  }

  async listPacks(scope?: UniversalScope) {
    return this.listProjectPacks(scope);
  }

  async listProjectPackRegistryEntries(scope?: UniversalScope): Promise<ProjectPackRegistryEntry[]> {
    const rows = await this.db.select().from(projectPackRegistry).orderBy(desc(projectPackRegistry.updatedAt));
    return rows.map(rowToProjectPackRegistryEntry).filter((entry) => !scope || sameScope(entry.scope, scope));
  }

  /** Persist one immutable Adapter manifest snapshot bound to a Pack. */
  async persistAdapterManifest(
    input: AdapterManifest,
    options: AdapterRegistryOptions
  ): Promise<AdapterManifest> {
    const adapter = adapterManifestSchema.parse(input);
    const pack = projectPackManifestSchema.parse(options.pack);
    const registeredPackEntry = await this.getProjectPackRegistryEntry(pack.packId, pack.version);
    if (!registeredPackEntry) {
      throw new Error(
        `Adapter ${adapter.adapterId}@${adapter.version} cannot register without an exact local Pack project/version snapshot ${pack.packId}@${pack.version}`
      );
    }
    if (canonicalJson(registeredPackEntry.manifestSnapshot) !== canonicalJson(pack)) {
      throw new Error(
        `Adapter ${adapter.adapterId}@${adapter.version} Pack manifest snapshot does not match local registry ${pack.packId}@${pack.version}`
      );
    }
    if (
      registeredPackEntry.projectId !== pack.projectId ||
      !sameScope(registeredPackEntry.scope, adapter.scope) ||
      adapter.projectRef !== registeredPackEntry.projectId
    ) {
      throw new Error("Adapter Pack/project scope does not match the local Pack registry snapshot");
    }
    const registeredPack = registeredPackEntry.manifestSnapshot;
    const declaredBinding =
      adapter.controlledWriteBindings?.length === 1 ? adapter.controlledWriteBindings[0] : undefined;
    assertAdapterRegistryConsistency({
      pack: registeredPack,
      adapter,
      project: options.project,
      workflows: options.workflows,
      policy: options.policy,
      budget: options.budget,
      approvals: options.approvals,
      revocation: options.revocation,
      killSwitch: options.killSwitch,
      actionRef: options.actionRef ?? declaredBinding?.actionRef,
      resourceRef: options.resourceRef ?? declaredBinding?.resourceRef
    });
    const now = new Date().toISOString();
    const entry = adapterRegistryEntrySchema.parse({
      id: registryRowId("adapter", adapter.adapterId, adapter.version),
      projectId: adapter.projectRef,
      packId: pack.packId,
      packVersion: pack.version,
      adapterId: adapter.adapterId,
      version: adapter.version,
      scope: adapter.scope,
      status: adapter.status,
      manifestSnapshot: adapter,
      ...registrySecurityValues(options),
      // A controlled-write adapter must carry its validation evidence on the
      // manifest itself; the entry mirrors it for local audit queries.
      ...(adapter.independentValidationRef
        ? { independentValidationRef: adapter.independentValidationRef }
        : {}),
      createdAt: now,
      updatedAt: now
    });

    const existing = await this.db
      .select({ id: adapterRegistry.id })
      .from(adapterRegistry)
      .where(and(eq(adapterRegistry.adapterId, adapter.adapterId), eq(adapterRegistry.version, adapter.version)))
      .limit(1);
    if (existing.length > 0) {
      throw new Error(`Adapter ${adapter.adapterId}@${adapter.version} already exists and is immutable`);
    }
    await this.db.insert(adapterRegistry).values(adapterRegistryToInsert(entry));
    return adapter;
  }

  async registerAdapter(input: AdapterManifest, options: AdapterRegistryOptions) {
    return this.persistAdapterManifest(input, options);
  }

  async writeAdapterManifest(input: AdapterManifest, options: AdapterRegistryOptions) {
    return this.persistAdapterManifest(input, options);
  }

  async persistAdapter(input: AdapterManifest, options: AdapterRegistryOptions) {
    return this.persistAdapterManifest(input, options);
  }

  async getAdapterManifest(
    adapterId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<AdapterManifest | undefined> {
    const rows = await this.db
      .select()
      .from(adapterRegistry)
      .where(and(eq(adapterRegistry.adapterId, adapterId), eq(adapterRegistry.version, version)))
      .limit(1);
    if (!rows[0]) return undefined;
    const entry = rowToAdapterRegistryEntry(rows[0]);
    assertExpectedScope("Adapter registry read", entry, expectedScope);
    return entry.manifestSnapshot;
  }

  async readAdapterManifest(adapterId: string, version: string, expectedScope?: UniversalScope) {
    return this.getAdapterManifest(adapterId, version, expectedScope);
  }

  async getAdapterRegistryEntry(
    adapterId: string,
    version: string,
    expectedScope?: UniversalScope
  ): Promise<AdapterRegistryEntry | undefined> {
    const rows = await this.db
      .select()
      .from(adapterRegistry)
      .where(and(eq(adapterRegistry.adapterId, adapterId), eq(adapterRegistry.version, version)))
      .limit(1);
    if (!rows[0]) return undefined;
    const entry = rowToAdapterRegistryEntry(rows[0]);
    assertExpectedScope("Adapter registry entry read", entry, expectedScope);
    return entry;
  }

  async readAdapterRegistryEntry(adapterId: string, version: string, expectedScope?: UniversalScope) {
    return this.getAdapterRegistryEntry(adapterId, version, expectedScope);
  }

  async readAdapter(adapterId: string, version: string, expectedScope?: UniversalScope) {
    return this.getAdapterManifest(adapterId, version, expectedScope);
  }

  async listAdapterManifests(scope?: UniversalScope): Promise<AdapterManifest[]> {
    const rows = await this.db.select().from(adapterRegistry).orderBy(desc(adapterRegistry.updatedAt));
    return rows
      .map(rowToAdapterRegistryEntry)
      .filter((entry) => !scope || sameScope(entry.scope, scope))
      .map((entry) => entry.manifestSnapshot);
  }

  async listAdapters(scope?: UniversalScope) {
    return this.listAdapterManifests(scope);
  }

  async listAdapterRegistryEntries(scope?: UniversalScope): Promise<AdapterRegistryEntry[]> {
    const rows = await this.db.select().from(adapterRegistry).orderBy(desc(adapterRegistry.updatedAt));
    return rows.map(rowToAdapterRegistryEntry).filter((entry) => !scope || sameScope(entry.scope, scope));
  }

  async assertAdapterRegistryStatusTransition(
    adapterId: string,
    version: string,
    nextStatus: AdapterStatus
  ): Promise<void> {
    const current = await this.getAdapterManifest(adapterId, version);
    if (!current) throw new NotFoundError(`Adapter not found: ${adapterId}@${version}`);
    assertAdapterStatusTransition(current.status, nextStatus);
  }

  async assertProjectPackRegistryStatusTransition(
    packId: string,
    version: string,
    nextStatus: ProjectPackStatus
  ): Promise<void> {
    const current = await this.getProjectPack(packId, version);
    if (!current) throw new NotFoundError(`Project Pack not found: ${packId}@${version}`);
    assertProjectPackStatusTransition(current.status, nextStatus);
  }

  /** Parse, scope-check, and persist one Evidence record locally. */
  async persistEvidence(input: UniversalEvidence): Promise<UniversalEvidence> {
    const evidence = evidenceSchema.parse(input);
    await this.db.insert(evidenceRecords).values(evidenceToInsert(evidence));
    return evidence;
  }

  async writeEvidence(input: UniversalEvidence): Promise<UniversalEvidence> {
    return this.persistEvidence(input);
  }

  async getEvidence(id: string, expectedScope?: UniversalScope): Promise<UniversalEvidence | undefined> {
    const rows = await this.db.select().from(evidenceRecords).where(eq(evidenceRecords.id, id)).limit(1);
    const evidence = rows[0] ? rowToEvidence(rows[0]) : undefined;
    if (evidence) assertExpectedScope("Evidence read", evidence, expectedScope);
    return evidence;
  }

  async readEvidence(id: string, expectedScope?: UniversalScope): Promise<UniversalEvidence | undefined> {
    return this.getEvidence(id, expectedScope);
  }

  async listEvidence(scope?: UniversalScope): Promise<UniversalEvidence[]> {
    const rows = await this.db.select().from(evidenceRecords).orderBy(desc(evidenceRecords.observedAt));
    return rows
      .map(rowToEvidence)
      .filter((record) => !scope || sameScope(record.scope, scope));
  }

  /** Parse and persist a versioned MetricDefinition locally. */
  async persistMetricDefinition(input: MetricDefinition): Promise<MetricDefinition> {
    const definition = metricDefinitionSchema.parse(input);
    await this.db.insert(metricDefinitionsTable).values(metricDefinitionToInsert(definition));
    return definition;
  }

  async writeMetricDefinition(input: MetricDefinition): Promise<MetricDefinition> {
    return this.persistMetricDefinition(input);
  }

  async getMetricDefinition(id: string, expectedScope?: UniversalScope): Promise<MetricDefinition | undefined> {
    const rows = await this.db.select().from(metricDefinitionsTable).where(eq(metricDefinitionsTable.id, id)).limit(1);
    const definition = rows[0] ? rowToMetricDefinition(rows[0]) : undefined;
    if (definition) assertExpectedScope("Metric definition read", definition, expectedScope);
    return definition;
  }

  async readMetricDefinition(id: string, expectedScope?: UniversalScope): Promise<MetricDefinition | undefined> {
    return this.getMetricDefinition(id, expectedScope);
  }

  /**
   * An observation cannot be stored until its exact definition identity,
   * project, version, and aggregation are present in the local database.
   */
  async persistMetricObservation(input: MetricObservation): Promise<MetricObservation> {
    const observation = metricObservationSchema.parse(input);
    const definitionRows = await this.db
      .select()
      .from(metricDefinitionsTable)
      .where(eq(metricDefinitionsTable.id, observation.definitionRef))
      .limit(1);
    const definition = definitionRows[0] ? rowToMetricDefinition(definitionRows[0]) : undefined;
    if (!definition) {
      throw new Error(`Metric observation references missing MetricDefinition ${observation.definitionRef}`);
    }
    assertMetricDefinitionRegistryConsistency({ definitions: [definition], observations: [observation] });
    await this.db.insert(metricObservationsTable).values(metricObservationToInsert(observation));
    return observation;
  }

  async writeMetricObservation(input: MetricObservation): Promise<MetricObservation> {
    return this.persistMetricObservation(input);
  }

  async getMetricObservation(id: string, expectedScope?: UniversalScope): Promise<MetricObservation | undefined> {
    const rows = await this.db.select().from(metricObservationsTable).where(eq(metricObservationsTable.id, id)).limit(1);
    const observation = rows[0] ? rowToMetricObservation(rows[0]) : undefined;
    if (observation) assertExpectedScope("Metric observation read", observation, expectedScope);
    return observation;
  }

  async readMetricObservation(id: string, expectedScope?: UniversalScope): Promise<MetricObservation | undefined> {
    return this.getMetricObservation(id, expectedScope);
  }

  async listMetricObservations(scope?: UniversalScope): Promise<MetricObservation[]> {
    const rows = await this.db
      .select()
      .from(metricObservationsTable)
      .orderBy(desc(metricObservationsTable.periodEnd));
    return rows
      .map(rowToMetricObservation)
      .filter((record) => !scope || sameScope(record.scope, scope));
  }

  /**
   * Persist a Receipt and its validation snapshots only after every referenced
   * Evidence/Metric object has been supplied and the shared graph validators
   * accept the exact scope and version bindings.
   */
  async persistReceipt(
    input: TaskReceipt | { receipt: TaskReceipt } & ReceiptPersistenceRelations,
    relations: ReceiptPersistenceRelations = {}
  ): Promise<TaskReceipt> {
    const receipt = taskReceiptSchema.parse("receipt" in input ? input.receipt : input);
    const supplied = "receipt" in input
      ? {
          validations: input.validations,
          evidences: input.evidences,
          metricDefinitions: input.metricDefinitions,
          metricObservations: input.metricObservations
        }
      : relations;
    assertReceiptRelations(receipt, supplied);
    await this.db.insert(receipts).values(
      receiptToInsert(receipt, receiptValidationSchema.array().parse(supplied.validations ?? []))
    );
    return receipt;
  }

  async writeReceipt(
    input: TaskReceipt | { receipt: TaskReceipt } & ReceiptPersistenceRelations,
    relations: ReceiptPersistenceRelations = {}
  ): Promise<TaskReceipt> {
    return this.persistReceipt(input, relations);
  }

  async getReceipt(id: string, expectedScope?: UniversalScope): Promise<TaskReceipt | undefined> {
    const rows = await this.db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
    const receipt = rows[0] ? rowToReceipt(rows[0]) : undefined;
    if (receipt) assertExpectedScope("Receipt read", receipt, expectedScope);
    return receipt;
  }

  async readReceipt(id: string, expectedScope?: UniversalScope): Promise<TaskReceipt | undefined> {
    return this.getReceipt(id, expectedScope);
  }

  async getReceiptBundle(id: string, expectedScope?: UniversalScope): Promise<{
    receipt: TaskReceipt;
    validations: ReceiptValidation[];
  } | undefined> {
    const rows = await this.db.select().from(receipts).where(eq(receipts.id, id)).limit(1);
    if (!rows[0]) return undefined;
    const receipt = rowToReceipt(rows[0]);
    assertExpectedScope("Receipt bundle read", receipt, expectedScope);
    const validations = receiptValidationSchema.array().parse(JSON.parse(rows[0].validationJson));
    assertScopeConsistency("Receipt bundle read", [receipt, ...validations]);
    return { receipt, validations };
  }

  /**
   * Atomically writes the four AC-1-2 record classes. All validation happens
   * before the transaction and the transaction itself contains no external
   * side effect, so a failed relation cannot leave a partial local chain.
   */
  async persistEvidenceReceiptMetrics(
    input: EvidenceReceiptMetricsPersistenceInput
  ): Promise<{
    evidences: UniversalEvidence[];
    receipt: TaskReceipt;
    metricDefinitions: MetricDefinition[];
    metricObservations: MetricObservation[];
  }> {
    const evidences = evidenceSchema.array().parse(input.evidences);
    const receipt = taskReceiptSchema.parse(input.receipt);
    const metricDefinitions = metricDefinitionSchema.array().parse(input.metricDefinitions);
    const metricObservations = metricObservationSchema.array().parse(input.metricObservations);
    const validations = receiptValidationSchema.array().parse(input.validations ?? []);
    assertMetricDefinitionRegistryConsistency({ definitions: metricDefinitions, observations: metricObservations });
    assertReceiptRelations(receipt, {
      validations,
      evidences,
      metricDefinitions,
      metricObservations
    });
    await this.db.transaction(async (tx) => {
      for (const evidence of evidences) {
        await tx.insert(evidenceRecords).values(evidenceToInsert(evidence));
      }
      for (const definition of metricDefinitions) {
        await tx.insert(metricDefinitionsTable).values(metricDefinitionToInsert(definition));
      }
      for (const observation of metricObservations) {
        await tx.insert(metricObservationsTable).values(metricObservationToInsert(observation));
      }
      await tx.insert(receipts).values(receiptToInsert(receipt, validations));
    });
    return { evidences, receipt, metricDefinitions, metricObservations };
  }

  async writeEvidenceReceiptMetrics(input: EvidenceReceiptMetricsPersistenceInput) {
    return this.persistEvidenceReceiptMetrics(input);
  }

  // -------------------------------------------------------------------------
  // AC-6 Attempt / ReplayCheckpoint / Universal Audit persistence
  // -------------------------------------------------------------------------

  async persistAttempt(input: AttemptIdentity): Promise<AttemptIdentity> {
    const attempt = attemptIdentitySchema.parse(input);
    const existing = await this.db
      .select()
      .from(attempts)
      .where(eq(attempts.id, attempt.id))
      .limit(1);
    if (existing[0]) {
      const stored = rowToAttempt(existing[0]);
      if (canonicalJson(stored) !== canonicalJson(attempt)) {
        throw new IdempotencyConflictError(`Attempt '${attempt.id}' is already bound to a different snapshot`);
      }
      return stored;
    }
    await this.db.insert(attempts).values(attemptToInsert(attempt));
    return attempt;
  }

  async writeAttempt(input: AttemptIdentity): Promise<AttemptIdentity> {
    return this.persistAttempt(input);
  }

  async getAttempt(id: string, expectedScope?: UniversalScope): Promise<AttemptIdentity | undefined> {
    const rows = await this.db.select().from(attempts).where(eq(attempts.id, id)).limit(1);
    if (!rows[0]) return undefined;
    const attempt = rowToAttempt(rows[0]);
    assertExpectedScope("Attempt read", attempt, expectedScope);
    return attempt;
  }

  async readAttempt(id: string, expectedScope?: UniversalScope): Promise<AttemptIdentity | undefined> {
    return this.getAttempt(id, expectedScope);
  }

  async persistReplayCheckpoint(input: ReplayCheckpoint): Promise<ReplayCheckpoint> {
    const checkpoint = replayCheckpointSchema.parse(input);
    const attempt = await this.getAttempt(checkpoint.attemptId, checkpoint.scope);
    if (!attempt) throw new NotFoundError(`Attempt not found: ${checkpoint.attemptId}`);
    if (
      attempt.runId !== checkpoint.runId ||
      attempt.workItemId !== checkpoint.workItemId ||
      attempt.workflowVersion !== checkpoint.workflowVersion ||
      attempt.workflowRef !== checkpoint.workflowRef
    ) {
      throw new Error(`Replay checkpoint ${checkpoint.id} does not bind to its Attempt identity/version`);
    }
    const existing = await this.db
      .select()
      .from(replayCheckpoints)
      .where(eq(replayCheckpoints.id, checkpoint.id))
      .limit(1);
    if (existing[0]) {
      const stored = rowToReplayCheckpoint(existing[0]);
      if (canonicalJson(stored) !== canonicalJson(checkpoint)) {
        throw new IdempotencyConflictError(
          `Replay checkpoint '${checkpoint.id}' is already bound to a different snapshot`
        );
      }
      return stored;
    }
    await this.db.insert(replayCheckpoints).values(replayCheckpointToInsert(checkpoint));
    return checkpoint;
  }

  async writeReplayCheckpoint(input: ReplayCheckpoint): Promise<ReplayCheckpoint> {
    return this.persistReplayCheckpoint(input);
  }

  async getReplayCheckpoint(id: string, expectedScope?: UniversalScope): Promise<ReplayCheckpoint | undefined> {
    const rows = await this.db
      .select()
      .from(replayCheckpoints)
      .where(eq(replayCheckpoints.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    const checkpoint = rowToReplayCheckpoint(rows[0]);
    assertExpectedScope("Replay checkpoint read", checkpoint, expectedScope);
    return checkpoint;
  }

  async readReplayCheckpoint(id: string, expectedScope?: UniversalScope): Promise<ReplayCheckpoint | undefined> {
    return this.getReplayCheckpoint(id, expectedScope);
  }

  async persistAuditEvent(input: AuditEvent): Promise<AuditEvent> {
    const event = auditEventSchema.parse(input);
    const attempt = await this.getAttempt(event.attemptId, event.scope);
    if (!attempt) throw new NotFoundError(`Attempt not found: ${event.attemptId}`);
    if (attempt.runId !== event.runId) {
      throw new Error(`Universal Audit event ${event.id} does not bind to its Attempt/Run`);
    }
    const existing = await this.db
      .select()
      .from(universalAuditEvents)
      .where(eq(universalAuditEvents.id, event.id))
      .limit(1);
    if (existing[0]) {
      const stored = rowToUniversalAuditEvent(existing[0]);
      if (canonicalJson(stored) !== canonicalJson(event)) {
        throw new IdempotencyConflictError(
          `Universal Audit event '${event.id}' is already bound to a different snapshot`
        );
      }
      return stored;
    }
    await this.db.insert(universalAuditEvents).values(universalAuditEventToInsert(event));
    return event;
  }

  async persistUniversalAuditEvent(input: AuditEvent): Promise<AuditEvent> {
    return this.persistAuditEvent(input);
  }

  async writeAuditEvent(input: AuditEvent): Promise<AuditEvent> {
    return this.persistAuditEvent(input);
  }

  async getAuditEvent(id: string, expectedScope?: UniversalScope): Promise<AuditEvent | undefined> {
    const rows = await this.db
      .select()
      .from(universalAuditEvents)
      .where(eq(universalAuditEvents.id, id))
      .limit(1);
    if (!rows[0]) return undefined;
    const event = rowToUniversalAuditEvent(rows[0]);
    assertExpectedScope("Universal Audit read", event, expectedScope);
    return event;
  }

  async readAuditEvent(id: string, expectedScope?: UniversalScope): Promise<AuditEvent | undefined> {
    return this.getAuditEvent(id, expectedScope);
  }

  async persistAuditReplayChain(input: AuditReplayConsistencyInput): Promise<void> {
    const run = universalRunSchema.parse(input.run);
    const receipt = taskReceiptSchema.parse(input.receipt);
    const attemptsToWrite = attemptIdentitySchema.array().parse(input.attempts);
    const checkpointsToWrite = replayCheckpointSchema.array().parse(input.checkpoints);
    const auditEventsToWrite = auditEventSchema.array().parse(input.auditEvents);
    assertAuditReplayConsistency({
      run,
      receipt,
      attempts: attemptsToWrite,
      checkpoints: checkpointsToWrite,
      auditEvents: auditEventsToWrite
    });
    await this.db.transaction(async (tx) => {
      for (const attempt of attemptsToWrite) {
        const existing = await tx
          .select()
          .from(attempts)
          .where(eq(attempts.id, attempt.id))
          .limit(1);
        if (existing[0]) {
          const stored = rowToAttempt(existing[0]);
          if (canonicalJson(stored) !== canonicalJson(attempt)) {
            throw new IdempotencyConflictError(
              `Attempt '${attempt.id}' is already bound to a different snapshot`
            );
          }
        } else {
          await tx.insert(attempts).values(attemptToInsert(attempt));
        }
      }
      for (const checkpoint of checkpointsToWrite) {
        const existing = await tx
          .select()
          .from(replayCheckpoints)
          .where(eq(replayCheckpoints.id, checkpoint.id))
          .limit(1);
        if (existing[0]) {
          const stored = rowToReplayCheckpoint(existing[0]);
          if (canonicalJson(stored) !== canonicalJson(checkpoint)) {
            throw new IdempotencyConflictError(
              `Replay checkpoint '${checkpoint.id}' is already bound to a different snapshot`
            );
          }
        } else {
          await tx.insert(replayCheckpoints).values(replayCheckpointToInsert(checkpoint));
        }
      }
      for (const event of auditEventsToWrite) {
        const existing = await tx
          .select()
          .from(universalAuditEvents)
          .where(eq(universalAuditEvents.id, event.id))
          .limit(1);
        if (existing[0]) {
          const stored = rowToUniversalAuditEvent(existing[0]);
          if (canonicalJson(stored) !== canonicalJson(event)) {
            throw new IdempotencyConflictError(
              `Universal Audit event '${event.id}' is already bound to a different snapshot`
            );
          }
        } else {
          await tx.insert(universalAuditEvents).values(universalAuditEventToInsert(event));
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Wave 1 wiring: RuntimeEvent stream persistence + replay checkpoint
  //
  // Before this slice the runtime worker produced `RuntimeExecutionResult.events`
  // and the control plane dropped them; `replay_checkpoints` had CRUD but no
  // producer. These methods connect both. The stream lands in `run_events`
  // (migration 0011) — an append-only log with a `run_id`, not the
  // transactional Outbox, whose mutable `status` column would make the event
  // log rewritable and which carries no run identity of its own.
  // -------------------------------------------------------------------------

  /**
   * Fail-closed gate for the runtime-event side effect. An outcome may only be
   * persisted for a Run that already exists durably with the same status, so a
   * forged or stale run cannot emit events behind the execution path's back.
   * Returns the row's own timestamps: the log's identity baseline must record
   * the projection's persisted clock verbatim (a rebuild that returned a
   * differently formatted instant would not be parity).
   */
  private async assertRunOutcomeIsPersisted(run: Run): Promise<PersistedRunClock> {
    const rows = await this.db
      .select({
        status: runs.status,
        createdAt: runs.createdAt,
        updatedAt: runs.updatedAt,
        startedAt: runs.startedAt,
        completedAt: runs.completedAt
      })
      .from(runs)
      .where(eq(runs.id, run.id))
      .limit(1);
    if (!rows[0]) {
      throw new NotFoundError(
        `Refusing to persist runtime events for run '${run.id}': no durable run row`
      );
    }
    if (rows[0].status !== run.status) {
      throw new Error(
        `Refusing to persist runtime events for run '${run.id}': durable status '${rows[0].status}' does not match outcome '${run.status}'`
      );
    }
    return {
      createdAt: rows[0].createdAt,
      updatedAt: rows[0].updatedAt,
      startedAt: rows[0].startedAt,
      completedAt: rows[0].completedAt
    };
  }

  /**
   * Persist the worker's event stream into the append-only `run_events` log.
   * The (run_id, sequence) unique index decides whether a row is new, so
   * re-persisting an identical outcome is a no-op while a resumed execution
   * appends genuinely new events. A sequence slot already bound to a different
   * payload is a conflict, never an overwrite — the log only grows. Errors
   * propagate: a failed write must never be reported as a delivered event.
   */
  private async persistRunRuntimeEvents(
    run: Run,
    events: readonly RuntimeEvent[],
    clock: PersistedRunClock
  ): Promise<string[]> {
    if (events.length === 0) return [];
    const occurredAt = normalizePersistedUtcTimestamp(run.updatedAt);
    const eventIds: string[] = [];
    let baseRecorded = false;
    for (const rawEvent of events) {
      const event = runtimeEventSchema.parse(rawEvent);
      const normalized = normalizeRuntimeEvent(event);
      const digest = runtimeEventDigest(event);
      const idempotencyKey = `run-event:${run.id}:${digest.slice(0, 32)}`;

      // A resumed execution re-emits the events it already recorded; those are
      // recognised by content and reused rather than appended a second time.
      const existing = await this.db
        .select()
        .from(runEvents)
        .where(eq(runEvents.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing[0]) {
        eventIds.push(existing[0].eventId);
        continue;
      }

      // The sequence continues the run's log instead of restarting at 1, so a
      // second execution appends after the first rather than colliding with it.
      const priorRows = await this.db
        .select({ sequence: runEvents.sequence })
        .from(runEvents)
        .where(eq(runEvents.runId, run.id));
      const sequence = priorRows.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
      const eventId = `evt_run_${run.id}_${sequence}_${digest.slice(0, 12)}`;

      // W1a/W1b enrichment: the payload carries the Run identity baseline and
      // the step's resolved outcome, so the log is self-sufficient — the pure
      // projection can rebuild the `runs` row without reading it.
      const payload: Record<string, unknown> = {
        runId: run.id,
        sequence,
        type: normalized.type,
        stepId: normalized.stepId,
        details: normalized.details
      };
      if (!baseRecorded) {
        payload.runBase = runEventRunBase(run, clock);
        baseRecorded = true;
      }
      // W1b: a step may be executed more than once, so the payload carries its
      // latest resolved outcome (scan backwards; `findLast` is unavailable at
      // the ES2022 target).
      const stepEntries = run.stepResults ?? [];
      let stepResult: RunStepResult | undefined;
      for (let at = stepEntries.length - 1; at >= 0; at -= 1) {
        const candidate = stepEntries[at];
        if (candidate && candidate.stepId === normalized.stepId) {
          stepResult = candidate;
          break;
        }
      }
      if (stepResult) payload.stepResult = stepResult;
      // W1b approval parity: the decision rides the payload so the log alone
      // can rebuild `approvalStatus` (`rebuildRunFromEvents` fails closed
      // without it).
      if (normalized.approvalDecision) {
        payload.approvalDecision = normalized.approvalDecision;
      }
      if (normalized.type === "run_completed" && run.outputPayload) {
        payload.outputPayload = run.outputPayload;
      }
      if (normalized.type === "run_failed" && run.failureReason) {
        payload.failureReason = run.failureReason;
      }

      await this.db
        .insert(runEvents)
        .values(
          runEventToInsert({
            eventId,
            runId: run.id,
            attemptId: null,
            sequence,
            schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
            eventType: `growth.run.${event.type}`,
            actorRef: RUNTIME_EVENT_ACTOR_REF,
            subjectRef: run.id,
            correlationId: run.id,
            traceId: `trace_${run.id}`,
            idempotencyKey,
            occurredAt,
            emittedAt: occurredAt,
            dataClass: "OPERATIONAL",
            payload,
            createdAt: occurredAt
          })
        )
        .onConflictDoNothing();

      const persisted = await this.db
        .select()
        .from(runEvents)
        .where(and(eq(runEvents.runId, run.id), eq(runEvents.sequence, sequence)))
        .limit(1);
      if (!persisted[0]) {
        throw new Error(`Run event '${run.id}' sequence ${sequence} was not persisted`);
      }
      if (persisted[0].eventId !== eventId) {
        throw new IdempotencyConflictError(
          `Run event '${run.id}' sequence ${sequence} is already bound to a different snapshot`
        );
      }
      eventIds.push(eventId);
    }
    return eventIds;
  }

  /**
   * Write the replay checkpoint for one execution attempt. Identity is taken
   * from the Run's real Universal WorkItem binding when it exists, otherwise
   * from the shared Growth Run compatibility catalog — never invented. A
   * template with no compatibility entry is skipped and traced rather than
   * given a fabricated workflow version.
   */
  private async persistRunReplayCheckpoint(
    run: Run,
    eventIds: readonly string[],
    events: readonly RuntimeEvent[]
  ): Promise<ReplayCheckpoint | undefined> {
    if (eventIds.length === 0 || events.length === 0) return undefined;

    let compatibility: GrowthRunCompatibility | undefined;
    try {
      compatibility = getGrowthRunCompatibility(run.templateType);
    } catch {
      compatibility = undefined;
    }
    const materialized = await this.getMaterializedGrowthRun(run.id);
    if (!materialized && !compatibility) {
      this.traceLog.record({
        scope: "control-plane",
        action: "run_replay_checkpoint_skipped",
        metadata: {
          runId: run.id,
          templateType: run.templateType,
          reason: "unsupported_template"
        }
      });
      return undefined;
    }

    const scope: UniversalScope = materialized
      ? materialized.workItem.scope
      : { workspaceId: run.workspaceId };
    const workItemId = materialized?.workItem.id ?? `work_item_${run.id}`;
    const workflowRef = materialized?.workItem.workflowRef ?? compatibility?.workflowId;
    const workflowVersion =
      materialized?.workItem.workflowVersion ?? compatibility?.workflowVersion;
    if (!workflowRef || !workflowVersion) {
      this.traceLog.record({
        scope: "control-plane",
        action: "run_replay_checkpoint_skipped",
        metadata: {
          runId: run.id,
          templateType: run.templateType,
          reason: "unresolved_workflow_identity"
        }
      });
      return undefined;
    }

    const streamHash = runtimeEventStreamHash(events);
    const priorAttempts = await this.db
      .select({ id: attempts.id, attemptNumber: attempts.attemptNumber })
      .from(attempts)
      .where(eq(attempts.runId, run.id));

    // One checkpoint per distinct execution outcome: re-persisting the same
    // stream reuses its attempt instead of inventing a second one.
    if (priorAttempts.length > 0) {
      const priorCheckpoints = await this.db
        .select()
        .from(replayCheckpoints)
        .where(inArray(replayCheckpoints.attemptId, priorAttempts.map((row) => row.id)));
      const alreadyCheckpointed = priorCheckpoints.find((row) => row.stateHash === streamHash);
      if (alreadyCheckpointed) return rowToReplayCheckpoint(alreadyCheckpointed);
    }

    const attemptNumber =
      priorAttempts.reduce((max, row) => Math.max(max, row.attemptNumber), 0) + 1;
    const attemptId = `attempt_${run.id}_${attemptNumber}`;
    const checkpointId = `checkpoint_${attemptId}`;

    const startedAt = normalizePersistedUtcTimestamp(run.startedAt ?? run.createdAt);
    const endedAt = normalizePersistedUtcTimestamp(run.completedAt ?? run.updatedAt);
    const attemptStatus: AttemptIdentity["status"] =
      run.status === "failed"
        ? "FAILED"
        : run.status === "cancelled"
          ? "CANCELED"
          : run.status === "waiting_approval"
            ? "RUNNING"
            : "COMPLETED";

    await this.persistAttempt(
      attemptIdentitySchema.parse({
        id: attemptId,
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        scope,
        createdBy: "control-plane",
        createdAt: startedAt,
        updatedAt: endedAt,
        sourceRefs: [`legacy-run:${run.id}`],
        runId: run.id,
        workItemId,
        attemptNumber,
        idempotencyKey: `attempt:${run.id}:${attemptNumber}`,
        workflowVersion,
        ...(workflowRef ? { workflowRef } : {}),
        status: attemptStatus,
        startedAt,
        ...(attemptStatus === "RUNNING" ? {} : { endedAt }),
        checkpointRef: checkpointId,
        metadata: { templateType: run.templateType }
      })
    );

    return this.persistReplayCheckpoint(
      replayCheckpointSchema.parse({
        id: checkpointId,
        schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
        scope,
        createdBy: "control-plane",
        createdAt: endedAt,
        updatedAt: endedAt,
        sourceRefs: [`legacy-run:${run.id}`],
        runId: run.id,
        workItemId,
        attemptId,
        sequence: 1,
        workflowVersion,
        ...(workflowRef ? { workflowRef } : {}),
        stateHash: streamHash,
        sourceEventRefs: [...eventIds],
        status: "WRITABLE",
        metadata: { templateType: run.templateType, eventCount: events.length }
      })
    );
  }

  /**
   * Durable entry point for the runtime event side effect: gate, persist the
   * event stream, then checkpoint it so the stream can be replayed.
   */
  async persistRuntimeEventStream(
    run: Run,
    events: readonly RuntimeEvent[]
  ): Promise<RunRuntimeEventWiringResult> {
    const clock = await this.assertRunOutcomeIsPersisted(run);
    // One stream, one event per content identity: a retried step re-emitting the
    // same event must not abort persistence (R-W1a).
    const stream = dedupeRuntimeEventStream(events);
    const eventIds = await this.persistRunRuntimeEvents(run, stream, clock);
    const checkpoint = await this.persistRunReplayCheckpoint(run, eventIds, stream);
    return { eventIds, ...(checkpoint ? { checkpointId: checkpoint.id } : {}) };
  }

  /**
   * The append-only Run event log, in `sequence` order — the read model behind
   * `GET /api/runs/:runId/events/history` and the single export source for
   * replay fixtures.
   */
  async listRunEventHistory(runId: string): Promise<RunEventHistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.sequence);
    return rows.map(runEventRowToHistoryEntry);
  }

  /**
   * W1b: the SSE route's tail read — every event appended after `cursor`
   * (`sequence > afterSequence`), in order. The cursor is the last sequence
   * the client has seen (SSE `id` / `Last-Event-ID`), so the stream advances
   * only over genuinely new rows while the log stays append-only.
   */
  async listRunEventsAfter(
    runId: string,
    afterSequence: number
  ): Promise<RunEventHistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gt(runEvents.sequence, afterSequence)))
      .orderBy(runEvents.sequence);
    return rows.map(runEventRowToHistoryEntry);
  }

  /** Read back the persisted runtime event stream of a run, in execution order. */
  async listRunRuntimeEvents(runId: string): Promise<RuntimeEvent[]> {
    const rows = await this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(runEvents.sequence);
    return rows.map((row) => runEventToRuntimeEvent(row));
  }

  /**
   * Replay a run's persisted event stream from its latest replay checkpoint.
   * Fail-closed: a missing attempt/checkpoint, an unresolvable source event, or
   * a state-hash mismatch rejects instead of returning a best-effort stream.
   */
  async replayRunFromCheckpoint(runId: string): Promise<RuntimeEvent[]> {
    const attemptRows = await this.db
      .select()
      .from(attempts)
      .where(eq(attempts.runId, runId));
    if (attemptRows.length === 0) {
      throw new NotFoundError(`No execution attempt recorded for run '${runId}'`);
    }
    const latest = attemptRows.reduce((best, row) =>
      row.attemptNumber > best.attemptNumber ? row : best
    );

    const checkpointRows = await this.db
      .select()
      .from(replayCheckpoints)
      .where(eq(replayCheckpoints.attemptId, latest.id))
      .limit(1);
    if (!checkpointRows[0]) {
      throw new NotFoundError(`No replay checkpoint recorded for run '${runId}'`);
    }
    const checkpoint = rowToReplayCheckpoint(checkpointRows[0]);

    const eventRows = await this.db
      .select()
      .from(runEvents)
      .where(inArray(runEvents.eventId, [...checkpoint.sourceEventRefs]));
    const byEventId = new Map(
      eventRows.map((row) => [row.eventId, runEventToRuntimeEvent(row)] as const)
    );

    const events: RuntimeEvent[] = [];
    for (const eventRef of checkpoint.sourceEventRefs) {
      const persisted = byEventId.get(eventRef);
      if (!persisted) {
        throw new Error(
          `Replay checkpoint '${checkpoint.id}' references a missing event '${eventRef}'`
        );
      }
      events.push(persisted);
    }

    const recomputedHash = runtimeEventStreamHash(events);
    if (recomputedHash !== checkpoint.stateHash) {
      throw new Error(
        `Replay integrity failure for run '${runId}': checkpoint state hash '${checkpoint.stateHash}' does not match recomputed '${recomputedHash}'`
      );
    }
    return events;
  }

  /**
   * North-star aggregation (audit P1-07). Omit workspaceId for the global
   * view (admin-gated at the HTTP layer).
   */
  async getNorthStarOverview(options: { workspaceId?: string; days?: number } = {}) {
    const days = Math.min(90, Math.max(7, options.days ?? 30));
    const windowStart = new Date(Date.now() - days * 86_400_000).toISOString();

    const eventRows = options.workspaceId
      ? await this.db
          .select()
          .from(productEvents)
          .where(
            and(
              eq(productEvents.workspaceId, options.workspaceId),
              sql`${productEvents.createdAt} >= ${windowStart}`
            )
          )
      : await this.db
          .select()
          .from(productEvents)
          .where(sql`${productEvents.createdAt} >= ${windowStart}`);

    const dayBuckets = new Map<string, Map<string, number>>();
    const totals = new Map<string, number>();
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const key = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
      dayBuckets.set(key, new Map());
    }

    for (const row of eventRows) {
      const dayKey = row.createdAt.slice(0, 10);
      const bucket = dayBuckets.get(dayKey);
      if (bucket) bucket.set(row.eventType, (bucket.get(row.eventType) ?? 0) + 1);
      totals.set(row.eventType, (totals.get(row.eventType) ?? 0) + 1);
    }

    const wsRows = await this.db.select().from(workspaces);
    const createdInWindow = wsRows.filter((ws) => ws.createdAt >= windowStart);
    const activatedWs = new Set(
      eventRows.filter((e) => e.eventType === "run.created" && e.workspaceId).map((e) => e.workspaceId)
    );
    const day7Ws = new Set(
      eventRows.filter((e) => e.eventType === "day7_first_result" && e.workspaceId).map((e) => e.workspaceId)
    );

    const denominator = createdInWindow.length;
    const activationRate = denominator > 0 ? Math.round(([...activatedWs].length / denominator) * 100) : null;
    const day7SuccessRate = denominator > 0 ? Math.round((day7Ws.size / denominator) * 100) : null;

    return {
      windowDays: days,
      scope: options.workspaceId ?? "global",
      series: [...dayBuckets.entries()].map(([key, byType]) => ({
        date: key,
        ...Object.fromEntries(byType)
      })),
      totals: Object.fromEntries(totals),
      activationRate,
      day7SuccessRate,
      workspacesCreatedInWindow: createdInWindow.length
    };
  }

  listTemplates(): Template[] {
    return this.registry.list();
  }

  /**
   * Materialize an existing Growth v1 Run as a Universal compatibility view.
   * This method deliberately never calls createRun or a worker: Legacy Run is
   * the sole execution fact source and the unique legacyRunId index makes the
   * local binding idempotent.
   */
  async materializeGrowthRun(input: MaterializeGrowthRunInput): Promise<MaterializedGrowthRun> {
    const legacyRun = await this.getRun(input.legacyRunId);
    const compatibility = getGrowthRunCompatibility(legacyRun.templateType);
    const scope = universalScopeSchema.parse(input.scope);
    if (!scope.organizationId || !scope.workspaceId || !scope.projectId) {
      throw new Error(
        "Growth materialization requires a complete organization/workspace/project scope"
      );
    }
    const required = (value: string | undefined, label: string): string => {
      if (!value?.trim()) throw new Error(`Growth materialization requires explicit ${label}`);
      return value;
    };
    const projectId = required(input.projectId, "projectId");
    const initiativeId = required(input.initiativeId, "initiativeId");
    const assigneeRef = required(input.assigneeRef, "assigneeRef");
    const packId = required(input.packId ?? input.packRef, "packId");
    const packVersion = required(input.packVersion, "packVersion");
    const workflowRef = required(input.workflowRef ?? input.workflowId, "workflowRef");
    const workflowVersion = required(input.workflowVersion, "workflowVersion");
    const adapterRef = required(input.adapterRef ?? input.adapterId, "adapterRef");
    const adapterVersion = required(input.adapterVersion, "adapterVersion");
    const inputSnapshotRef = required(input.inputSnapshotRef, "inputSnapshotRef");
    const policySnapshotRef = required(input.policySnapshotRef, "policySnapshotRef");
    const snapshotRefs: GrowthSnapshotRefs = {
      pack: required(input.packSnapshotRef ?? input.snapshotRefs?.pack, "packSnapshotRef"),
      workflow: required(input.workflowSnapshotRef ?? input.snapshotRefs?.workflow, "workflowSnapshotRef"),
      adapter: required(input.adapterSnapshotRef ?? input.snapshotRefs?.adapter, "adapterSnapshotRef")
    };
    if (projectId !== scope.projectId) {
      throw new Error("Growth materialization projectId must match scope.projectId");
    }
    if (scope.workspaceId && scope.workspaceId !== legacyRun.workspaceId) {
      throw new Error("Growth materialization workspace scope does not match the Legacy Run workspace");
    }
    if (legacyRun.templateType !== compatibility.templateType) {
      throw new Error("Legacy Run template identity does not match the Growth compatibility map");
    }
    if (
      packId !== compatibility.packId ||
      packVersion !== compatibility.packVersion ||
      workflowRef !== compatibility.workflowId ||
      workflowVersion !== compatibility.workflowVersion ||
      adapterRef !== compatibility.adapterId ||
      adapterVersion !== compatibility.adapterVersion
    ) {
      throw new Error("Growth Pack/Workflow/Adapter identity or version does not match the compatibility map");
    }

    const pack = projectPackManifestSchema.parse(input.packSnapshot ?? input.pack);
    const workflow = workflowDefinitionSchema.parse(input.workflowSnapshot ?? input.workflow);
    const adapter = adapterManifestSchema.parse(input.adapterSnapshot ?? input.adapter);
    if (
      pack.packId !== packId || pack.version !== packVersion || pack.projectId !== projectId ||
      workflow.id !== workflowRef || workflow.version !== workflowVersion ||
      adapter.adapterId !== adapterRef || adapter.version !== adapterVersion
    ) {
      throw new Error("Growth snapshots do not match the explicit identity/version bindings");
    }
    if (
      pack.packId !== compatibility.packId || pack.version !== compatibility.packVersion ||
      workflow.packId !== pack.packId || workflow.packVersion !== pack.version ||
      adapter.projectRef !== projectId || adapter.version !== pack.version
    ) {
      throw new Error("Growth Pack/Workflow/Adapter snapshots are not bound to the required Pack version");
    }
    if (
      !adapter.simulationOnly ||
      (adapter.status !== "SANDBOXED" && adapter.status !== "READ_ONLY_READY") ||
      adapter.writeScopes.length !== 0 ||
      adapter.sideEffects.length !== 1 ||
      adapter.sideEffects[0] !== "none"
    ) {
      throw new Error("Growth Adapter must be simulation-only, read-only, and side-effect free");
    }
    const localPack = await this.getProjectPack(packId, packVersion, scope);
    if (!localPack) {
      throw new Error(
        `Growth materialization requires an exact local Pack registry snapshot ${packId}@${packVersion}`
      );
    }
    if (canonicalJson(localPack) !== canonicalJson(pack)) {
      throw new Error("Growth Pack snapshot does not match the local immutable Pack registry");
    }
    const localWorkflow = await this.getWorkflowDefinition(workflowRef, workflowVersion, scope);
    if (!localWorkflow) {
      throw new Error(
        `Growth materialization requires an exact local Workflow registry snapshot ${workflowRef}@${workflowVersion}`
      );
    }
    if (canonicalJson(localWorkflow) !== canonicalJson(workflow)) {
      throw new Error("Growth Workflow snapshot does not match the local immutable Workflow registry");
    }
    const localAdapter = await this.getAdapterManifest(adapterRef, adapterVersion, scope);
    if (!localAdapter) {
      throw new Error(
        `Growth materialization requires an exact local Adapter registry snapshot ${adapterRef}@${adapterVersion}`
      );
    }
    if (canonicalJson(localAdapter) !== canonicalJson(adapter)) {
      throw new Error("Growth Adapter snapshot does not match the local immutable Adapter registry");
    }
    assertProjectPackConsistency({ pack, workflow, adapter });

    if (compatibility.templateType === "private_conversion") {
      if (legacyRun.status === "waiting_approval" && legacyRun.approvalStatus !== "pending") {
        throw new Error("private_conversion waiting_approval requires a pending manual approval");
      }
      if (legacyRun.status === "completed" && legacyRun.approvalStatus !== "approved") {
        throw new Error("private_conversion completion requires an approved manual approval");
      }
    }

    const now = new Date().toISOString();
    const createdBy = input.createdBy?.trim() || assigneeRef;
    const universalStatus = normalizeGrowthRunStatus(legacyRun.status);
    const capabilityRefs = [...new Set(workflow.nodes.flatMap((node) => node.capabilityRefs))];
    const metadata = {
      legacyRunId: legacyRun.id,
      templateType: compatibility.templateType,
      templateVersion: compatibility.templateVersion,
      packId,
      packVersion,
      adapterRef,
      adapterVersion,
      packSnapshotRef: snapshotRefs.pack,
      workflowSnapshotRef: snapshotRefs.workflow,
      adapterSnapshotRef: snapshotRefs.adapter,
      inputSnapshotRef,
      policySnapshotRef,
      ...(input.policySnapshotVersion ? { policySnapshotVersion: input.policySnapshotVersion } : {}),
      outputArtifactRefs: [...(input.outputArtifactRefs ?? [])],
      ...(input.outputSnapshotRef ? { outputSnapshotRef: input.outputSnapshotRef } : {}),
      approvalStatus: legacyRun.approvalStatus,
      approvalRefs: [...(input.approvalRefs ?? [])],
      simulationOnly: true,
      adapterStatus: adapter.status,
      writeScopes: [],
      sideEffects: ["none"],
      packSnapshot: pack,
      workflowSnapshot: workflow,
      adapterSnapshot: adapter,
      ...(legacyRun.outputPayload ? { outputPayload: legacyRun.outputPayload } : {}),
      ...(legacyRun.failureReason ? { failureReason: legacyRun.failureReason } : {}),
      ...(legacyRun.teamId ? { teamId: legacyRun.teamId } : {}),
      ...(legacyRun.relayId ? { relayId: legacyRun.relayId } : {})
    };
    const workItem = workItemSchema.parse({
      id: `work_item_${legacyRun.id}`,
      projectId,
      scope,
      schemaVersion: "1.0",
      createdBy,
      createdAt: normalizePersistedUtcTimestamp(legacyRun.createdAt),
      updatedAt: normalizePersistedUtcTimestamp(legacyRun.updatedAt),
      sourceRefs: [`legacy-run:${legacyRun.id}`],
      initiativeId,
      kind: `GROWTH_${compatibility.templateType.toUpperCase()}`,
      title: `Growth ${compatibility.templateType}`,
      dependencies: [],
      workflowRef,
      workflowDefinitionId: workflowRef,
      workflowVersion,
      workflowDefinitionVersion: workflowVersion,
      capabilityRefs,
      assigneeRef,
      packRef: packId,
      packVersion,
      adapterRef,
      adapterVersion,
      inputSnapshotRef,
      outputArtifactRefs: [...(input.outputArtifactRefs ?? [])],
      ...(input.outputSnapshotRef ? { outputSnapshotRef: input.outputSnapshotRef } : {}),
      legacyRunId: legacyRun.id,
      approvalStatus: legacyRun.approvalStatus,
      riskClass: adapter.riskClass,
      approvalPolicyRef: policySnapshotRef,
      budgetEnvelope: { mode: "SIMULATION_ONLY" },
      status: universalStatus,
      metadata
    });
    const run = universalRunSchema.parse({
      id: `universal_run_${legacyRun.id}`,
      workItemId: workItem.id,
      scope,
      schemaVersion: "1.0",
      createdBy,
      createdAt: workItem.createdAt,
      updatedAt: workItem.updatedAt,
      sourceRefs: [`legacy-run:${legacyRun.id}`],
      workflowVersion,
      workflowRef,
      workflowDefinitionId: workflowRef,
      workflowDefinitionVersion: workflowVersion,
      mode: "SIMULATION",
      status: universalStatus,
      inputSnapshotRef,
      policySnapshotRef,
      manifestRef: adapterRef,
      manifestVersion: adapterVersion,
      ...(input.policySnapshotVersion ? { policySnapshotVersion: input.policySnapshotVersion } : {}),
      approvalRefs: [...(input.approvalRefs ?? [])],
      metadata
    });

    let receipt: TaskReceipt | undefined;
    if (universalStatus === "COMPLETED" || universalStatus === "FAILED" || universalStatus === "CANCELED") {
      receipt = taskReceiptSchema.parse({
        id: `receipt_${legacyRun.id}`,
        workItemId: workItem.id,
        runId: run.id,
        scope,
        schemaVersion: "1.0",
        createdBy,
        createdAt: workItem.createdAt,
        updatedAt: workItem.updatedAt,
        sourceRefs: [`legacy-run:${legacyRun.id}`],
        actorRef: assigneeRef,
        workflowVersion,
        workflowRef,
        workflowDefinitionId: workflowRef,
        workflowDefinitionVersion: workflowVersion,
        inputSnapshotRef,
        manifestRef: adapterRef,
        manifestVersion: adapterVersion,
        ...(input.policySnapshotVersion ? { policySnapshotVersion: input.policySnapshotVersion } : {}),
        outputArtifactRefs: [...(input.outputArtifactRefs ?? [])],
        ...(input.outputSnapshotRef ? { outputSnapshotRef: input.outputSnapshotRef } : {}),
        evidenceRefs: [],
        validationRefs: [],
        metricObservationRefs: [],
        policySnapshotRef,
        approvalRefs: [...(input.approvalRefs ?? [])],
        resultStatus: universalStatus === "COMPLETED"
          ? "SUCCESS_UNVERIFIED"
          : universalStatus === "FAILED" ? "FAILED" : "CANCELED",
        producedAt: normalizePersistedUtcTimestamp(legacyRun.completedAt ?? legacyRun.updatedAt),
        metadata
      });
    }
    assertProjectPackConsistency({ pack, workflow, adapter, run, ...(receipt ? { receipt } : {}) });
    if (receipt) {
      assertExecutionIdentityConsistency({
        workItem,
        run,
        receipt,
        workflow,
        evidences: [],
        validations: [],
        observations: [],
        reviews: [],
        approvals: []
      });
    }

    const materialized: MaterializedGrowthRun = {
      workItem,
      universalWorkItem: workItem,
      run,
      universalRun: run,
      ...(receipt ? { receipt } : {}),
      inserted: true,
      compatibility
    };
    const existingRows = await this.db
      .select()
      .from(workItems)
      .where(eq(workItems.legacyRunId, legacyRun.id))
      .limit(1);
    if (existingRows[0]) {
      const existing = rowToMaterializedGrowthRun(existingRows[0]);
      assertMaterializedBindingContext(existing, materialized);
      const persisted = growthWorkItemToInsert(materialized, {
        ...input,
        scope,
        packSnapshotRef: snapshotRefs.pack,
        workflowSnapshotRef: snapshotRefs.workflow,
        adapterSnapshotRef: snapshotRefs.adapter
      }, now);
      assertMaterializedRowMatchesCandidate(existingRows[0], persisted);
      await this.db.update(workItems).set({
        workItemJson: persisted.workItemJson,
        runJson: persisted.runJson,
        receiptJson: persisted.receiptJson,
        updatedAt: now
      }).where(eq(workItems.id, existing.workItem.id));
      return { ...materialized, inserted: false };
    }

    const persisted = growthWorkItemToInsert(materialized, {
      ...input,
      scope,
      packSnapshotRef: snapshotRefs.pack,
      workflowSnapshotRef: snapshotRefs.workflow,
      adapterSnapshotRef: snapshotRefs.adapter
    }, now);
    try {
      await this.db.insert(workItems).values(persisted);
    } catch (error) {
      // A concurrent caller may have won the unique legacyRunId race. Read
      // that immutable binding and apply the same context check on return.
      const raced = await this.db
        .select()
        .from(workItems)
        .where(eq(workItems.legacyRunId, legacyRun.id))
        .limit(1);
      if (!raced[0]) throw error;
      const existing = rowToMaterializedGrowthRun(raced[0]);
      try {
        assertMaterializedBindingContext(existing, materialized);
        assertMaterializedRowMatchesCandidate(raced[0], persisted);
      } catch {
        throw error;
      }
      return existing;
    }
    return materialized;
  }

  async materializeUniversalWorkItem(input: MaterializeGrowthRunInput): Promise<MaterializedGrowthRun> {
    return this.materializeGrowthRun(input);
  }

  async materializeGrowthWorkItem(input: MaterializeGrowthRunInput): Promise<MaterializedGrowthRun> {
    return this.materializeGrowthRun(input);
  }

  async getMaterializedGrowthRun(
    legacyRunId: string,
    expectedScope?: UniversalScope
  ): Promise<MaterializedGrowthRun | undefined> {
    const rows = await this.db.select().from(workItems).where(eq(workItems.legacyRunId, legacyRunId)).limit(1);
    if (!rows[0]) return undefined;
    const materialized = rowToMaterializedGrowthRun(rows[0]);
    assertExpectedScope("Materialized Growth Run read", {
      id: materialized.workItem.id,
      scope: materialized.workItem.scope
    }, expectedScope);
    return materialized;
  }

  async readMaterializedGrowthRun(
    legacyRunId: string,
    expectedScope?: UniversalScope
  ): Promise<MaterializedGrowthRun | undefined> {
    return this.getMaterializedGrowthRun(legacyRunId, expectedScope);
  }

  async getGrowthWorkItem(
    legacyRunId: string,
    expectedScope?: UniversalScope
  ): Promise<UniversalWorkItem | undefined> {
    return (await this.getMaterializedGrowthRun(legacyRunId, expectedScope))?.workItem;
  }

  /**
   * Cancel the Legacy Run and update its existing compatibility snapshot in
   * place. This never creates a Run or WorkItem and rejects a caller from a
   * different scope before mutating the legacy source of truth.
   */
  async cancelMaterializedGrowthRun(
    legacyRunId: string,
    expectedScope?: UniversalScope
  ): Promise<MaterializedGrowthRun> {
    const materialized = await this.getMaterializedGrowthRun(legacyRunId, expectedScope);
    if (!materialized) {
      throw new NotFoundError(`Universal WorkItem not found for Legacy Run: ${legacyRunId}`);
    }
    const legacyRun = await this.getRun(legacyRunId);
    const canceled = legacyRun.status === "cancelled" ? legacyRun : await this.cancelRun(legacyRunId);
    if (legacyRun.status === "cancelled") return materialized;

    const workItem = workItemSchema.parse({
      ...materialized.workItem,
      status: "CANCELED",
      updatedAt: canceled.updatedAt,
      metadata: {
        ...materialized.workItem.metadata,
        approvalStatus: canceled.approvalStatus
      }
    });
    const run = universalRunSchema.parse({
      ...materialized.run,
      status: "CANCELED",
      updatedAt: canceled.updatedAt,
      endedAt: canceled.completedAt ?? canceled.updatedAt,
      metadata: {
        ...materialized.run.metadata,
        approvalStatus: canceled.approvalStatus
      }
    });
    const receipt = materialized.receipt ?? taskReceiptSchema.parse({
      id: `receipt_${legacyRunId}`,
      workItemId: workItem.id,
      runId: run.id,
      scope: workItem.scope,
      schemaVersion: workItem.schemaVersion,
      createdBy: workItem.createdBy,
      createdAt: workItem.createdAt,
      updatedAt: canceled.updatedAt,
      sourceRefs: [`legacy-run:${legacyRunId}`],
      actorRef: workItem.assigneeRef,
      workflowVersion: run.workflowVersion,
      ...(run.workflowRef ? { workflowRef: run.workflowRef } : {}),
      ...(run.workflowDefinitionId ? { workflowDefinitionId: run.workflowDefinitionId } : {}),
      ...(run.workflowDefinitionVersion ? { workflowDefinitionVersion: run.workflowDefinitionVersion } : {}),
      inputSnapshotRef: run.inputSnapshotRef,
      ...(run.manifestRef ? { manifestRef: run.manifestRef } : {}),
      ...(run.manifestVersion ? { manifestVersion: run.manifestVersion } : {}),
      ...(run.policySnapshotVersion ? { policySnapshotVersion: run.policySnapshotVersion } : {}),
      outputArtifactRefs: workItem.outputArtifactRefs,
      evidenceRefs: [],
      validationRefs: [],
      metricObservationRefs: [],
      policySnapshotRef: run.policySnapshotRef,
      approvalRefs: run.approvalRefs,
      resultStatus: "CANCELED",
      producedAt: canceled.completedAt ?? canceled.updatedAt,
      metadata: workItem.metadata
    });
    await this.db.update(workItems).set({
      workItemJson: JSON.stringify(workItem),
      runJson: JSON.stringify(run),
      receiptJson: JSON.stringify(receipt),
      updatedAt: canceled.updatedAt
    }).where(eq(workItems.id, workItem.id));
    return {
      ...materialized,
      workItem,
      universalWorkItem: workItem,
      run,
      universalRun: run,
      receipt,
      inserted: false
    };
  }

  async cancelGrowthRun(legacyRunId: string, expectedScope?: UniversalScope): Promise<MaterializedGrowthRun> {
    return this.cancelMaterializedGrowthRun(legacyRunId, expectedScope);
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const span = this.traceLog.startSpan("control-plane", "createRun", {
      workspaceId: input.workspaceId,
      templateType: input.templateType
    });
    try {
      const workspaceRows = await this.db.select().from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));

      if (workspaceRows.length === 0) {
        throw new NotFoundError(
          `Workspace not found: ${input.workspaceId}`,
          "WORKSPACE_NOT_FOUND"
        );
      }

      // Quota gate before any execution work (audit P0-B3).
      await this.checkRunQuota(input.workspaceId);

      const templateType = assertTemplateType(input.templateType);
      // Shallow-clone before mutation: `_teamId` deletion and `_memories` /
      // `_benchmarks` injection must never leak back into the caller's object
      // (assertRunInput returns the same reference it receives).
      const runInput = assertRunInput({ ...input.input });
      const now = new Date().toISOString();

      // Optional team linkage (Round V): `_teamId` is stripped from the
      // contract input and promoted to the run row.
      const rawTeamId = (runInput as { _teamId?: unknown })._teamId;
      let teamId: string | undefined;
      if (typeof rawTeamId === "string" && rawTeamId) {
        delete (runInput as { _teamId?: unknown })._teamId;
        const teamRows = await this.db
          .select({ id: teams.id, workspaceId: teams.workspaceId, status: teams.status })
          .from(teams)
          .where(eq(teams.id, rawTeamId));
        if (
          teamRows.length === 0 ||
          teamRows[0].workspaceId !== input.workspaceId ||
          teamRows[0].status !== "active"
        ) {
          throw new NotFoundError(
            `Active team not found in this workspace: ${rawTeamId}`,
            "TEAM_NOT_FOUND"
          );
        }
        teamId = rawTeamId;
      }

      // Optional relay linkage (Round U/V): `_relayId` mirrors waiting state.
      const rawRelayId = (runInput as { _relayId?: unknown })._relayId;
      let relayId: string | undefined;
      if (typeof rawRelayId === "string" && rawRelayId) {
        delete (runInput as { _relayId?: unknown })._relayId;
        relayId = rawRelayId;
      }

      let run: Run = {
        id: `run_${randomUUID()}`,
        workspaceId: input.workspaceId,
        templateType,
        status: "draft",
        input: runInput,
        currentStep: null,
        approvalStatus: "not_required",
        createdAt: now,
        updatedAt: now,
        ...(teamId ? { teamId } : {}),
        ...(relayId ? { relayId } : {})
      };
      // P1 Crew (Round X): team runs recall the latest team-visible memories
      // into the prompt context — closing the deposit → recall loop.
      // (Must run BEFORE attachKnowledge, which copies run.input.)
      if (teamId) {
        const teamMems = await this.db
          .select({ summary: memoryRecords.summary })
          .from(memoryRecords)
          .where(
            and(
              eq(memoryRecords.workspaceId, input.workspaceId),
              eq(memoryRecords.visibility, "team")
            )
          )
          .orderBy(desc(memoryRecords.updatedAt))
          .limit(5);
        if (teamMems.length > 0) {
          (runInput as { _memories?: string[] })._memories = teamMems.map((m) => m.summary);
        }
      }

      // R2-D v1 (Round AA): inject k-anonymous industry benchmark priors
      // into the prompt context when the workspace declares an industry.
      // (Must run BEFORE attachKnowledge, which copies run.input.)
      const industry = workspaceRows[0].industry;
      if (industry) {
        try {
          const benchmarks = await this.getIndustryBenchmarks(industry);
          const top = benchmarks
            .slice()
            .sort((a, b) => b.sampleSize - a.sampleSize)
            .slice(0, 5);
          if (top.length > 0) {
            (runInput as { _benchmarks?: Array<{ templateType: string; successRate: number | null; p50DurationSec: number | null; p90DurationSec: number | null; sampleSize: number }> })._benchmarks = top.map((b) => ({
              templateType: b.templateType,
              successRate: b.successRate,
              p50DurationSec: b.p50DurationSec,
              p90DurationSec: b.p90DurationSec,
              sampleSize: b.sampleSize
            }));
          }
        } catch {
          // Benchmark recall is an enhancement — never block run creation.
        }
      }

      run = await this.attachKnowledge(run);

      await this.incrementUsage(input.workspaceId, { runsCreated: 1 });
      await this.recordProductEvent(input.workspaceId, null, "run.created", {
        templateType,
        mode: this.durable ? "durable" : "inline"
      });

      if (this.durable) {
        // Durable mode (audit P0-C1): persist as queued + enqueue, return at once.
        const queuedRun = transitionRun(run, "queued");
        await this.db.insert(runs).values(runToInsert(queuedRun));
        // Round V/U: carry the crew-team id so the job loop can mirror
        // waiting_approval onto the owning relay row after execution.
        await this.temporalWorker.enqueue(queuedRun, "execute_run", teamId ? { payload: { relayId: queuedRun.id } } : undefined);

        span.setAttribute("runId", queuedRun.id);
        span.setAttribute("run.status", queuedRun.status);
        return queuedRun;
      }

      const result = await this.temporalWorker.submitQueuedRun(run);
      await this.persistRunProjection(result.run, "insert");
      await this.persistExecutionOutcome(result);

      span.setAttribute("runId", result.run.id);
      span.setAttribute("run.status", result.run.status);
      return result.run;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Durable job-loop driver: claim → execute → persist outcome.
   * Returns true when a job was processed.
   */
  async processNextJob(): Promise<boolean> {
    const claimed = await this.temporalWorker.claimNext();
    if (!claimed) return false;

    // Embed jobs carry a knowledgeId (not a runs row) — bypass run lookup.
    if (claimed.type === "embed_knowledge") {
      const stubRun: Run = {
        id: claimed.runId,
        workspaceId: "",
        templateType: "embed_knowledge",
        status: "running",
        input: {},
        currentStep: null,
        approvalStatus: "not_required",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await this.temporalWorker.processClaimed(claimed, stubRun);
      return true;
    }

    const rows = await this.db.select().from(runs).where(eq(runs.id, claimed.runId));
    if (rows.length === 0) {
      this.traceLog.record({
        scope: "control-plane",
        action: "job_run_row_missing",
        metadata: { jobId: claimed.jobId, runId: claimed.runId }
      });
      return true;
    }

    // Cancelled while queued — skip execution entirely (Round L undo window).
    if (rows[0].status === "cancelled") {
      await this.db
        .update(jobs)
        .set({
          status: "completed",
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        })
        .where(eq(jobs.id, claimed.jobId));
      return true;
    }

    const result = await this.temporalWorker.processClaimed(claimed, rowToRun(rows[0]));
    if (result.result) {
      // Re-read status: never resurrect a run cancelled mid-flight (Round L).
      const after = await this.db
        .select({ status: runs.status })
        .from(runs)
        .where(eq(runs.id, claimed.runId));
      if (after[0]?.status === "cancelled" && result.result.run.status !== "cancelled") {
        return true;
      }
      await this.persistRunProjection(result.result.run, "update");
      await this.persistExecutionOutcome(result.result, claimed.payload?.relayId);
    } else if (result.status === "failed") {
      // Permanent failure after retries — surface on the run row for the UI.
      await this.db
        .update(runs)
        .set({
          status: "failed",
          failureReason: result.error ?? "Job processing failed",
          updatedAt: new Date().toISOString()
        })
        .where(eq(runs.id, claimed.runId));
    }
    // retry_scheduled: leave the run row in `queued` so the UI keeps polling.

    if (result.usage && result.usage.totalTokens > 0) {
      await this.db
        .update(runs)
        .set({
          tokensUsed: result.usage.totalTokens,
          costUsd: estimateCostUsd(result.usage.totalTokens)
        })
        .where(eq(runs.id, claimed.runId));
      await this.incrementUsage(rows[0].workspaceId, { tokens: result.usage.totalTokens });
    }

    return true;
  }

  /** Requeue jobs stuck in claimed/running beyond the staleness window. */
  async recoverStaleJobs(olderThanMs?: number): Promise<number> {
    return this.temporalWorker.recoverStaleJobs(olderThanMs);
  }

  /** Persist post-execution side effects shared by inline and durable paths. */
  private async persistExecutionOutcome(
    outcome: Awaited<ReturnType<TemporalWorkerSkeleton["submitQueuedRun"]>>,
    relayId?: string
  ): Promise<void> {
    // Wave 1 wiring: the worker's event stream is a durable fact, not a
    // transient return value — persist it before any downstream side effect.
    await this.persistRuntimeEventStream(outcome.run, outcome.events);

    if (outcome.approvalRequest) {
      await this.persistApprovalRequest(outcome.approvalRequest);
      // Round V/U: mirror waiting_approval onto the owning relay row so the
      // TeamPage reflects reality (inline path set it at launchTeamStep).
      if (relayId) {
        await this.db
          .update(teamRuns)
          .set({ status: "waiting_approval", updatedAt: new Date().toISOString() })
          .where(eq(teamRuns.id, relayId));
      }
    } else if (outcome.run.status === "completed" && outcome.run.outputPayload) {
      await this.recordCompletedRunMemory(
        outcome.run,
        `Completed ${outcome.run.templateType} with reusable output`,
        "successful_output"
      );
      await this.saveArtifact(outcome.run);
      await this.advanceTeamOnCompletion(outcome.run);
      await this.handleRunCompleted(outcome.run);
    }
  }

  /** Completion-side metering/events: runsCompleted + run.completed + day7. */
  private async handleRunCompleted(run: Run): Promise<void> {
    await this.incrementUsage(run.workspaceId, { runsCompleted: 1 });

    const wsRows = await this.db
      .select({ createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(eq(workspaces.id, run.workspaceId));
    const createdAt = wsRows[0]?.createdAt ?? "";
    const within7d =
      Boolean(createdAt) &&
      Number.isFinite(Date.parse(createdAt)) &&
      Date.now() - Date.parse(createdAt) <= 7 * 86_400_000;

    let isFirstResult = false;
    if (within7d) {
      const prior = await this.db
        .select({ id: productEvents.id })
        .from(productEvents)
        .where(
          and(
            eq(productEvents.workspaceId, run.workspaceId),
            eq(productEvents.eventType, "run.completed")
          )
        );
      isFirstResult = prior.length === 0;
    }

    await this.recordProductEvent(run.workspaceId, null, "run.completed", {
      runId: run.id,
      templateType: run.templateType
    });

    if (within7d && isFirstResult) {
      await this.recordProductEvent(run.workspaceId, null, "day7_first_result", {
        runId: run.id,
        templateType: run.templateType
      });
    }
  }

  private async persistApprovalRequest(request: ApprovalRequest): Promise<void> {
    await this.db.insert(approvalRequests).values({
      id: request.id,
      runId: request.runId,
      actionType: request.actionType,
      reason: request.reason,
      status: request.status,
      requestedAt: request.requestedAt,
      resolvedAt: request.resolvedAt ?? null,
      resolution: request.resolution ?? null
    });
  }

  async getRun(runId: string): Promise<Run> {
    const rows = await this.db.select().from(runs)
      .where(eq(runs.id, runId));

    if (rows.length === 0) {
      throw new NotFoundError(`Run not found: ${runId}`);
    }

    return rowToRun(rows[0]);
  }

  /**
   * Undo window (Round L approval element #4):
   * queued/waiting_approval/running → cancelled.
   */
  async cancelRun(runId: string): Promise<Run> {
    const run = await this.getRun(runId);
    if (run.status !== "queued" && run.status !== "waiting_approval" && run.status !== "running") {
      throw new Error(`Run cannot be cancelled in status '${run.status}'`);
    }
    const cancelled = transitionRun(run, "cancelled");
    await this.db.update(runs).set(runToInsert(cancelled)).where(eq(runs.id, runId));
    this.traceLog.record({
      scope: "control-plane",
      action: "run_cancelled",
      metadata: { runId }
    });
    return cancelled;
  }

  async listApprovalRequests(runId?: string): Promise<ApprovalRequest[]> {
    const rows = runId
      ? await this.db.select().from(approvalRequests)
          .where(eq(approvalRequests.runId, runId))
      : await this.db.select().from(approvalRequests);

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      actionType: row.actionType as ApprovalRequest["actionType"],
      reason: row.reason,
      status: row.status as ApprovalRequest["status"],
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt ?? undefined,
      resolution: row.resolution ?? undefined
    }));
  }

  async listRunsByWorkspace(workspaceId: string): Promise<Array<Run & { outputSummary?: string }>> {
    await this.assertWorkspaceExists(workspaceId);

    const rows = await this.db.select().from(runs)
      .where(eq(runs.workspaceId, workspaceId))
      .orderBy(desc(runs.createdAt), desc(runs.id));

    return rows.map((row) => {
      const run = rowToRun(row);
      return {
        ...run,
        outputSummary: run.outputPayload
          ? Object.keys(run.outputPayload)
              .slice(0, 2)
              .join(", ")
          : undefined
      };
    });
  }

  /**
   * I-017 L0 读路径（Q1=C 内部运营先行；Q2=增长链降级口径；Q3=workspace 边界）。
   * 按 workspace + period（YYYY-MM）聚合月度档案中间模型；只读，无写入。
   * 业务月界默认 +08（Asia/Shanghai，480 分钟；GM 2026-09-27 裁决 A4），
   * `tzOffsetMinutes` 可显式覆盖（分钟，东为正；如 0 = UTC）。
   * 产品化导出格式（A/B）与路由（L3）不在本层；universal 写接线（L2）不做。
   */
  async aggregateMonthlyArchive(
    workspaceId: string,
    period: string,
    tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES
  ): Promise<MonthlyArchiveAggregate> {
    await this.assertWorkspaceExists(workspaceId);
    return buildMonthlyArchive(this.db, workspaceId, period, tzOffsetMinutes);
  }

  async cloneRun(runId: string): Promise<{
    templateType: Run["templateType"];
    input: Run["input"];
    sourceRunId: string;
  }> {
    const run = await this.getRun(runId);
    return {
      templateType: run.templateType,
      input: { ...run.input },
      sourceRunId: run.id
    };
  }

  async updateApproval(runId: string, decision: ApprovalDecision): Promise<Run> {
    const span = this.traceLog.startSpan("control-plane", "updateApproval", {
      runId,
      approved: String(decision.approved)
    });
    try {
      const run = await this.getRun(runId);
      const requests = await this.listApprovalRequests(runId);
      const activeRequest = requests.find(
        (request) => request.status === "pending"
      );

      const reviewedRun = applyApprovalDecision(run, decision);
      await this.db.update(runs).set(runToInsert(reviewedRun)).where(eq(runs.id, runId));
      await this.recordProductEvent(reviewedRun.workspaceId, decision.reviewerId, "approval.decided", {
        runId,
        approved: decision.approved
      });

      // W1b approval parity: the decision itself must be a `run_events` row.
      // Without it the append-only log cannot rebuild the row's
      // post-decision state, so an SSE tail over `run_events` would be stuck
      // on `waiting_approval` forever. `details` carries reviewer/note for
      // audit; `approvalDecision` carries the verdict for the projection.
      await this.persistRuntimeEventStream(reviewedRun, [
        {
          type: "approval_decided",
          runId,
          details: `Reviewer ${decision.reviewerId} ${
            decision.approved ? "approved" : "rejected"
          }${decision.note ? `: ${decision.note}` : ""}`,
          approvalDecision: { approved: decision.approved }
        }
      ]);

      if (activeRequest) {
        const resolvedRequest: ApprovalRequest = {
          ...activeRequest,
          status: decision.approved ? "approved" : "rejected",
          resolvedAt: new Date().toISOString(),
          resolution: decision.note ?? (decision.approved ? "approved" : "rejected")
        };
        await this.db.update(approvalRequests).set({
          status: resolvedRequest.status,
          resolvedAt: resolvedRequest.resolvedAt ?? null,
          resolution: resolvedRequest.resolution ?? null
        }).where(eq(approvalRequests.id, activeRequest.id));
      }

      if (!decision.approved || !activeRequest) {
        span.setAttribute("result.status", reviewedRun.status);
        return reviewedRun;
      }

      if (this.durable) {
        // Durable mode: enqueue the resume job; the background loop completes it.
        await this.temporalWorker.enqueue(reviewedRun, "resume_approved_run", {
          payload: { approvedActions: [activeRequest.actionType] }
        });
        span.setAttribute("result.status", reviewedRun.status);
        return reviewedRun;
      }

      const resumed = await this.temporalWorker.resumeApprovedRun(reviewedRun, [
        activeRequest.actionType
      ]);
      await this.persistRunProjection(resumed.run, "update");
      // Wave 1 wiring: the inline resume path bypasses persistExecutionOutcome,
      // so its event stream must be wired here too.
      await this.persistRuntimeEventStream(resumed.run, resumed.events);

      if (resumed.run.status === "completed" && resumed.run.outputPayload) {
        await this.recordCompletedRunMemory(
          resumed.run,
          `Completed ${resumed.run.templateType} after approval`,
          "successful_output"
        );
        await this.saveArtifact(resumed.run);
        await this.advanceTeamOnCompletion(resumed.run);
        await this.handleRunCompleted(resumed.run);
      }

      span.setAttribute("result.status", resumed.run.status);
      return resumed.run;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  async listWorkspaceMemory(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    return this.memoryStore.listByWorkspace(workspaceId);
  }

  async updateMemoryRecord(memoryId: string, input: UpdateMemoryRecordInput): Promise<MemoryRecord> {
    try {
      return await this.memoryStore.updateRecord(memoryId, input);
    } catch (error) {
      throw new NotFoundError(error instanceof Error ? error.message : "Memory record not found");
    }
  }

  async deleteMemoryRecord(memoryId: string): Promise<void> {
    try {
      await this.memoryStore.deleteRecord(memoryId);
    } catch (error) {
      throw new NotFoundError(error instanceof Error ? error.message : "Memory record not found");
    }
  }

  private async recordCompletedRunMemory(
    run: Run,
    summary: string,
    type: MemoryRecordType
  ): Promise<void> {
    await this.memoryStore.addRecord({
      id: `mem_${randomUUID()}`,
      workspaceId: run.workspaceId,
      templateType: run.templateType,
      type,
      summary,
      sourceRunId: run.id,
      isPinned: false,
      isSuppressed: false,
      // P1 Crew (Round V): relay-step runs deposit team-visible memories.
      visibility: run.teamId ? "team" : "private",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  /** 团队可见记忆聚合(Round V):visibility='team' 的最新 100 条。 */
  async getTeamMemory(teamId: string) {
    const team = await this.getCrewTeamRow(teamId);
    const rows = await this.db
      .select()
      .from(memoryRecords)
      .where(
        and(
          eq(memoryRecords.workspaceId, team.workspaceId),
          eq(memoryRecords.visibility, "team")
        )
      )
      .orderBy(desc(memoryRecords.updatedAt))
      .limit(100);
    return {
      team: { id: team.id, name: team.name, status: team.status },
      memories: rows.map((row) => ({
        id: row.id,
        summary: row.summary,
        templateType: row.templateType,
        sourceRunId: row.sourceRunId,
        isPinned: row.isPinned,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt
      }))
    };
  }

  // -------------------------------------------------------------------------
  // Artifacts library (J3) — completed runs deposit reusable deliverables
  // -------------------------------------------------------------------------

  async saveArtifact(run: Run): Promise<string> {
    const kind =
      run.templateType === "content_acquisition"
        ? "note"
        : run.templateType === "private_conversion"
          ? "copy"
          : run.templateType === "weekly_review"
            ? "report"
            : "generic";

    const payload = run.outputPayload ?? {};
    const firstString = Object.values(payload).find((value) => typeof value === "string") as
      | string
      | undefined;
    const firstList = Object.values(payload).find((value) => Array.isArray(value)) as
      | string[]
      | undefined;

    const title = (firstString ?? (firstList?.[0] ?? `${run.templateType} output`)).slice(0, 90);
    const summary = (firstList ?? []).slice(0, 3).join(" / ").slice(0, 160) || title.slice(0, 120);

    const id = `art_${randomUUID()}`;
    await this.db.insert(artifacts).values({
      id,
      workspaceId: run.workspaceId,
      runId: run.id,
      agentType: run.templateType,
      kind,
      title,
      summary,
      contentJson: JSON.stringify(payload),
      createdAt: new Date().toISOString()
    });

    await this.autoDepositKnowledge(run);
    return id;
  }

  /** J7: auto-deposit completed-run outputs into the knowledge base. */
  private async autoDepositKnowledge(run: Run): Promise<void> {
    const existing = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.runId, run.id));
    if (existing.length > 0) return; // idempotent

    const payload = run.outputPayload ?? {};
    const parts = Object.entries(payload).map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join("; ")}`;
      return `${key}: ${String(value).slice(0, 300)}`;
    });
    if (parts.length === 0) return;

    const firstList = Object.values(payload).find((value) => Array.isArray(value)) as
      | string[]
      | undefined;
    const title = (firstList?.[0] ?? `${run.templateType} 成果`).slice(0, 80);
    const content = parts.join("\n");

    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId: run.workspaceId,
      title: `🤖 ${title}`,
      content,
      tags: JSON.stringify([run.templateType, "auto"]),
      source: "run",
      runId: run.id,
      createdAt: new Date().toISOString()
    });

    await this.enqueueKnowledgeEmbedding(id, `🤖 ${title}`, content);
  }

  /** J7: keyword search shared by manual search and AI calls. */
  async searchKnowledge(workspaceId: string, query?: string) {
    const all = await this.listKnowledgeEntries(workspaceId);
    const q = query?.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.content.toLowerCase().includes(q) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }

  /**
   * J8: one-line smart capture — LLM parses a sentence into
   * {title, content, tags}; rule-based split without an LLM.
   */
  async smartAddKnowledge(workspaceId: string, text: string) {
    const trimmed = text.trim();
    let title = trimmed.slice(0, 20);
    let content = trimmed;
    let tags: string[] = [];
    let source: "manual" | "ai" = "manual";

    try {
      const result = await generateStructuredForAgent({
        persona:
          "You are a knowledge-capture assistant. The user gives one casual line about their business; you extract a compact structured knowledge entry.",
        instruction:
          "Extract: title (≤16 chars, noun phrase), content (the full fact, cleaned, keep original language), tags (2-4 short labels).",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "content", type: "string", required: true },
          { name: "tags", type: "string[]", required: true }
        ],
        input: { text: trimmed }
      });

      const llmTitle = String(result.title ?? "").trim();
      const llmContent = String(result.content ?? "").trim();
      const llmTags = Array.isArray(result.tags)
        ? result.tags.map(String).map((tag) => tag.trim()).filter(Boolean).slice(0, 4)
        : [];

      if (llmTitle) title = llmTitle.slice(0, 24);
      if (llmContent) content = llmContent;
      tags = llmTags;
      if (llmTags.length > 0) source = "ai";
    } catch {
      // LLM unavailable → rule-based split
      const segments = trimmed.split(/[，。,.;；]/).map((part) => part.trim()).filter(Boolean);
      if (segments.length > 0) title = segments[0].slice(0, 20);
      tags = [];
    }

    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId,
      title,
      content,
      tags: JSON.stringify(tags),
      source,
      createdAt: new Date().toISOString()
    });

    await this.enqueueKnowledgeEmbedding(id, title, content);
    return { id, title, tags };
  }

  /** J7: AI refine — distill recent entries into one brand brief. */
  async refineKnowledgeWithAI(workspaceId: string) {
    const entries = await this.listKnowledgeEntries(workspaceId);
    const recent = entries.slice(0, 8);
    if (recent.length < 2) {
      throw new Error("Need at least 2 knowledge entries to refine");
    }

    let refinedTitle = "品牌速览";
    let refinedContent = "";
    let usedLLM = false;

    try {
      const result = await generateStructuredForAgent({
        persona:
          "You are a brand-knowledge curator. Merge the given knowledge fragments into one crisp brand brief.",
        instruction:
          "Merge these fragments into a single brief. Respond with fields: title (short), content (the merged brief), tags (array).",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "content", type: "string", required: true },
          { name: "tags", type: "string[]", required: true }
        ],
        input: {
          fragments: recent.map((entry) => ({
            title: entry.title,
            content: entry.content.slice(0, 500)
          }))
        }
      });
      refinedTitle = String(result.title ?? refinedTitle).slice(0, 80);
      refinedContent = String(result.content ?? "");
      const tags = Array.isArray(result.tags) ? result.tags.map(String).slice(0, 5) : ["ai"];
      refinedContent += `\n[tags:${tags.join(",")}]`;
      usedLLM = true;
      void tags;
    } catch {
      // LLM unavailable → rule-based merge
    }

    if (!usedLLM) {
      refinedContent = recent
        .map((entry) => `• ${entry.title}: ${entry.content.slice(0, 200)}`)
        .join("\n");
    }

    const tags = usedLLM ? ["ai"] : ["ai", "merged"];
    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId,
      title: `✨ ${refinedTitle}`,
      content: refinedContent,
      tags: JSON.stringify(tags),
      source: "ai",
      createdAt: new Date().toISOString()
    });

    await this.enqueueKnowledgeEmbedding(id, refinedTitle, refinedContent);
    return { id, usedLLM };
  }

  async listArtifacts(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId))
      .orderBy(desc(artifacts.createdAt));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      runId: row.runId,
      agentType: row.agentType,
      kind: row.kind,
      title: row.title,
      summary: row.summary ?? "",
      payload: JSON.parse(row.contentJson) as Record<string, unknown>,
      createdAt: row.createdAt
    }));
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await this.db.delete(artifacts).where(eq(artifacts.id, artifactId));
  }

  // -------------------------------------------------------------------------
  // Knowledge base (J3) — brand facts injected into agent prompts
  // -------------------------------------------------------------------------

  async createKnowledgeEntry(input: {
    workspaceId: string;
    title: string;
    content: string;
    tags?: string[];
  }) {
    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      source: "manual",
      createdAt: new Date().toISOString()
    });
    await this.enqueueKnowledgeEmbedding(id, input.title, input.content);
    return { id };
  }

  /**
   * R2-A3: queue an embed_knowledge durable job for a knowledge entry.
   * No-op when embeddings are unavailable (no OpenAI key) so the queue
   * never accumulates unprocessable work.
   */
  async enqueueKnowledgeEmbedding(knowledgeId: string, title: string, content: string): Promise<void> {
    if (!isEmbeddingEnabled()) return;
    const stubRun: Run = {
      id: knowledgeId,
      workspaceId: "",
      templateType: "embed_knowledge",
      status: "queued",
      input: {},
      currentStep: null,
      approvalStatus: "not_required",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const payload: JobPayload = {
      knowledgeId,
      text: `${title}\n${content}`.slice(0, 6000)
    };
    await this.temporalWorker.enqueue(stubRun, "embed_knowledge", { payload, maxAttempts: 2 });
  }

  /**
   * R2-A3 semantic recall: top-k knowledge by cosine similarity with a
   * time-decay rerank (τ = 30 days). Falls back to most-recent entries when
   * embeddings are unavailable. Raw score kept alongside for debugging.
   */
  async semanticSearchKnowledge(
    workspaceId: string,
    query: string,
    k = 5
  ): Promise<Array<{ id: string; title: string; content: string; createdAt?: string; rawScore: number | null; finalScore: number }>> {
    const queryVector = await embedText(query);

    if (!queryVector) {
      const recent = (await this.listKnowledgeEntries(workspaceId)).slice(0, k);
      return recent.map((entry) => ({
        id: entry.id,
        title: entry.title,
        content: entry.content,
        createdAt: entry.createdAt,
        rawScore: null,
        finalScore: 0
      }));
    }

    const vectorText = `[${queryVector.join(",")}]`;
    const result = (await this.db.execute(sql`
      SELECT id, title, content, created_at AS "createdAt",
             1 - (embedding <=> ${vectorText}::vector) AS score
      FROM knowledge_entries
      WHERE workspace_id = ${workspaceId} AND embedding IS NOT NULL
      ORDER BY embedding <=> ${vectorText}::vector
      LIMIT 20
    `)) as unknown as { rows?: Array<{ id: string; title: string; content: string; createdAt: unknown; score: number }> };

    const now = Date.now();
    const rows = result.rows ?? [];
    return rows
      .map((row) => {
        const createdIso = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? "");
        const ageDays = Math.max(0, (now - Date.parse(createdIso)) / 86_400_000);
        const decayed = Number(row.score) * Math.exp(-ageDays / 30);
        return {
          id: row.id,
          title: row.title,
          content: row.content,
          createdAt: createdIso,
          rawScore: Number(row.score),
          finalScore: decayed
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, k);
  }

  async listKnowledgeEntries(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.workspaceId, workspaceId))
      .orderBy(desc(knowledgeEntries.createdAt));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      content: row.content,
      tags: (() => {
        try {
          return row.tags ? (JSON.parse(row.tags) as string[]) : [];
        } catch {
          return [];
        }
      })(),
      source: row.source,
      runId: row.runId ?? undefined,
      createdAt: row.createdAt
    }));
  }

  async deleteKnowledgeEntry(entryId: string): Promise<void> {
    await this.db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, entryId));
  }

  /** Resolve selected knowledge entries into _knowledge for persona prompts. */
  private async attachKnowledge(run: Run): Promise<Run> {
    const ids = (run.input as { _knowledgeIds?: unknown })._knowledgeIds;
    const input = { ...run.input };
    delete (input as { _knowledgeIds?: unknown })._knowledgeIds;

    if (Array.isArray(ids) && ids.length > 0) {
      // Scope strictly to the run's workspace (audit P0-C5 cross-tenant fix).
      const entries = await this.db
        .select()
        .from(knowledgeEntries)
        .where(
          and(
            eq(knowledgeEntries.workspaceId, run.workspaceId),
            inArray(knowledgeEntries.id, ids.filter((id): id is string => typeof id === "string"))
          )
        );
      input._knowledge = entries.map((entry) => ({ title: entry.title, content: entry.content }));
      return { ...run, input };
    }

    // R2-A3: no explicit selection → semantic recall from business context.
    try {
      const recalled = await this.semanticSearchKnowledge(
        run.workspaceId,
        String(input.businessSummary ?? ""),
        5
      );
      if (recalled.length > 0) {
        input._knowledge = recalled.map((entry) => ({
          title: entry.title,
          content: entry.content
        }));
        (input as { _knowledgeSource?: string })._knowledgeSource = "semantic";
      }
    } catch {
      // Recall is an enhancement — never block run creation.
    }

    return { ...run, input };
  }

  // -------------------------------------------------------------------------
  // Approval inbox (J4)
  // -------------------------------------------------------------------------

  async listPendingApprovals(workspaceId?: string) {
    const baseQuery = this.db
      .select({ approval: approvalRequests, run: runs })
      .from(approvalRequests)
      .innerJoin(runs, eq(approvalRequests.runId, runs.id));

    const rows = workspaceId
      ? await baseQuery
          .where(and(eq(approvalRequests.status, "pending"), eq(runs.workspaceId, workspaceId)))
          .orderBy(desc(approvalRequests.requestedAt))
      : await baseQuery.where(eq(approvalRequests.status, "pending")).orderBy(desc(approvalRequests.requestedAt));

    return rows.map(({ approval, run }) => ({
      approvalId: approval.id,
      actionType: approval.actionType,
      reason: approval.reason,
      requestedAt: approval.requestedAt,
      run: {
        id: run.id,
        workspaceId: run.workspaceId,
        templateType: run.templateType as Run["templateType"],
        status: run.status as Run["status"],
        businessSummary: (() => {
          try {
            const parsed = JSON.parse(run.input) as Record<string, unknown>;
            return String(parsed.businessSummary ?? "");
          } catch {
            return "";
          }
        })()
      }
    }));
  }

  // -------------------------------------------------------------------------
  // Schedules (J4) — recurring agent runs
  // -------------------------------------------------------------------------

  async createSchedule(input: {
    workspaceId: string;
    templateType: string;
    label: string;
    inputPayload: Record<string, unknown>;
    intervalMinutes: number;
  }) {
    const id = `sch_${randomUUID()}`;
    const now = Date.now();
    await this.db.insert(schedules).values({
      id,
      workspaceId: input.workspaceId,
      templateType: input.templateType,
      label: input.label,
      inputJson: JSON.stringify(input.inputPayload),
      intervalMinutes: Math.max(5, input.intervalMinutes),
      nextRunAt: new Date(now + Math.max(5, input.intervalMinutes) * 60_000).toISOString(),
      status: "active",
      createdAt: new Date(now).toISOString()
    });
    return { id };
  }

  async listSchedules(workspaceId?: string) {
    const rows = workspaceId
      ? await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId)).orderBy(desc(schedules.createdAt))
      : await this.db.select().from(schedules).orderBy(desc(schedules.createdAt));
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      templateType: row.templateType,
      label: row.label,
      intervalMinutes: row.intervalMinutes,
      nextRunAt: row.nextRunAt,
      lastRunId: row.lastRunId ?? undefined,
      lastStatus: row.lastStatus ?? undefined,
      status: row.status
    }));
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.db.delete(schedules).where(eq(schedules.id, scheduleId));
  }

  /** Driven by startServer's timer: due schedules → new runs. */
  async processDueSchedules(): Promise<number> {
    const now = new Date().toISOString();
    const due = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.status, "active"), lte(schedules.nextRunAt, now)));

    let launched = 0;
    for (const schedule of due) {
      try {
        const run = await this.createRun({
          workspaceId: schedule.workspaceId,
          templateType: schedule.templateType,
          input: JSON.parse(schedule.inputJson) as Record<string, unknown>
        });
        launched += 1;
        await this.db
          .update(schedules)
          .set({
            lastRunId: run.id,
            lastStatus: "ok",
            nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString()
          })
          .where(eq(schedules.id, schedule.id));
      } catch (scheduleError) {
        this.traceLog.record({
          scope: "control-plane",
          action: "schedule_failed",
          metadata: {
            scheduleId: schedule.id,
            error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError)
          }
        });
        await this.db
          .update(schedules)
          .set({
            lastStatus: "failed",
            nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString()
          })
          .where(eq(schedules.id, schedule.id));
      }
    }
    return launched;
  }

  // -------------------------------------------------------------------------
  // Playbooks (J7) — editable workflow definitions, DB overrides over defaults
  // -------------------------------------------------------------------------

  async getPlaybooks() {
    const defaults = Object.entries(TEAM_PLAYBOOKS).map(([key, steps]) => ({
      key,
      name: key === "sprint" ? "Opening Sprint" : key === "contentReview" ? "Content Weekly Loop" : key,
      steps,
      builtin: true
    }));

    const rows = await this.db.select().from(playbooksTable);
    const overrides = new Map(rows.map((row) => [row.key, row]));

    const merged = defaults.map((preset) => {
      const override = overrides.get(preset.key);
      if (!override) return preset;
      try {
        return {
          key: preset.key,
          name: override.name,
          steps: JSON.parse(override.stepsJson) as TeamStep[],
          builtin: false
        };
      } catch {
        return preset;
      }
    });

    for (const row of rows) {
      if (overrides.has(row.key)) continue;
      if (TEAM_PLAYBOOKS[row.key]) continue; // default already merged
      try {
        merged.push({
          key: row.key,
          name: row.name,
          steps: JSON.parse(row.stepsJson) as TeamStep[],
          builtin: false
        });
      } catch {
        // corrupt row — skip
      }
    }

    return merged;
  }

  async savePlaybook(key: string, input: SavePlaybookInput): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error("Playbook key must be lowercase snake_case");
    }
    const now = new Date().toISOString();
    const isBuiltin = Boolean(TEAM_PLAYBOOKS[key]);
    await this.db
      .insert(playbooksTable)
      .values({
        key,
        name: input.name,
        stepsJson: JSON.stringify(input.steps),
        builtin: isBuiltin,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: playbooksTable.key,
        set: { name: input.name, stepsJson: JSON.stringify(input.steps), updatedAt: now }
      });
  }

  /** launchTeam reads the effective version (defaults + DB overrides). */
  private async getEffectivePlaybook(key: string): Promise<TeamStep[] | null> {
    const rows = await this.db.select().from(playbooksTable).where(eq(playbooksTable.key, key));
    if (rows.length > 0) {
      try {
        return JSON.parse(rows[0].stepsJson) as TeamStep[];
      } catch {
        // fall through to defaults
      }
    }
    return TEAM_PLAYBOOKS[key] ?? null;
  }

  // -------------------------------------------------------------------------
  // Team relay orchestration (J5) — server-side, approval-aware
  // -------------------------------------------------------------------------

  async launchTeam(input: {
    workspaceId: string;
    playbookKey: string;
    goal: string;
    audience?: string;
    crewTeamId?: string;
  }) {
    const steps = await this.getEffectivePlaybook(input.playbookKey);
    if (!steps) {
      throw new NotFoundError(`Unknown playbook: ${input.playbookKey}`);
    }

    if (input.crewTeamId) {
      const crewRows = await this.db
        .select({ id: teams.id, workspaceId: teams.workspaceId, status: teams.status })
        .from(teams)
        .where(eq(teams.id, input.crewTeamId));
      if (
        crewRows.length === 0 ||
        crewRows[0].workspaceId !== input.workspaceId ||
        crewRows[0].status !== "active"
      ) {
        throw new NotFoundError(
          `Active team not found in this workspace: ${input.crewTeamId}`,
          "TEAM_NOT_FOUND"
        );
      }
    }

    const now = new Date().toISOString();
    const relayId = `team_${randomUUID()}`; // NOTE: relayId now in scope for step threading
    await this.db.insert(teamRuns).values({
      id: relayId,
      workspaceId: input.workspaceId,
      playbookKey: input.playbookKey,
      goal: input.goal,
      audience: input.audience ?? "",
      status: "running",
      currentStep: 0,
      stepsJson: JSON.stringify(steps),
      runIdsJson: "[]",
      createdAt: now,
      updatedAt: now,
      ...(input.crewTeamId ? { teamId: input.crewTeamId } : {})
    } as typeof teamRuns.$inferInsert);

    const firstRun = await this.launchTeamStep(relayId);
    return { teamRunId: relayId, run: firstRun };
  }

  /** Create the run for the current step; waiting_approval pauses the team. */
  private async launchTeamStep(relayId: string, crewTeamId?: string): Promise<Run> {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, relayId));
    const team = rows[0];
    if (!team) throw new NotFoundError(`Team run not found: ${relayId}`);

    const steps = JSON.parse(team.stepsJson) as TeamStep[];
    const stepIndex = team.currentStep;
    const step = steps[stepIndex];

    const runIds = (() => {
      try {
        return JSON.parse(team.runIdsJson) as string[];
      } catch {
        return [];
      }
    })();

    const carried =
      runIds.length > 0 && step.feedFrom.length > 0
        ? await this.getCarriedPayload(runIds[runIds.length - 1], step.feedFrom)
        : "";

    let run: Run;
    try {
      run = await this.createRun({
        workspaceId: team.workspaceId,
        templateType: step.templateType as never,
        input: {
          businessSummary: carried
            ? `${team.goal}\n[Carried from previous step]\n${carried}`
            : team.goal,
          targetCustomer: team.audience || "目标客群",
          preferredChannels: ["email"],
          ...(step.templateType === "content_acquisition"
            ? { contentGoal: "团队接力产出" }
            : step.templateType === "private_conversion"
              ? { offerAsset: "团队接力 offer" }
              : { metricsWindowDays: 7 }),
          // Thread the crew-team linkage so step runs carry teamId (Round V).
          ...((team as { teamId?: string | null }).teamId
            ? { _teamId: (team as { teamId: string }).teamId }
            : {}),
          // Relay instance id (Round V/U): enables waiting-state mirroring.
          ...(relayId ? { _relayId: relayId } : {})
        }
      });
    } catch (error) {
      await this.db
        .update(teamRuns)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, relayId));
      throw error;
    }

    if (run.status === "completed") {
      runIds.push(run.id);
      await this.advanceTeam(relayId, steps, runIds);
    } else {
      runIds.push(run.id);
      const status = run.status === "waiting_approval" ? "waiting_approval" : team.status;
      await this.db
        .update(teamRuns)
        .set({ runIdsJson: JSON.stringify(runIds), status, updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, relayId));
    }

    return run;
  }

  /** Completion hook: the active team whose latest run finished advances. */
  async advanceTeamOnCompletion(completedRun: Run): Promise<void> {
    // Include paused relays: a paused team must still ADVANCE its pointer at
    // the completion boundary (advanceTeam skips only the launch, Round V).
    const activeTeams = await this.db
      .select()
      .from(teamRuns)
      .where(
        and(
          eq(teamRuns.workspaceId, completedRun.workspaceId),
          inArray(teamRuns.status, ["running", "paused"])
        )
      );

    for (const team of activeTeams) {
      let runIds: string[] = [];
      try {
        runIds = JSON.parse(team.runIdsJson) as string[];
      } catch {
        continue;
      }
      const last = runIds[runIds.length - 1];
      if (!last || last !== completedRun.id) continue;

      const steps = JSON.parse(team.stepsJson) as TeamStep[];
      await this.advanceTeam(team.id, steps, runIds);
    }
  }

  /**
   * 队级控制(Round V):
   * - cancelled: 级联取消所有未终态的步骤 run;
   * - paused: 即时置停,完成钩子见 paused 不再推进;
   * - running(自 paused 恢复): 续跑当前步骤。
   */
  async updateRelayRunStatus(
    relayId: string,
    status: "running" | "paused" | "cancelled"
  ): Promise<unknown> {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, relayId));
    const relay = rows[0];
    if (!relay) throw new NotFoundError(`Team run not found: ${relayId}`);

    const terminal = new Set(["completed", "failed", "cancelled"]);
    if (terminal.has(relay.status)) {
      throw new Error(`Relay run is already ${relay.status}`);
    }

    let nextStatus = status;

    if (status === "cancelled") {
      // Cascade-cancel every non-terminal step run.
      const runIds = (() => {
        try {
          return JSON.parse(relay.runIdsJson) as string[];
        } catch {
          return [];
        }
      })();
      for (const runId of runIds) {
        try {
          const stepRun = await this.getRun(runId);
          if (["queued", "running", "waiting_approval"].includes(stepRun.status)) {
            await this.cancelRun(runId);
          }
        } catch {
          // step row may be missing — skip
        }
      }
    }

    if (status === "running" && relay.status === "paused") {
      nextStatus = "running";
    }
    // Pausing a waiting_approval relay is honored at the completion boundary:
    // advanceTeam skips launching the next step while paused.

    await this.db
      .update(teamRuns)
      .set({ status: nextStatus, updatedAt: new Date().toISOString() })
      .where(eq(teamRuns.id, relayId));

    this.traceLog.record({
      scope: "control-plane",
      action: "relay_status_changed",
      metadata: { relayId, from: relay.status, to: nextStatus }
    });

    // Resume from pause → continue the current step immediately.
    if (status === "running" && relay.status === "paused") {
      await this.launchTeamStep(relayId);
    }

    return this.getTeam(relayId);
  }

  private async advanceTeam(
    relayId: string,
    steps: TeamStep[],
    runIds: string[]
  ): Promise<void> {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, relayId));
    const team = rows[0];
    if (!team || team.status === "failed") {

      return;
    }

    const nextIndex = team.currentStep + 1;

    if (nextIndex >= steps.length) {
      await this.db
        .update(teamRuns)
        .set({ status: "completed", currentStep: steps.length - 1, runIdsJson: JSON.stringify(runIds), updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, relayId));
      return;
    }

    // Advance the pointer even while paused (Round V): resuming must continue
    // from the NEXT step, not re-run the one that just finished.
    await this.db
      .update(teamRuns)
      .set({ currentStep: nextIndex, runIdsJson: JSON.stringify(runIds), updatedAt: new Date().toISOString() })
      .where(eq(teamRuns.id, relayId));

    if (team.status === "paused") return;

    await this.launchTeamStep(relayId);
  }

  private async getCarriedPayload(
    runId: string,
    feedFrom: string[]
  ): Promise<string> {
    const run = await this.getRun(runId);
    const payload = run.outputPayload ?? {};
    return carriedSummary(payload, feedFrom);
  }

  async getTeam(teamId: string) {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, teamId));
    const team = rows[0];
    if (!team) throw new NotFoundError(`Team run not found: ${teamId}`);

    let steps: TeamStep[] = [];
    let runIds: string[] = [];
    try {
      steps = JSON.parse(team.stepsJson) as TeamStep[];
    } catch {}
    try {
      runIds = JSON.parse(team.runIdsJson) as string[];
    } catch {}

    const runsById = new Map<string, Run>();
    for (const runId of runIds) {
      try {
        runsById.set(runId, await this.getRun(runId));
      } catch {
        // run row may be missing — skip
      }
    }

    return {
      id: team.id,
      workspaceId: team.workspaceId,
      playbookKey: team.playbookKey,
      goal: team.goal,
      audience: team.audience,
      status: team.status,
      currentStep: team.currentStep,
      steps: steps.map((step, index) => {
        const stepRunId = runIds[index];
        const stepRun = stepRunId ? runsById.get(stepRunId) : undefined;
        let durationSec: number | null = null;
        if (stepRun?.startedAt && stepRun?.completedAt) {
          const startMs = Date.parse(stepRun.startedAt);
          const endMs = Date.parse(stepRun.completedAt);
          if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
            durationSec = Math.round((endMs - startMs) / 1000);
          }
        }

        const outputFields: Record<string, string> = {};
        if (stepRun?.outputPayload) {
          for (const [key, value] of Object.entries(stepRun.outputPayload)) {
            outputFields[key] = Array.isArray(value)
              ? value.join("; ")
              : String(value);
          }
        }

        return {
          ...step,
          state:
            index < team.currentStep
              ? "done"
              : index === team.currentStep
                ? team.status === "completed"
                  ? "done"
                  : team.status
                : "pending",
          runId: stepRunId,
          startedAt: stepRun?.startedAt,
          completedAt: stepRun?.completedAt,
          durationSec,
          outputSummary: (() => {
            const values = Object.values(stepRun?.outputPayload ?? {});
            const firstList = values.find((value) => Array.isArray(value)) as string[] | undefined;
            const firstString = values.find((value) => typeof value === "string") as string | undefined;
            return (firstList?.join(" / ") ?? firstString ?? "").slice(0, 120);
          })(),
          outputFields
        };
      }),
      createdAt: team.createdAt,
      updatedAt: team.updatedAt
    };
  }

  async listTeams(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(teamRuns)
      .where(eq(teamRuns.workspaceId, workspaceId))
      .orderBy(desc(teamRuns.createdAt));
    return rows.map((row) => ({
      id: row.id,
      playbookKey: row.playbookKey,
      goal: row.goal,
      status: row.status,
      currentStep: row.currentStep,
      createdAt: row.createdAt
    }));
  }

  // -------------------------------------------------------------------------
  // P1 Crew — persistent teams (Round U, deliverable 60)
  // -------------------------------------------------------------------------

  async createCrewTeam(
    workspaceId: string,
    input: { name: string; goal?: string },
    ownerId?: string
  ): Promise<unknown> {
    await this.assertWorkspaceExists(workspaceId);
    const now = new Date().toISOString();
    const row = {
      id: `crew_${randomUUID()}`,
      workspaceId,
      name: input.name,
      goal: input.goal ?? "",
      status: "active" as const,
      createdAt: now,
      updatedAt: now
    };
    await this.db.insert(teams).values(row);
    await this.recordProductEvent(workspaceId, ownerId ?? null, "team.created", {
      teamId: row.id
    });
    return { ...row, members: [] as unknown[] };
  }

  async listCrewTeams(workspaceId: string): Promise<unknown[]> {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select()
      .from(teams)
      .where(eq(teams.workspaceId, workspaceId))
      .orderBy(desc(teams.createdAt));
    const memberRows = await this.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.workspaceId, workspaceId));

    return rows.map((team) => ({
      ...team,
      members: memberRows.filter((member) => member.teamId === team.id)
    }));
  }

  private async getCrewTeamRow(teamId: string) {
    const rows = await this.db.select().from(teams).where(eq(teams.id, teamId));
    if (rows.length === 0) {
      throw new NotFoundError(`Team not found: ${teamId}`);
    }
    return rows[0];
  }

  async getCrewTeam(teamId: string): Promise<unknown> {
    const team = await this.getCrewTeamRow(teamId);
    const members = await this.db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.teamId, teamId))
      .orderBy(desc(teamMembers.createdAt));
    return { ...team, members };
  }

  /** active ⇄ paused；active|paused → archived（单向终态）。 */
  async setCrewTeamStatus(teamId: string, status: "active" | "paused" | "archived"): Promise<void> {
    const team = await this.getCrewTeamRow(teamId);
    const allowed: Record<string, string[]> = {
      active: ["paused", "archived"],
      paused: ["active", "archived"],
      archived: []
    };
    if (!allowed[team.status].includes(status)) {
      throw new Error(`Cannot transition team from '${team.status}' to '${status}'`);
    }
    await this.db
      .update(teams)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(eq(teams.id, teamId));
  }

  async addCrewMember(
    teamId: string,
    agentId: string,
    position: "content" | "conversion" | "review" | "operator"
  ): Promise<{ id: string }> {
    const team = await this.getCrewTeamRow(teamId);
    if (team.status !== "active") {
      throw new Error(`Cannot add members to a ${team.status} team`);
    }
    // Accept either the registry id (`agt_<slug>`) or the raw row id.
    const agentKey = agentId.startsWith("agt_") ? agentId.slice(4) : agentId;
    const agentRows = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(or(eq(agents.id, agentId), eq(agents.slug, agentKey)));
    if (agentRows.length === 0) {
      throw new NotFoundError(`Agent not found: ${agentId}`);
    }
    const resolvedAgentId = agentRows[0].id;
    const existing = await this.db
      .select({ id: teamMembers.id })
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.agentId, resolvedAgentId)));
    if (existing.length > 0) {
      throw new Error("Agent already belongs to this team");
    }
    const id = `tm_${randomUUID()}`;
    await this.db.insert(teamMembers).values({
      id,
      teamId,
      workspaceId: team.workspaceId,
      agentId: resolvedAgentId,
      position,
      createdAt: new Date().toISOString()
    });
    return { id };
  }

  async removeCrewMember(teamId: string, memberId: string): Promise<void> {
    await this.getCrewTeamRow(teamId);
    await this.db
      .delete(teamMembers)
      .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.id, memberId)));
  }

  // -------------------------------------------------------------------------
  // R2-D — industry benchmark cloud (Round Y, deliverable 62)
  // -------------------------------------------------------------------------

  /**
   * Aggregate completed/failed runs by industry × template_type into
   * industry_benchmarks. Only groups with ≥5 samples are recorded
   * (k-anonymity). Call periodically or on demand.
   */
  async computeIndustryBenchmarks(): Promise<number> {
    const result = (await this.db.execute(sql`
      SELECT w.industry, r.template_type,
             count(*)::int AS total,
             count(CASE WHEN r.status = 'completed' THEN 1 END)::int AS completed,
             CASE WHEN count(*) > 0
                  THEN count(CASE WHEN r.status = 'completed' THEN 1 END)::real / count(*)::real
                  ELSE NULL END AS success_rate,
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.completed_at - r.started_at))
             )::real AS p50_duration_sec,
             percentile_cont(0.9) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (r.completed_at - r.started_at))
             )::real AS p90_duration_sec
      FROM runs r
      JOIN workspaces w ON r.workspace_id = w.id
      WHERE w.industry IS NOT NULL AND w.industry != ''
        AND r.status IN ('completed', 'failed')
      GROUP BY w.industry, r.template_type
      HAVING count(*) >= 5
    `)) as unknown as { rows: Array<{ industry: string; template_type: string; total: number; completed: number; success_rate: number | null; p50_duration_sec: number | null; p90_duration_sec: number | null }> };

    let upserted = 0;
    for (const row of result.rows ?? []) {
      const id = `bench_${row.industry}_${row.template_type}`.replace(/[^a-zA-Z0-9_]/g, "_");
      await this.db
        .insert(industryBenchmarks)
        .values({
          id,
          industry: row.industry,
          templateType: row.template_type,
          totalRuns: row.total,
          completedRuns: row.completed,
          successRate: row.success_rate,
          p50DurationSec: row.p50_duration_sec,
          p90DurationSec: row.p90_duration_sec,
          sampleSize: row.total,
          period: "all",
          createdAt: new Date().toISOString()
        })
        .onConflictDoUpdate({
          target: [industryBenchmarks.industry, industryBenchmarks.templateType, industryBenchmarks.period],
          set: {
            totalRuns: row.total,
            completedRuns: row.completed,
            successRate: row.success_rate,
            p50DurationSec: row.p50_duration_sec,
            p90DurationSec: row.p90_duration_sec,
            sampleSize: row.total
          }
        });
      upserted += 1;
    }

    this.traceLog.record({
      scope: "control-plane",
      action: "benchmarks_computed",
      metadata: { groups: String(upserted) }
    });
    return upserted;
  }

  async getIndustryBenchmarks(industry: string) {
    const rows = await this.db
      .select()
      .from(industryBenchmarks)
      .where(eq(industryBenchmarks.industry, industry));
    return rows.map((row) => ({
      industry: row.industry,
      templateType: row.templateType,
      totalRuns: row.totalRuns,
      completedRuns: row.completedRuns,
      successRate: row.successRate,
      p50DurationSec: row.p50DurationSec,
      p90DurationSec: row.p90DurationSec,
      sampleSize: row.sampleSize,
      period: row.period
    }));
  }

  async getWorkspaceIndustry(workspaceId: string): Promise<string | null> {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select({ industry: workspaces.industry })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    return rows[0]?.industry ?? null;
  }

  async setWorkspaceIndustry(workspaceId: string, industry: string): Promise<void> {
    await this.assertWorkspaceExists(workspaceId);
    await this.db
      .update(workspaces)
      .set({ industry: industry || null })
      .where(eq(workspaces.id, workspaceId));
  }

  // -------------------------------------------------------------------------
  // Run analytics (J6) — trends / success rate / per-agent breakdown
  // -------------------------------------------------------------------------

  async getAnalyticsOverview(workspaceId: string, days = 14) {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId));

    const dayBuckets = new Map<string, { total: number; completed: number; failed: number }>();
    const today = new Date();
    const labels: Array<{ key: string; label: string }> = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getTime() - offset * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      labels.push({ key, label: `${day.getMonth() + 1}/${day.getDate()}` });
      dayBuckets.set(key, { total: 0, completed: 0, failed: 0 });
    }

    let completedCount = 0;
    let failedCount = 0;
    let waitingCount = 0;
    let durationTotalMs = 0;
    let durationSamples = 0;
    const byAgent = new Map<string, number>();

    for (const row of rows) {
      const run = rowToRun(row);
      const dayKey = (run.createdAt ?? "").slice(0, 10);
      const bucket = dayBuckets.get(dayKey);

      if (bucket) {
        bucket.total += 1;
        if (run.status === "completed") bucket.completed += 1;
        if (run.status === "failed") bucket.failed += 1;
      }

      byAgent.set(run.templateType, (byAgent.get(run.templateType) ?? 0) + 1);

      if (run.status === "completed") {
        completedCount += 1;
        if (run.startedAt && run.completedAt) {
          const started = Date.parse(run.startedAt);
          const endedAt = Date.parse(run.completedAt);
          if (!Number.isNaN(started) && !Number.isNaN(endedAt) && endedAt >= started) {
            durationTotalMs += endedAt - started;
            durationSamples += 1;
          }
        }
      } else if (run.status === "failed") {
        failedCount += 1;
      } else if (run.status === "waiting_approval") {
        waitingCount += 1;
      }
    }

    const finished = completedCount + failedCount;
    const successRate = finished > 0 ? Math.round((completedCount / finished) * 100) : null;

    return {
      windowDays: days,
      series: labels.map(({ key, label }) => ({
        label,
        ...(dayBuckets.get(key) ?? { total: 0, completed: 0, failed: 0 })
      })),
      totals: {
        all: rows.length,
        completed: completedCount,
        failed: failedCount,
        waiting: waitingCount
      },
      successRate,
      avgDurationSec: durationSamples > 0 ? Math.round(durationTotalMs / durationSamples / 1000) : null,
      byAgent: [...byAgent.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
    };
  }

  // -------------------------------------------------------------------------
  // W3 · simulation project-integration surface — pure functions, zero DB.
  // Fail-closed by construction: callers supply only simulation configs; an
  // adapter manifest is never accepted here (B1 §W3 red line), and kernel
  // errors propagate unchanged so the HTTP layer can relay them as 422.
  // -------------------------------------------------------------------------

  /**
   * Validates one simulation integration config through the shared kernel and
   * returns the derived bundle plus the adapter input projection. Throws the
   * kernel's own message when any fail-closed rule rejects the config.
   *
   * The projection strips the same hard-coded `readiness`/`evidenceAt` fixture
   * constants as `GET /api/integration/adapters`, so both routes expose one
   * consistent adapter shape (I-039).
   */
  validateSimulationIntegration(input: SimulationProjectIntegrationConfigInput): {
    contractVersion: string;
    bundle: SimulationProjectIntegrationBundle;
    adapterInput: SimulationAdapterInputView;
  } {
    const bundle = buildSimulationProjectIntegration(input);
    const [adapterInput] = buildSimulationAdapterInputs({ [bundle.projectKey]: bundle.adapter });
    return {
      contractVersion: INTEGRATION_CONTRACT_VERSION,
      bundle,
      adapterInput: stripAdapterHealthFields(adapterInput)
    };
  }

  /**
   * Lists the pilot simulation integrations by deriving bundles from the
   * fixture configs. Pure and DB-free; adapter projections strip the
   * hard-coded `readiness`/`evidenceAt` constants (not health signals).
   */
  listSimulationIntegrations(): {
    contractVersion: string;
    integrations: SimulationIntegrationRecord[];
  } {
    return {
      contractVersion: INTEGRATION_CONTRACT_VERSION,
      integrations: pilotSimulationIntegrationConfigs.map((config) => {
        const bundle = buildSimulationProjectIntegration(config);
        const [adapterInput] = buildSimulationAdapterInputs({ [bundle.projectKey]: bundle.adapter });
        return {
          summary: {
            projectKey: bundle.projectKey,
            projectId: bundle.project.id,
            packId: bundle.pack.packId,
            packVersion: bundle.pack.version,
            typeKey: bundle.project.typeKey,
            status: bundle.project.status
          },
          bundle,
          adapterInput: stripAdapterHealthFields(adapterInput)
        };
      })
    };
  }

  // -------------------------------------------------------------------------
  // W4 · Registry read surface — DB first, dual reads never fall back on DB
  // errors, per-item source annotation, divergences logged and reported.
  // -------------------------------------------------------------------------

  /**
   * Materializes one pilot registry pack. FIFO-caches DB hits (oldest key
   * evicted past `NEUROCLAW_REGISTRY_CACHE_MAX`); the fixture projection is
   * only used when the pack is absent from the DB. DB errors propagate.
   */
  async getRegistryPack(projectKey: string): Promise<{
    contractVersion: string;
    projectKey: string;
    source: "db" | "fixture";
    pack: { packId: string; version: string; projectId: string };
  }> {
    const cached = this.registryPackCache.get(projectKey);
    if (cached) {
      return cached as {
        contractVersion: string;
        projectKey: string;
        source: "db" | "fixture";
        pack: { packId: string; version: string; projectId: string };
      };
    }
    const fixture = pilotSimulationIntegrationConfigs
      .map((config) => buildSimulationProjectIntegration(config))
      .find((bundle) => bundle.projectKey === projectKey);
    if (!fixture) {
      throw new NotFoundError(
        `Registry project not found: ${projectKey}`,
        "REGISTRY_PROJECT_NOT_FOUND"
      );
    }
    const dbPack = await this.getProjectPack(fixture.pack.packId, fixture.pack.version);
    const result = {
      contractVersion: REGISTRY_CONTRACT_VERSION,
      projectKey,
      source: (dbPack ? "db" : "fixture") as "db" | "fixture",
      pack: dbPack
        ? {
            packId: dbPack.packId,
            version: dbPack.version,
            projectId: dbPack.projectId ?? fixture.project.id
          }
        : {
            packId: fixture.pack.packId,
            version: fixture.pack.version,
            projectId: fixture.project.id
          }
    };
    if (dbPack) {
      if (this.registryPackCache.size >= this.registryCacheMax) {
        const oldest = this.registryPackCache.keys().next().value;
        if (oldest !== undefined) this.registryPackCache.delete(oldest);
      }
      this.registryPackCache.set(projectKey, result);
    }
    return result;
  }

  /**
   * Dual read of registry packs: DB entries first, then fixture-only
   * projections. A DB failure is awaited and propagated untouched.
   */
  async listRegistryPacks(): Promise<
    RegistryListResponse<{
      packId: string;
      version: string;
      projectId?: string;
      projectKey?: string;
      source: "db" | "fixture";
    }> & { contractVersion: string; diverged: string[] }
  > {
    const dbEntries = await this.listProjectPackRegistryEntries();
    const dbItems = dbEntries.map((entry) => ({
      packId: entry.packId,
      version: entry.version,
      projectId: entry.projectId,
      source: "db" as const
    }));
    const fixtureItems = pilotSimulationIntegrationConfigs
      .map((config) => buildSimulationProjectIntegration(config))
      .map((bundle) => ({
        packId: bundle.pack.packId,
        version: bundle.pack.version,
        projectId: bundle.project.id,
        projectKey: bundle.projectKey,
        source: "fixture" as const
      }));
    const packKey = (packId: string, version: string): string => `${packId}@${version}`;
    const dbKeys = new Set(dbItems.map((item) => packKey(item.packId, item.version)));
    const fixtureKeys = new Set(fixtureItems.map((item) => packKey(item.packId, item.version)));
    const fixtureOnly = fixtureItems.filter((item) => !dbKeys.has(packKey(item.packId, item.version)));
    const diverged = [
      ...dbItems
        .filter((item) => !fixtureKeys.has(packKey(item.packId, item.version)))
        .map((item) => `${packKey(item.packId, item.version)} (db-only)`),
      ...fixtureOnly.map((item) => `${packKey(item.packId, item.version)} (fixture-only)`)
    ];
    if (diverged.length > 0) {
      console.warn(`[registry] pack divergence detected: ${diverged.join(", ")}`);
    }
    return {
      contractVersion: REGISTRY_CONTRACT_VERSION,
      source: "dual",
      items: [...dbItems, ...fixtureOnly],
      diverged
    };
  }

  /**
   * Dual read of registry adapters: DB manifests first, then fixture-only
   * projections. A DB failure is awaited and propagated untouched.
   */
  async listRegistryAdapters(): Promise<
    RegistryListResponse<{
      adapterId: string;
      version: string;
      packId?: string;
      packVersion?: string;
      projectRef?: string;
      projectKey?: string;
      source: "db" | "fixture";
    }> & { contractVersion: string; diverged: string[] }
  > {
    // The registry row (not the raw manifestSnapshot) carries the pack binding,
    // so read adapter registry entries to surface the same packId/packVersion
    // keys as fixture entries: HTTP packId/packVersion filters must cover db ∪ fixture.
    const adapterEntries = (
      await this.db.select().from(adapterRegistry).orderBy(desc(adapterRegistry.updatedAt))
    ).map(rowToAdapterRegistryEntry);
    const dbItems = adapterEntries.map((entry) => ({
      adapterId: entry.adapterId,
      version: entry.version,
      packId: entry.packId,
      packVersion: entry.packVersion,
      projectRef: entry.projectId,
      source: "db" as const
    }));
    const fixtureItems = pilotSimulationIntegrationConfigs
      .map((config) => buildSimulationProjectIntegration(config))
      .map((bundle) => {
        const raw = bundle.adapter as unknown as Record<string, unknown>;
        const adapterId =
          typeof raw.adapterId === "string" ? raw.adapterId : `${bundle.projectKey}-adapter`;
        const version =
          typeof raw.version === "string"
            ? raw.version
            : typeof raw.adapterVersion === "string"
              ? raw.adapterVersion
              : "0.0.0";
        return {
          adapterId,
          version,
          packId: bundle.pack.packId,
          packVersion: bundle.pack.version,
          projectKey: bundle.projectKey,
          source: "fixture" as const
        };
      });
    const adapterKey = (adapterId: string, version: string): string => `${adapterId}@${version}`;
    const dbKeys = new Set(dbItems.map((item) => adapterKey(item.adapterId, item.version)));
    const fixtureKeys = new Set(fixtureItems.map((item) => adapterKey(item.adapterId, item.version)));
    const fixtureOnly = fixtureItems.filter(
      (item) => !dbKeys.has(adapterKey(item.adapterId, item.version))
    );
    const diverged = [
      ...dbItems
        .filter((item) => !fixtureKeys.has(adapterKey(item.adapterId, item.version)))
        .map((item) => `${adapterKey(item.adapterId, item.version)} (db-only)`),
      ...fixtureOnly.map((item) => `${adapterKey(item.adapterId, item.version)} (fixture-only)`)
    ];
    if (diverged.length > 0) {
      console.warn(`[registry] adapter divergence detected: ${diverged.join(", ")}`);
    }
    return {
      contractVersion: REGISTRY_CONTRACT_VERSION,
      source: "dual",
      items: [...dbItems, ...fixtureOnly],
      diverged
    };
  }

  /**
   * Pilot registry coverage: every fixture project whose pack is visible in
   * the merged registry (DB or fixture) counts as covered; the match flag
   * reports strict DB parity for all fixture pack versions.
   */
  async getRegistryCoverage(): Promise<
    RegistryCoverageReport & { contractVersion: string; diverged: string[] }
  > {
    const packs = await this.listRegistryPacks();
    const adapters = await this.listRegistryAdapters();
    const fixtures = pilotSimulationIntegrationConfigs.map((config) =>
      buildSimulationProjectIntegration(config)
    );
    const dbPackKeys = new Set(
      packs.items
        .filter((item) => item.source === "db")
        .map((item) => `${item.packId}@${item.version}`)
    );
    const covered = fixtures.filter((bundle) =>
      packs.items.some(
        (item) => item.packId === bundle.pack.packId && item.version === bundle.pack.version
      )
    ).length;
    return {
      contractVersion: REGISTRY_CONTRACT_VERSION,
      pilotProjectsCovered: `${covered}/${fixtures.length}`,
      packVersionsMatchFixtures:
        fixtures.length > 0 &&
        fixtures.every((bundle) => dbPackKeys.has(`${bundle.pack.packId}@${bundle.pack.version}`)),
      source: "dual",
      diverged: [...packs.diverged, ...adapters.diverged]
    };
  }

  /** Aggregates the merged registry packs by pilot project. */
  async listRegistryProjects(): Promise<
    RegistryListResponse<
      RegistryProjectAggregate<{ packId: string; version: string; source: "db" | "fixture" }>
    > & { contractVersion: string; diverged: string[] }
  > {
    const packs = await this.listRegistryPacks();
    const byProject = new Map<
      string,
      { projectId: string; packs: Array<{ packId: string; version: string; source: "db" | "fixture" }> }
    >();
    for (const item of packs.items) {
      const projectId = item.projectKey ?? item.projectId ?? "unknown";
      const aggregate = byProject.get(projectId) ?? { projectId, packs: [] };
      aggregate.packs.push({ packId: item.packId, version: item.version, source: item.source });
      byProject.set(projectId, aggregate);
    }
    return {
      contractVersion: REGISTRY_CONTRACT_VERSION,
      source: "dual",
      items: [...byProject.values()],
      diverged: packs.diverged
    };
  }

  // -------------------------------------------------------------------------
  // W4 · Registry write surface — thin wrappers over the AC-3-0 snapshots with
  // the registry-level gates applied first; immutable-identity conflicts are
  // translated into RegistryConflictError for the HTTP layer.
  // -------------------------------------------------------------------------

  /** Persists one simulation-only Adapter snapshot, gated before any DB write. */
  async persistSimulationOnlyAdapter(
    input: AdapterManifest,
    options: AdapterRegistryOptions
  ): Promise<AdapterManifest> {
    return this.persistAdapterManifest(assertSimulationOnlyAdapter(input), options);
  }

  /**
   * Persists one registry Pack snapshot. The AC-3-0 immutable-identity conflict
   * surfaces as RegistryConflictError; every other failure propagates untouched.
   */
  async persistRegistryPack(
    input: ProjectPackManifest,
    options: ProjectPackRegistryOptions = {}
  ): Promise<ProjectPackManifest> {
    try {
      return await this.persistProjectPack(input, options);
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists and is immutable")) {
        throw new RegistryConflictError(error.message);
      }
      throw error;
    }
  }

  /**
   * Minimal simulation-config persist path: the raw config enters the shared
   * kernel directly (never pre-parsed — parse output ≠ input), then the derived
   * bundle is written Pack-first so the adapter snapshot can bind to its exact
   * local Pack. 最小实现，待 P2 对齐（返回契约 / HTTP 端点映射）。
   */
  async persistSimulationIntegrationConfig(
    input: SimulationProjectIntegrationConfigInput
  ): Promise<{
    contractVersion: string;
    projectKey: string;
    packId: string;
    packVersion: string;
    adapterId: string;
    adapterVersion: string;
  }> {
    const bundle = buildSimulationProjectIntegration(input);
    await this.persistProjectPack(bundle.pack, {
      project: bundle.project,
      workflows: [bundle.workflow],
      adapters: [bundle.adapter]
    });
    await this.persistAdapterManifest(bundle.adapter, {
      pack: bundle.pack,
      project: bundle.project,
      workflows: [bundle.workflow]
    });
    return {
      contractVersion: INTEGRATION_CONTRACT_VERSION,
      projectKey: bundle.projectKey,
      packId: bundle.pack.packId,
      packVersion: bundle.pack.version,
      adapterId: bundle.adapter.adapterId,
      adapterVersion: bundle.adapter.version
    };
  }

  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const rows = await this.db.select().from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (rows.length === 0) {
      throw new NotFoundError(
        `Workspace not found: ${workspaceId}`,
        "WORKSPACE_NOT_FOUND"
      );
    }
  }
}
