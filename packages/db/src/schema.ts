import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  timestamp,
  integer,
  bigint,
  boolean,
  real,
  index,
  uniqueIndex,
  vector
} from "drizzle-orm/pg-core";

// R2-A1/O (ADR-56 + Appendix B): dialect = Postgres.
//
// Temporal mapping decision (I-043 方案 A): physical columns are TIMESTAMPTZ
// (migration 0001) and every temporal drizzle column below declares
// `timestamp({ withTimezone: true, mode: "string" })` so the schema matches
// the database. `mode: "string"` keeps the application contract at ISO-8601
// UTC strings (no driver Date objects); the node-postgres type parser in
// db/index.ts normalizes every read to ISO. Parity with the physical columns
// is pinned by schema-introspection.test.ts (information_schema vs this file).
// Vector column on knowledge_entries powers semantic recall (R2-A3).

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  // R2-D (Round Y): optional user-declared industry for benchmark aggregation.
  industry: text("industry")
});

// ---------------------------------------------------------------------------
// Workspace membership — multi-tenant ACL baseline (Round J / audit P0-C4)
// ---------------------------------------------------------------------------

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role").notNull(), // 'admin' | 'operator' | 'viewer'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_members_ws_user").on(table.workspaceId, table.userId)]
);

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    templateType: text("template_type").notNull(),
    status: text("status").notNull(),
    input: text("input").notNull(),
    outputPayload: text("output_payload"),
    failureReason: text("failure_reason"),
    currentStep: text("current_step"),
    approvalStatus: text("approval_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" }),
    stepResults: text("step_results"),
    tokensUsed: integer("tokens_used"),
    costUsd: real("cost_usd"),
    // P1 Crew (Round V): relay-step runs carry the originating team.
    teamId: text("team_id"),
    // P1 Crew (Round U/V): owning relay-run instance (for status mirroring).
    relayId: text("relay_id")
  },
  (table) => [index("idx_runs_ws_created").on(table.workspaceId, table.createdAt)]
);

// ---------------------------------------------------------------------------
// Universal WorkItem compatibility bindings (AC-4-0)
// ---------------------------------------------------------------------------

