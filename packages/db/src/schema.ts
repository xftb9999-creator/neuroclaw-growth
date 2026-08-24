import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  plan: text("plan").notNull(),
  createdAt: text("created_at").notNull()
});

export const runs = sqliteTable("runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  templateType: text("template_type").notNull(),
  status: text("status").notNull(),
  input: text("input").notNull(),
  outputPayload: text("output_payload"),
  failureReason: text("failure_reason"),
  currentStep: text("current_step"),
  approvalStatus: text("approval_status").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  stepResults: text("step_results")
});

export const auditEvents = sqliteTable("audit_events", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id"),
  actorId: text("actor_id"),
  action: text("action").notNull(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id"),
  metadata: text("metadata"),
  createdAt: text("created_at").notNull()
});

export const approvalRequests = sqliteTable("approval_requests", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  actionType: text("action_type").notNull(),
  reason: text("reason").notNull(),
  status: text("status").notNull(),
  requestedAt: text("requested_at").notNull(),
  resolvedAt: text("resolved_at"),
  resolution: text("resolution")
});

export const memoryRecords = sqliteTable("memory_records", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  templateType: text("template_type").notNull(),
  type: text("type").notNull(),
  summary: text("summary").notNull(),
  sourceRunId: text("source_run_id").notNull(),
  isPinned: integer("is_pinned", { mode: "boolean" }).notNull(),
  isSuppressed: integer("is_suppressed", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// Durable job queue — three-table model for claim/process/retry/recovery
// ---------------------------------------------------------------------------

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  runId: text("run_id").notNull(),
  type: text("type").notNull(), // 'execute_run' | 'resume_approved_run'
  status: text("status").notNull(), // 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'retry_scheduled'
  payload: text("payload"), // JSON: { approvedActions?: string[] }
  maxAttempts: integer("max_attempts").notNull().default(3),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  claimedAt: text("claimed_at"),
  completedAt: text("completed_at")
});

export const jobAttempts = sqliteTable("job_attempts", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  attemptNumber: integer("attempt_number").notNull(),
  status: text("status").notNull(), // 'started' | 'completed' | 'failed'
  error: text("error"),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at")
});
