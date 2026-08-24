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

// ---------------------------------------------------------------------------
// Custom agents — data-driven agent definitions (J2)
// ---------------------------------------------------------------------------

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  baseEngine: text("base_engine").notNull(),
  persona: text("persona").notNull(),
  description: text("description"),
  focusAreas: text("focus_areas"), // JSON string[]
  outputStyle: text("output_style").notNull().default("structured"),
  toolNames: text("tool_names"), // JSON string[]
  status: text("status").notNull().default("active"), // 'active' | 'inactive'
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Artifacts library — every completed run deposits a reusable deliverable (J3)
// ---------------------------------------------------------------------------

export const artifacts = sqliteTable("artifacts", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  runId: text("run_id").notNull(),
  agentType: text("agent_type").notNull(),
  kind: text("kind").notNull(), // 'note' | 'copy' | 'report' | 'generic'
  title: text("title").notNull(),
  summary: text("summary"),
  contentJson: text("content_json").notNull(), // full output payload
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Knowledge base — brand facts & playbooks injected into agent prompts (J3)
// ---------------------------------------------------------------------------

export const knowledgeEntries = sqliteTable("knowledge_entries", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  tags: text("tags"), // JSON string[]
  source: text("source").notNull().default("manual"), // 'manual' | 'run' | 'ai'
  runId: text("run_id"),
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Playbooks — editable workflow definitions (J7)
// ---------------------------------------------------------------------------

export const playbooks = sqliteTable("playbooks", {
  key: text("key").primaryKey(),
  name: text("name").notNull(),
  stepsJson: text("steps_json").notNull(), // JSON [{templateType, roleKey, feedFrom}]
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  updatedAt: text("updated_at").notNull()
});

// ---------------------------------------------------------------------------
// Schedules — recurring agent runs (J4)
// ---------------------------------------------------------------------------

export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  templateType: text("template_type").notNull(),
  label: text("label").notNull(),
  inputJson: text("input_json").notNull(), // run input payload
  intervalMinutes: integer("interval_minutes").notNull().default(1440),
  nextRunAt: text("next_run_at").notNull(),
  lastRunId: text("last_run_id"),
  lastStatus: text("last_status"), // 'ok' | 'failed'
  status: text("status").notNull().default("active"), // 'active' | 'paused'
  createdAt: text("created_at").notNull()
});

// ---------------------------------------------------------------------------
// Team runs — server-side multi-agent relay orchestration (J5)
// ---------------------------------------------------------------------------

export const teamRuns = sqliteTable("team_runs", {
  id: text("id").primaryKey(),
  workspaceId: text("workspace_id").notNull(),
  playbookKey: text("playbook_key").notNull(),
  goal: text("goal").notNull(),
  audience: text("audience").notNull().default(""),
  status: text("status").notNull().default("running"), // running | waiting_approval | completed | failed
  currentStep: integer("current_step").notNull().default(0),
  stepsJson: text("steps_json").notNull(), // JSON [{templateType, roleKey, feedFrom}]
  runIdsJson: text("run_ids_json").notNull().default("[]"), // JSON string[], index = step order
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull()
});