/**
 * One row is one idempotent compatibility view over an existing Legacy Run.
 * The legacy run remains the execution fact source; JSON columns preserve the
 * validated Universal WorkItem/Run/Receipt snapshots without creating a new
 * executor or a second run row.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: text("id").primaryKey(),
    legacyRunId: text("legacy_run_id").notNull(),
    projectId: text("project_id").notNull(),
    initiativeId: text("initiative_id").notNull(),
    assigneeRef: text("assignee_ref").notNull(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    scopeProjectId: text("scope_project_id").notNull(),
    packId: text("pack_id").notNull(),
    packVersion: text("pack_version").notNull(),
    workflowRef: text("workflow_ref").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    adapterRef: text("adapter_ref").notNull(),
    adapterVersion: text("adapter_version").notNull(),
    packSnapshotRef: text("pack_snapshot_ref").notNull(),
    workflowSnapshotRef: text("workflow_snapshot_ref").notNull(),
    adapterSnapshotRef: text("adapter_snapshot_ref").notNull(),
    inputSnapshotRef: text("input_snapshot_ref").notNull(),
    policySnapshotRef: text("policy_snapshot_ref").notNull(),
    workItemJson: text("work_item_json").notNull(),
    runJson: text("run_json").notNull(),
    receiptJson: text("receipt_json"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    uniqueIndex("idx_work_items_legacy_run").on(table.legacyRunId),
    index("idx_work_items_scope").on(table.projectId, table.scopeProjectId, table.workspaceId),
    index("idx_work_items_workflow").on(table.workflowRef, table.workflowVersion)
  ]
);

// ---------------------------------------------------------------------------
// Universal kernel — Attempt / ReplayCheckpoint / Universal Audit (AC-6)
// ---------------------------------------------------------------------------

const universalPersistenceScopeColumns = () => ({
  organizationId: text("organization_id"),
  workspaceId: text("workspace_id"),
  projectId: text("project_id")
});

export const attempts = pgTable(
  "attempts",
  {
    id: text("id").primaryKey(),
    ...universalPersistenceScopeColumns(),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    runId: text("run_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    workflowRef: text("workflow_ref"),
    status: text("status").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    checkpointRef: text("checkpoint_ref"),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    uniqueIndex("idx_attempts_run_number").on(table.runId, table.attemptNumber),
    uniqueIndex("idx_attempts_idempotency").on(table.idempotencyKey),
    index("idx_attempts_scope").on(table.projectId, table.workspaceId, table.organizationId)
  ]
);

export const replayCheckpoints = pgTable(
  "replay_checkpoints",
  {
    id: text("id").primaryKey(),
    ...universalPersistenceScopeColumns(),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    runId: text("run_id").notNull(),
    workItemId: text("work_item_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    sequence: integer("sequence").notNull(),
    workflowVersion: text("workflow_version").notNull(),
    workflowRef: text("workflow_ref"),
    stateHash: text("state_hash").notNull(),
    sourceEventRefs: text("source_event_refs").notNull(),
    status: text("status").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    uniqueIndex("idx_replay_checkpoints_attempt_sequence").on(table.attemptId, table.sequence),
    index("idx_replay_checkpoints_scope").on(table.projectId, table.workspaceId, table.organizationId)
  ]
);

export const universalAuditEvents = pgTable(
  "universal_audit_events",
  {
    id: text("id").primaryKey(),
    ...universalPersistenceScopeColumns(),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id").notNull(),
    receiptRef: text("receipt_ref"),
    sequence: integer("sequence").notNull(),
    eventType: text("event_type").notNull(),
    actorRef: text("actor_ref").notNull(),
    subjectRef: text("subject_ref").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    payload: text("payload").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    uniqueIndex("idx_universal_audit_run_sequence").on(table.runId, table.sequence),
    uniqueIndex("idx_universal_audit_idempotency").on(table.idempotencyKey),
    index("idx_universal_audit_scope").on(table.projectId, table.workspaceId, table.organizationId)
  ]
);

export const auditEventRecords = universalAuditEvents;

export const auditEvents = pgTable("audit_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    actionType: text("action_type").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true, mode: "string" }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
    resolution: text("resolution")
  },
  (table) => [index("idx_approvals_run").on(table.runId)]
);

export const memoryRecords = pgTable(
  "memory_records",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    templateType: text("template_type").notNull(),
    type: text("type").notNull(),
    summary: text("summary").notNull(),
    sourceRunId: text("source_run_id").notNull(),
    isPinned: boolean("is_pinned").notNull(),
    isSuppressed: boolean("is_suppressed").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    // P1 Crew (Round U): 'private' | 'team' — team-visible memories are
    // readable by every member of the owning workspace.
    visibility: text("visibility").notNull().default("private")
  },
  (table) => [index("idx_memory_ws").on(table.workspaceId)]
);

// ---------------------------------------------------------------------------
// Durable job queue — three-table model for claim/process/retry/recovery
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    type: text("type").notNull(), // 'execute_run' | 'resume_approved_run'
    status: text("status").notNull(), // 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'retry_scheduled'
    payload: text("payload"), // JSON: { approvedActions?: string[] }
    // I-042 D2: database-side dedup guard for resume actions. NULL for every
    // pre-existing enqueue path; the plain unique index tolerates multiple
    // NULLs, so those paths stay untouched.
    idempotencyKey: text("idempotency_key"),
    maxAttempts: integer("max_attempts").notNull().default(3),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true, mode: "string" }),
    completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
  },
  (table) => [
    index("idx_jobs_status_next").on(table.status, table.nextAttemptAt),
    uniqueIndex("idx_jobs_idempotency_key").on(table.idempotencyKey)
  ]
);

export const jobAttempts = pgTable("job_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(), // 'started' | 'completed' | 'failed'
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "string" })
});

// I-042 D1: durable mirror of the DurableJobQueue lifecycle checkpoints.
// Append-only; the same (run_id, stage) may recur across retries, so only a
// surrogate id is unique. Physical created_at is TIMESTAMPTZ (see the
// timestamp mapping note above); the app contract stays ISO-8601 UTC strings.
// I-042 D2: `seq` (migration 0014) is the DB-assigned append order and the
// authoritative read/resume order — (created_at, id) tie-breaking is gone.
export const runLifecycleCheckpoints = pgTable(
  "run_lifecycle_checkpoints",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    stage: text("stage").notNull(), // 'queued' | 'runtime' | 'waiting_approval' | 'completed' | 'failed'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    seq: bigint("seq", { mode: "number" })
      .notNull()
      .default(sql`nextval('run_lifecycle_checkpoints_seq_seq')`)
  },
  (table) => [
    index("idx_run_lifecycle_checkpoints_run_created").on(table.runId, table.createdAt),
    index("idx_run_lifecycle_checkpoints_run_seq").on(table.runId, table.seq)
  ]
);

// ---------------------------------------------------------------------------
// Custom agents — data-driven agent definitions (J2)
// ---------------------------------------------------------------------------

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  baseEngine: text("base_engine").notNull(),
  persona: text("persona").notNull(),
  // AW-5 片1: 岗位键（AgentRoleKey，contract §1）。可空过渡（旧行兼容）；
  // 值域由 control-plane 注册边界 fail-closed 解析保证（migration 0015）。
  role: text("role"),
  description: text("description"),
  focusAreas: text("focus_areas"), // JSON string[]
  outputStyle: text("output_style").notNull().default("structured"),
  toolNames: text("tool_names"), // JSON string[]
  status: text("status").notNull().default("active"), // 'active' | 'inactive'
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
});

// ---------------------------------------------------------------------------
// Artifacts library — every completed run deposits a reusable deliverable (J3)
// ---------------------------------------------------------------------------

export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    runId: text("run_id").notNull(),
    agentType: text("agent_type").notNull(),
    kind: text("kind").notNull(), // 'note' | 'copy' | 'report' | 'generic'
    title: text("title").notNull(),
    summary: text("summary"),
    contentJson: text("content_json").notNull(), // full output payload
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_artifacts_ws").on(table.workspaceId)]
);

// ---------------------------------------------------------------------------
// Knowledge base — brand facts & playbooks injected into agent prompts (J3)
// ---------------------------------------------------------------------------

export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    tags: text("tags"), // JSON string[]
    source: text("source").notNull().default("manual"), // 'manual' | 'run' | 'ai'
    runId: text("run_id"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    // R2-A3: pgvector embedding (1536 dims, text-embedding-3-small). Written
    // asynchronously by the embed_knowledge durable job; nullable until then.
    embedding: vector("embedding", { dimensions: 1536 })
  },
  (table) => [index("idx_knowledge_ws").on(table.workspaceId)]
);

// ---------------------------------------------------------------------------
// Playbooks — editable workflow definitions (J7)
// ---------------------------------------------------------------------------

export const playbooks = pgTable("playbooks", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  stepsJson: text("steps_json").notNull(), // JSON [{templateType, roleKey, feedFrom}]
  builtin: boolean("builtin").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
});

// ---------------------------------------------------------------------------
// Schedules — recurring agent runs (J4)
// ---------------------------------------------------------------------------

export const schedules = pgTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    templateType: text("template_type").notNull(),
    label: text("label").notNull(),
    inputJson: text("input_json").notNull(), // run input payload
    intervalMinutes: integer("interval_minutes").notNull().default(1440),
    nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "string" }).notNull(),
    lastRunId: text("last_run_id"),
    lastStatus: text("last_status"), // 'ok' | 'failed'
    status: text("status").notNull().default("active"), // 'active' | 'paused'
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_schedules_due").on(table.status, table.nextRunAt)]
);

// ---------------------------------------------------------------------------
// Billing — subscriptions + monthly usage counters (Round K, audit P0-B3)
// ---------------------------------------------------------------------------

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull().unique(),
    plan: text("plan").notNull(), // starter | growth(legacy alias) | team | business | enterprise
    status: text("status").notNull(), // trialing | active | past_due | cancelled
    monthlyRunQuota: integer("monthly_run_quota").notNull(), // 0 = unlimited
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    renewsAt: timestamp("renews_at", { withTimezone: true, mode: "string" }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "string" })
  },
  (table) => [index("idx_subs_ws").on(table.workspaceId)]
);

export const usageCounters = pgTable(
  "usage_counters",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    month: text("month").notNull(), // YYYY-MM (UTC)
    runsCreated: integer("runs_created").notNull().default(0),
    runsCompleted: integer("runs_completed").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0)
  },
  (table) => [index("idx_usage_ws_month").on(table.workspaceId, table.month)]
);

// ---------------------------------------------------------------------------
// Product analytics events — north-star funnel instrumentation (Round K, audit P1-07)
// ---------------------------------------------------------------------------

export const productEvents = pgTable(
  "product_events",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id"),
    userId: text("user_id"),
    eventType: text("event_type").notNull(),
    payload: text("payload"), // JSON
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    index("idx_events_type_time").on(table.eventType, table.createdAt),
    index("idx_events_ws").on(table.workspaceId)
  ]
);

// ---------------------------------------------------------------------------
// Universal kernel — local Outbox persistence (AC-1-1)
// ---------------------------------------------------------------------------

/**
 * The Outbox is intentionally independent from product_events analytics.
 * Envelope fields stay normalized enough for operational queries while scope
 * and payload retain the shared contract as JSON. The compound unique index is
 * the database-side business-effect guard for (scope, idempotency key).
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    eventId: text("event_id").primaryKey(),
    idempotencyScope: text("idempotency_scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    schemaVersion: text("schema_version").notNull(),
    eventType: text("event_type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true, mode: "string" }).notNull(),
    scope: text("scope").notNull(),
    actorRef: text("actor_ref").notNull(),
    subjectRef: text("subject_ref").notNull(),
    correlationId: text("correlation_id").notNull(),
    causationId: text("causation_id"),
    traceId: text("trace_id").notNull(),
    dataClass: text("data_class").notNull(),
    payload: text("payload").notNull(),
    status: text("status").notNull().default("PENDING"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    uniqueIndex("idx_outbox_idempotency").on(table.idempotencyScope, table.idempotencyKey),
    index("idx_outbox_status_created").on(table.status, table.createdAt)
  ]
);

/**
 * W2 (migration 0012): the delivery-attempt journal that externalizes the
 * retry dimension of `outbox_events`. The Outbox keeps its frozen 5-state
 * contract (PENDING/PROCESSING/COMPLETED/FAILED/CANCELED, 0005) — one row per
 * transport delivery attempt lives here instead of adding states.
 *
 * Idempotency guards (B1 §2, "同 idempotencyKey 不重复投递"):
 *   * `(idempotency_key, attempt_number)` unique — at most one row per attempt;
 *   * partial unique on `idempotency_key WHERE status = 'succeeded'` — at most
 *     one *successful* delivery per content key, enforced by the database even
 *     if two dispatchers race (the dispatcher also pre-checks, and claims run
 *     under a single-writer lease).
 */
export const outboxDeliveryAttempts = pgTable(
  "outbox_delivery_attempts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    /** `webhook` | `smtp` | `preview` (CHECK in migration 0012). */
    transport: text("transport").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    /** Full sha256 of the canonical request body, for audit (key carries only prefixes). */
    requestHash: text("request_hash").notNull(),
    /** `started` | `succeeded` | `failed` (CHECK in migration 0012). */
    status: text("status").notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true, mode: "string" }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: "string" })
  },
  (table) => [
    uniqueIndex("idx_outbox_delivery_attempts_key_attempt").on(
      table.idempotencyKey,
      table.attemptNumber
    ),
    uniqueIndex("idx_outbox_delivery_attempts_key_succeeded")
      .on(table.idempotencyKey)
      .where(sql`${table.status} = 'succeeded'`),
    index("idx_outbox_delivery_attempts_event").on(table.eventId, table.attemptNumber)
  ]
);

/**
 * W1a (D-014 方案 A): authoritative append-only log of runtime step events.
 * W1b: declared the authoritative **read source** for run state — the live
 * SSE route tails this table (`sequence > cursor`) and projects `run` frames
 * through `rebuildRunFromEvents`; audit/replay/export read the same log.
 *
 * Distinct from `outboxEvents` by contract, not by convention:
 *   * no `status` column — nothing to transition, so nothing to rewrite;
 *   * no `updated_at` — a row's lifetime is insert-only;
 *   * `run_id` + `sequence` carry the run-scoped identity the replay fixture
 *     exports with `SELECT * FROM run_events WHERE run_id=$1 ORDER BY sequence`.
 * The compound unique index makes re-persisting an identical outcome a no-op
 * while a resumed execution appends genuinely new events.
 */
export const runEvents = pgTable(
  "run_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id").notNull(),
    attemptId: text("attempt_id"),
    sequence: integer("sequence").notNull(),
    schemaVersion: text("schema_version").notNull(),
    eventType: text("event_type").notNull(),
    actorRef: text("actor_ref").notNull(),
    subjectRef: text("subject_ref").notNull(),
    correlationId: text("correlation_id").notNull(),
    traceId: text("trace_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true, mode: "string" }).notNull(),
    emittedAt: timestamp("emitted_at", { withTimezone: true, mode: "string" }).notNull(),
    dataClass: text("data_class").notNull(),
    payload: text("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    uniqueIndex("idx_run_events_run_sequence").on(table.runId, table.sequence),
    uniqueIndex("idx_run_events_idempotency").on(table.idempotencyKey),
    index("idx_run_events_attempt_sequence").on(table.attemptId, table.sequence)
  ]
);

// ---------------------------------------------------------------------------
// Universal kernel — Evidence / Receipt / Metric local persistence (AC-1-2)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Universal kernel — immutable WorkflowDefinition snapshots (AC-2-0)
// ---------------------------------------------------------------------------

/**
 * One row is one immutable (workflow identity, version) snapshot. `id` is a
 * physical row key; the business identity is enforced by the unique index so
 * a new version can coexist without allowing an update to an old version.
 */
export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: text("id").primaryKey(),
    workflowDefinitionId: text("workflow_definition_id").notNull(),
    version: text("version").notNull(),
    packId: text("pack_id").notNull(),
    packVersion: text("pack_version").notNull(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectId: text("project_id"),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    inputSchema: text("input_schema").notNull(),
    outputSchema: text("output_schema").notNull(),
    nodes: text("nodes").notNull(),
    edges: text("edges").notNull(),
    retryPolicy: text("retry_policy").notNull(),
    failurePolicy: text("failure_policy").notNull(),
    approvalPoints: text("approval_points").notNull(),
    approvalPolicy: text("approval_policy").notNull(),
    status: text("status").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    uniqueIndex("idx_workflow_def_identity_version").on(
      table.workflowDefinitionId,
      table.version
    ),
    index("idx_workflow_def_scope").on(table.projectId, table.workspaceId, table.organizationId),
    index("idx_workflow_def_pack").on(table.packId, table.packVersion)
  ]
);

// ---------------------------------------------------------------------------
// Universal kernel — local Project Pack / Adapter registry (AC-3-0)
// ---------------------------------------------------------------------------

const registrySnapshotColumns = () => ({
  policySnapshotRef: text("policy_snapshot_ref"),
  policySnapshotVersion: text("policy_snapshot_version"),
  budgetSnapshotRef: text("budget_snapshot_ref"),
  budgetSnapshotVersion: text("budget_snapshot_version"),
  revocationRef: text("revocation_ref"),
  revocationVersion: text("revocation_version"),
  killSwitchRef: text("kill_switch_ref"),
  killSwitchVersion: text("kill_switch_version"),
  approvalRefs: text("approval_refs").notNull().default("[]"),
  rollbackPlan: text("rollback_plan").notNull(),
  independentValidationRef: text("independent_validation_ref")
});

export const projectPackRegistry = pgTable(
  "project_pack_registry",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    packId: text("pack_id").notNull(),
    version: text("version").notNull(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectScopeId: text("project_scope_id").notNull(),
    status: text("status").notNull(),
    manifestSnapshot: text("manifest_snapshot").notNull(),
    ...registrySnapshotColumns(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    uniqueIndex("idx_project_pack_registry_identity_version").on(table.packId, table.version),
    index("idx_project_pack_registry_scope").on(
      table.projectId,
      table.projectScopeId,
      table.workspaceId,
      table.organizationId
    ),
    index("idx_project_pack_registry_status").on(table.status)
  ]
);

export const adapterRegistry = pgTable(
  "adapter_registry",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull(),
    packId: text("pack_id").notNull(),
    packVersion: text("pack_version").notNull(),
    adapterId: text("adapter_id").notNull(),
    version: text("version").notNull(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectScopeId: text("project_scope_id").notNull(),
    status: text("status").notNull(),
    manifestSnapshot: text("manifest_snapshot").notNull(),
    ...registrySnapshotColumns(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [
    uniqueIndex("idx_adapter_registry_identity_version").on(table.adapterId, table.version),
    index("idx_adapter_registry_scope").on(
      table.projectId,
      table.projectScopeId,
      table.workspaceId,
      table.organizationId
    ),
    index("idx_adapter_registry_pack").on(table.packId, table.packVersion),
    index("idx_adapter_registry_status").on(table.status)
  ]
);

// Short aliases for callers that use the generic registry vocabulary.
export const packRegistry = projectPackRegistry;
export const adapterManifests = adapterRegistry;

/**
 * These tables deliberately keep scope, identity, versions, and references
 * queryable while retaining the complete validated contract as raw JSON.
 *
 * Boundary statement (updated at P-2 for first-party pluginization): runtime
 * plugin loading is in scope for first-party/internal plugins only, under
 * host-enforced fail-closed gates (packages/plugin-host; default-disabled).
 * No sandbox is promised — plugins run in-process with host privileges.
 * Third-party code and platform distribution remain outside this slice; RLS
 * runtime enforcement also remains outside. Registry immutability stands:
 * no update/delete; upgrades register a new version and switch references.
 */
export const evidenceRecords = pgTable(
  "evidence_records",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectId: text("project_id"),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    subjectRef: text("subject_ref").notNull(),
    evidenceLevel: text("evidence_level").notNull(),
    sourceType: text("source_type").notNull(),
    sourceRef: text("source_ref").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    collectedAt: timestamp("collected_at", { withTimezone: true, mode: "string" }).notNull(),
    contentHash: text("content_hash"),
    excerptRef: text("excerpt_ref"),
    verifierRef: text("verifier_ref"),
    status: text("status").notNull(),
    supersedes: text("supersedes"),
    retentionPolicy: text("retention_policy").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    index("idx_evidence_project_time").on(table.projectId, table.observedAt),
    index("idx_evidence_source").on(table.sourceRef)
  ]
);

export const receipts = pgTable(
  "receipts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectId: text("project_id"),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    workItemId: text("work_item_id").notNull(),
    runId: text("run_id").notNull(),
    actorRef: text("actor_ref").notNull(),
    capabilityRef: text("capability_ref"),
    workflowVersion: text("workflow_version").notNull(),
    workflowRef: text("workflow_ref"),
    inputSnapshotRef: text("input_snapshot_ref").notNull(),
    manifestRef: text("manifest_ref"),
    manifestVersion: text("manifest_version"),
    policySnapshotVersion: text("policy_snapshot_version"),
    outputArtifactRefs: text("output_artifact_refs").notNull(),
    evidenceRefs: text("evidence_refs").notNull(),
    validationRefs: text("validation_refs").notNull(),
    metricObservationRefs: text("metric_observation_refs").notNull(),
    policySnapshotRef: text("policy_snapshot_ref").notNull(),
    approvalRefs: text("approval_refs").notNull(),
    attemptRef: text("attempt_ref"),
    attemptNumber: integer("attempt_number"),
    budgetSnapshotRef: text("budget_snapshot_ref"),
    budgetSnapshotVersion: text("budget_snapshot_version"),
    revocationRef: text("revocation_ref"),
    killSwitchRef: text("kill_switch_ref"),
    costSnapshot: text("cost_snapshot"),
    resultStatus: text("result_status").notNull(),
    replayRef: text("replay_ref"),
    producedAt: timestamp("produced_at", { withTimezone: true, mode: "string" }).notNull(),
    validationJson: text("validation_json").notNull().default("[]"),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    index("idx_receipts_project_produced").on(table.projectId, table.producedAt),
    index("idx_receipts_run").on(table.runId),
    index("idx_receipts_result").on(table.resultStatus)
  ]
);

export const metricDefinitions = pgTable(
  "metric_definitions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectId: text("project_id"),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    metricKey: text("metric_key").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    unit: text("unit").notNull(),
    aggregation: text("aggregation").notNull(),
    numerator: text("numerator"),
    denominator: text("denominator"),
    timeWindow: text("time_window").notNull(),
    definitionVersion: text("definition_version").notNull(),
    sourceEventTypes: text("source_event_types").notNull(),
    privacyPolicy: text("privacy_policy").notNull(),
    status: text("status").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    uniqueIndex("idx_metric_def_project_key_version").on(
      table.projectId,
      table.metricKey,
      table.definitionVersion
    ),
    index("idx_metric_def_project").on(table.projectId)
  ]
);

export const metricObservations = pgTable(
  "metric_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id"),
    workspaceId: text("workspace_id"),
    projectId: text("project_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
    sourceRefs: text("source_refs").notNull(),
    definitionRef: text("definition_ref").notNull(),
    metricKey: text("metric_key").notNull(),
    aggregation: text("aggregation"),
    subjectRef: text("subject_ref"),
    value: real("value").notNull(),
    unit: text("unit").notNull(),
    numerator: real("numerator"),
    denominator: real("denominator"),
    periodStart: timestamp("period_start", { withTimezone: true, mode: "string" }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true, mode: "string" }).notNull(),
    definitionVersion: text("definition_version").notNull(),
    sourceEventRefs: text("source_event_refs").notNull(),
    evidenceRefs: text("evidence_refs").notNull(),
    cohort: text("cohort"),
    observedAt: timestamp("observed_at", { withTimezone: true, mode: "string" }).notNull(),
    confidence: text("confidence").notNull(),
    status: text("status").notNull(),
    rawJson: text("raw_json").notNull()
  },
  (table) => [
    index("idx_metric_obs_project_period").on(table.projectId, table.periodEnd),
    index("idx_metric_obs_definition").on(table.definitionRef, table.definitionVersion)
  ]
);

// Compatibility aliases keep the table vocabulary discoverable without
// duplicating the physical schema.
export const evidences = evidenceRecords;
export const taskReceipts = receipts;

// ---------------------------------------------------------------------------
// Team runs — server-side multi-agent relay orchestration (J5)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// P1 Crew — persistent teams (Round U, deliverable 60)
// ---------------------------------------------------------------------------

export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    name: text("name").notNull(),
    goal: text("goal").notNull().default(""),
    status: text("status").notNull().default("active"), // active | paused | archived
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_teams_ws").on(table.workspaceId)]
);

export const teamMembers = pgTable(
  "team_members",
  {
    id: text("id").primaryKey(),
    teamId: text("team_id").notNull(),
    workspaceId: text("workspace_id").notNull(), // denormalized for RLS
    agentId: text("agent_id").notNull(),
    position: text("position").notNull(), // content | conversion | review | operator
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_team_members_team").on(table.teamId)]
);

// ---------------------------------------------------------------------------
// R2-D — industry benchmarks (Round Y, deliverable 62)
// ---------------------------------------------------------------------------

export const industryBenchmarks = pgTable(
  "industry_benchmarks",
  {
    id: text("id").primaryKey(),
    industry: text("industry").notNull(),
    templateType: text("template_type").notNull(),
    totalRuns: integer("total_runs").notNull().default(0),
    completedRuns: integer("completed_runs").notNull().default(0),
    successRate: real("success_rate"),
    p50DurationSec: real("p50_duration_sec"),
    p90DurationSec: real("p90_duration_sec"),
    sampleSize: integer("sample_size").notNull().default(0),
    period: text("period").notNull().default("all"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull()
  },
  (table) => [index("idx_benchmarks_industry").on(table.industry, table.templateType)]
);

export const teamRuns = pgTable("team_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  playbookKey: text("playbook_key").notNull(),
  goal: text("goal").notNull(),
  audience: text("audience").notNull().default(""),
  status: text("status").notNull().default("running"), // running | waiting_approval | completed | failed
  currentStep: integer("current_step").notNull().default(0),
  stepsJson: text("steps_json").notNull(), // JSON [{templateType, roleKey, feedFrom}]
  runIdsJson: text("run_ids_json").notNull().default("[]"), // JSON string[], index = step order
  createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).notNull(),
  // P1 Crew (Round V): linking a relay instance to its persistent Team.
  teamId: text("team_id")
});
