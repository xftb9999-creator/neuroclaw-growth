import { sql } from "drizzle-orm";

import type { Database } from "./index.js";

/**
 * Versioned SQL migrations (Round O / ADR-56 §4 revision).
 *
 * Decision: hand-authored versioned SQL applied by a built-in migrator,
 * NOT drizzle-kit codegen — drizzle-kit was removed in Round I to clear the
 * esbuild advisory chain (GHSA-67mh-4wv8-2f99) and reintroducing it trades
 * a security gate for convenience. Migration SQL lives here as reviewable
 * artifacts; every statement runs individually so both node-postgres and
 * PGlite (extended protocol) stay compatible.
 *
 * Baseline represents a FRESH Postgres install (pre-launch cutover, per
 * ADR-56 §1 big-bang decision). SQLite-era ALTER shims are gone.
 */

export interface Migration {
  id: string;
  statements: string[];
  /** Optional reverse SQL for isolated local migrations that are safe to roll back. */
  rollbackStatements?: string[];
}

// ---------------------------------------------------------------------------
// 0001 · Full schema baseline (timestamptz-native)
// ---------------------------------------------------------------------------

const BASELINE = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS workspace_members (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_type TEXT NOT NULL,
    status TEXT NOT NULL,
    input TEXT NOT NULL,
    output_payload TEXT,
    failure_reason TEXT,
    current_step TEXT,
    approval_status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    step_results TEXT,
    tokens_used INTEGER,
    cost_usd REAL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    actor_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ,
    resolution TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_type TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    is_pinned BOOLEAN NOT NULL,
    is_suppressed BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    base_engine TEXT NOT NULL,
    persona TEXT NOT NULL,
    description TEXT,
    focus_areas TEXT,
    output_style TEXT NOT NULL DEFAULT 'structured',
    tool_names TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT,
    content_json TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_entries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    run_id TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS playbooks (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    steps_json TEXT NOT NULL,
    builtin BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_type TEXT NOT NULL,
    label TEXT NOT NULL,
    input_json TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 1440,
    next_run_at TIMESTAMPTZ NOT NULL,
    last_run_id TEXT,
    last_status TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS team_runs (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    playbook_key TEXT NOT NULL,
    goal TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'running',
    current_step INTEGER NOT NULL DEFAULT 0,
    steps_json TEXT NOT NULL,
    run_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL UNIQUE,
    plan TEXT NOT NULL,
    status TEXT NOT NULL,
    monthly_run_quota INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    renews_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ
  )`,
  `CREATE TABLE IF NOT EXISTS usage_counters (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    month TEXT NOT NULL,
    runs_created INTEGER NOT NULL DEFAULT 0,
    runs_completed INTEGER NOT NULL DEFAULT 0,
    tokens_used INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS product_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    user_id TEXT,
    event_type TEXT NOT NULL,
    payload TEXT,
    created_at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_members_ws_user ON workspace_members(workspace_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_runs_ws_created ON runs(workspace_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_run ON approval_requests(run_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memory_ws ON memory_records(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_jobs_status_next ON jobs(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_ws ON artifacts(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_ws ON knowledge_entries(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(status, next_run_at)`,
  `CREATE INDEX IF NOT EXISTS idx_subs_ws ON subscriptions(workspace_id)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_ws_month ON usage_counters(workspace_id, month)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_ws_month_uniq ON usage_counters(workspace_id, month)`,
  `CREATE INDEX IF NOT EXISTS idx_events_type_time ON product_events(event_type, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_events_ws ON product_events(workspace_id)`
];

// ---------------------------------------------------------------------------
// 0002 · RLS policy baseline (audit P0-C4 deepening / enterprise readiness)
//
// SAFE-BY-DEFAULT: policies are installed while RLS is ENABLE-only. The app
// connects as table OWNER, and owners bypass RLS unless FORCE ROW LEVEL
// SECURITY is set — so behavior is unchanged today. Activation checklist for
// enforcement lives in ADR-56 Appendix B (non-owner app role + FORCE +
// per-request `SET LOCAL app.workspace_id` inside transactions).
// approval_requests/team_runs/jobs/job_attempts/agents/playbooks/audit_events
// are intentionally exempt here (no workspace_id column or platform-global
// scope); revisit when team scoping lands.
// ---------------------------------------------------------------------------

const RLS_BASELINE = [
  `ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY ws_isolation ON workspaces
     USING (id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY members_isolation ON workspace_members
     USING (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE runs ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY runs_isolation ON runs
     USING (workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE memory_records ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY memory_isolation ON memory_records
     USING (workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE artifacts ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY artifacts_isolation ON artifacts
     USING (workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE knowledge_entries ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY knowledge_isolation ON knowledge_entries
     USING (workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE schedules ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY schedules_isolation ON schedules
     USING (workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY subscriptions_isolation ON subscriptions
     USING (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY usage_isolation ON usage_counters
     USING (workspace_id = current_setting('app.workspace_id', true))`,
  `ALTER TABLE product_events ENABLE ROW LEVEL SECURITY`,
  `CREATE POLICY events_isolation ON product_events
     USING (workspace_id IS NULL OR workspace_id = current_setting('app.workspace_id', true))
     WITH CHECK (workspace_id IS NULL OR workspace_id = current_setting('app.workspace_id', true))`
];

// ---------------------------------------------------------------------------
// 0003 · pgvector — knowledge embeddings (R2-A3)
// ---------------------------------------------------------------------------

const VECTOR_BASELINE = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
  `CREATE INDEX IF NOT EXISTS idx_knowledge_embedding_hnsw
     ON knowledge_entries USING hnsw (embedding vector_cosine_ops)`
];

export const MIGRATIONS: Migration[] = [
  { id: "0001_baseline", statements: BASELINE },
  { id: "0002_rls_baseline", statements: RLS_BASELINE },
  { id: "0003_pgvector_knowledge", statements: VECTOR_BASELINE },
  {
    id: "0004_crew_baseline",
    statements: [
      `CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        goal TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS team_members (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        position TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (team_id, agent_id)
      )`,
      `ALTER TABLE memory_records ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'`,
      `ALTER TABLE runs ADD COLUMN team_id TEXT`,
      `ALTER TABLE runs ADD COLUMN relay_id TEXT`,
      `ALTER TABLE team_runs ADD COLUMN team_id TEXT`,
      `ALTER TABLE workspaces ADD COLUMN industry TEXT`,
      `CREATE TABLE IF NOT EXISTS industry_benchmarks (
        id TEXT PRIMARY KEY,
        industry TEXT NOT NULL,
        template_type TEXT NOT NULL,
        total_runs INTEGER NOT NULL DEFAULT 0,
        completed_runs INTEGER NOT NULL DEFAULT 0,
        success_rate REAL,
        p50_duration_sec REAL,
        p90_duration_sec REAL,
        sample_size INTEGER NOT NULL DEFAULT 0,
        period TEXT NOT NULL DEFAULT 'all',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (industry, template_type, period)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_team ON runs(team_id)`,
      `CREATE INDEX IF NOT EXISTS idx_runs_relay ON runs(relay_id)`,
      `CREATE INDEX IF NOT EXISTS idx_benchmarks_industry ON industry_benchmarks(industry, template_type)`,
      `CREATE INDEX IF NOT EXISTS idx_team_runs_team ON team_runs(team_id)`,
      `CREATE INDEX IF NOT EXISTS idx_teams_ws ON teams(workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`,
      `ALTER TABLE teams ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY teams_isolation ON teams
         USING (workspace_id = current_setting('app.workspace_id', true))
         WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`,
      `ALTER TABLE team_members ENABLE ROW LEVEL SECURITY`,
      `CREATE POLICY team_members_isolation ON team_members
         USING (workspace_id = current_setting('app.workspace_id', true))
         WITH CHECK (workspace_id = current_setting('app.workspace_id', true))`
    ]
  },
  {
    id: "0005_outbox_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS outbox_events (
        event_id TEXT PRIMARY KEY,
        idempotency_scope TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        emitted_at TIMESTAMPTZ NOT NULL,
        scope TEXT NOT NULL,
        actor_ref TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        trace_id TEXT NOT NULL,
        data_class TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELED')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_idempotency
         ON outbox_events(idempotency_scope, idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_status_created
         ON outbox_events(status, created_at)`
    ],
    // The table is isolated from existing analytics data, so local rollback is
    // safe and re-running 0005 recreates the same contract via IF NOT EXISTS.
    rollbackStatements: [`DROP TABLE IF EXISTS outbox_events`]
  },
  {
    id: "0006_evidence_receipt_metrics",
    statements: [
      `CREATE TABLE IF NOT EXISTS evidence_records (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        evidence_level TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        collected_at TIMESTAMPTZ NOT NULL,
        content_hash TEXT,
        excerpt_ref TEXT,
        verifier_ref TEXT,
        status TEXT NOT NULL,
        supersedes TEXT,
        retention_policy TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_project_time
         ON evidence_records(project_id, observed_at)`,
      `CREATE INDEX IF NOT EXISTS idx_evidence_source ON evidence_records(source_ref)`,
      `CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        actor_ref TEXT NOT NULL,
        capability_ref TEXT,
        workflow_version TEXT NOT NULL,
        workflow_ref TEXT,
        input_snapshot_ref TEXT NOT NULL,
        manifest_ref TEXT,
        manifest_version TEXT,
        policy_snapshot_version TEXT,
        output_artifact_refs TEXT NOT NULL,
        evidence_refs TEXT NOT NULL,
        validation_refs TEXT NOT NULL,
        metric_observation_refs TEXT NOT NULL,
        policy_snapshot_ref TEXT NOT NULL,
        approval_refs TEXT NOT NULL,
        attempt_ref TEXT,
        attempt_number INTEGER,
        budget_snapshot_ref TEXT,
        budget_snapshot_version TEXT,
        revocation_ref TEXT,
        kill_switch_ref TEXT,
        cost_snapshot TEXT,
        result_status TEXT NOT NULL,
        replay_ref TEXT,
        produced_at TIMESTAMPTZ NOT NULL,
        validation_json TEXT NOT NULL DEFAULT '[]',
        raw_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_receipts_project_produced ON receipts(project_id, produced_at)`,
      `CREATE INDEX IF NOT EXISTS idx_receipts_run ON receipts(run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_receipts_result ON receipts(result_status)`,
      `CREATE TABLE IF NOT EXISTS metric_definitions (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        unit TEXT NOT NULL,
        aggregation TEXT NOT NULL,
        numerator TEXT,
        denominator TEXT,
        time_window TEXT NOT NULL,
        definition_version TEXT NOT NULL,
        source_event_types TEXT NOT NULL,
        privacy_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_metric_def_project_key_version
         ON metric_definitions(project_id, metric_key, definition_version)`,
      `CREATE INDEX IF NOT EXISTS idx_metric_def_project ON metric_definitions(project_id)`,
      `CREATE TABLE IF NOT EXISTS metric_observations (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        definition_ref TEXT NOT NULL,
        metric_key TEXT NOT NULL,
        aggregation TEXT,
        subject_ref TEXT,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        numerator REAL,
        denominator REAL,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        definition_version TEXT NOT NULL,
        source_event_refs TEXT NOT NULL,
        evidence_refs TEXT NOT NULL,
        cohort TEXT,
        observed_at TIMESTAMPTZ NOT NULL,
        confidence TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_metric_obs_project_period
         ON metric_observations(project_id, period_end)`,
      `CREATE INDEX IF NOT EXISTS idx_metric_obs_definition
         ON metric_observations(definition_ref, definition_version)`
    ],
    rollbackStatements: [
      `DROP TABLE IF EXISTS metric_observations`,
      `DROP TABLE IF EXISTS metric_definitions`,
      `DROP TABLE IF EXISTS receipts`,
      `DROP TABLE IF EXISTS evidence_records`
    ]
  },
  {
    id: "0007_workflow_definitions",
    statements: [
      `CREATE TABLE IF NOT EXISTS workflow_definitions (
        id TEXT PRIMARY KEY,
        workflow_definition_id TEXT NOT NULL,
        version TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        input_schema TEXT NOT NULL,
        output_schema TEXT NOT NULL,
        nodes TEXT NOT NULL,
        edges TEXT NOT NULL,
        retry_policy TEXT NOT NULL,
        failure_policy TEXT NOT NULL,
        approval_points TEXT NOT NULL,
        approval_policy TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_def_identity_version
         ON workflow_definitions(workflow_definition_id, version)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_def_scope
         ON workflow_definitions(project_id, workspace_id, organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_workflow_def_pack
         ON workflow_definitions(pack_id, pack_version)`
    ],
    rollbackStatements: [
      `DROP TABLE IF EXISTS workflow_definitions`
    ]
  },
  {
    id: "0008_project_pack_adapter_registry",
    statements: [
      `CREATE TABLE IF NOT EXISTS project_pack_registry (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        version TEXT NOT NULL,
        organization_id TEXT,
        workspace_id TEXT,
        project_scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_snapshot TEXT NOT NULL,
        policy_snapshot_ref TEXT,
        policy_snapshot_version TEXT,
        budget_snapshot_ref TEXT,
        budget_snapshot_version TEXT,
        revocation_ref TEXT,
        revocation_version TEXT,
        kill_switch_ref TEXT,
        kill_switch_version TEXT,
        approval_refs TEXT NOT NULL DEFAULT '[]',
        rollback_plan TEXT NOT NULL,
        independent_validation_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_project_pack_registry_identity_version
         ON project_pack_registry(pack_id, version)`,
      `CREATE INDEX IF NOT EXISTS idx_project_pack_registry_scope
         ON project_pack_registry(project_id, project_scope_id, workspace_id, organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_project_pack_registry_status
         ON project_pack_registry(status)`,
      `CREATE TABLE IF NOT EXISTS adapter_registry (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        version TEXT NOT NULL,
        organization_id TEXT,
        workspace_id TEXT,
        project_scope_id TEXT NOT NULL,
        status TEXT NOT NULL,
        manifest_snapshot TEXT NOT NULL,
        policy_snapshot_ref TEXT,
        policy_snapshot_version TEXT,
        budget_snapshot_ref TEXT,
        budget_snapshot_version TEXT,
        revocation_ref TEXT,
        revocation_version TEXT,
        kill_switch_ref TEXT,
        kill_switch_version TEXT,
        approval_refs TEXT NOT NULL DEFAULT '[]',
        rollback_plan TEXT NOT NULL,
        independent_validation_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_adapter_registry_identity_version
         ON adapter_registry(adapter_id, version)`,
      `CREATE INDEX IF NOT EXISTS idx_adapter_registry_scope
         ON adapter_registry(project_id, project_scope_id, workspace_id, organization_id)`,
      `CREATE INDEX IF NOT EXISTS idx_adapter_registry_pack
         ON adapter_registry(pack_id, pack_version)`,
      `CREATE INDEX IF NOT EXISTS idx_adapter_registry_status
         ON adapter_registry(status)`
    ],
    rollbackStatements: [
      `DROP TABLE IF EXISTS adapter_registry`,
      `DROP TABLE IF EXISTS project_pack_registry`
    ]
  },
  {
    id: "0009_growth_work_items",
    statements: [
      `CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        legacy_run_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        initiative_id TEXT NOT NULL,
        assignee_ref TEXT NOT NULL,
        organization_id TEXT,
        workspace_id TEXT,
        scope_project_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        pack_version TEXT NOT NULL,
        workflow_ref TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        adapter_ref TEXT NOT NULL,
        adapter_version TEXT NOT NULL,
        pack_snapshot_ref TEXT NOT NULL,
        workflow_snapshot_ref TEXT NOT NULL,
        adapter_snapshot_ref TEXT NOT NULL,
        input_snapshot_ref TEXT NOT NULL,
        policy_snapshot_ref TEXT NOT NULL,
        work_item_json TEXT NOT NULL,
        run_json TEXT NOT NULL,
        receipt_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_legacy_run
         ON work_items(legacy_run_id)`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_scope
         ON work_items(project_id, scope_project_id, workspace_id)`,
      `CREATE INDEX IF NOT EXISTS idx_work_items_workflow
         ON work_items(workflow_ref, workflow_version)`
    ],
    rollbackStatements: [`DROP TABLE IF EXISTS work_items`]
  },
  {
    id: "0010_ac6_attempt_replay_audit",
    statements: [
      `CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        run_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        idempotency_key TEXT NOT NULL,
        workflow_version TEXT NOT NULL,
        workflow_ref TEXT,
        status TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        checkpoint_ref TEXT,
        raw_json TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_run_number
         ON attempts(run_id, attempt_number)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_idempotency
         ON attempts(idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_attempts_scope
         ON attempts(project_id, workspace_id, organization_id)`,
      `CREATE TABLE IF NOT EXISTS replay_checkpoints (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        run_id TEXT NOT NULL,
        work_item_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        workflow_version TEXT NOT NULL,
        workflow_ref TEXT,
        state_hash TEXT NOT NULL,
        source_event_refs TEXT NOT NULL,
        status TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_replay_checkpoints_attempt_sequence
         ON replay_checkpoints(attempt_id, sequence)`,
      `CREATE INDEX IF NOT EXISTS idx_replay_checkpoints_scope
         ON replay_checkpoints(project_id, workspace_id, organization_id)`,
      `CREATE TABLE IF NOT EXISTS universal_audit_events (
        id TEXT PRIMARY KEY,
        organization_id TEXT,
        workspace_id TEXT,
        project_id TEXT,
        schema_version TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        source_refs TEXT NOT NULL,
        run_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        receipt_ref TEXT,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor_ref TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        payload TEXT NOT NULL,
        raw_json TEXT NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_universal_audit_run_sequence
         ON universal_audit_events(run_id, sequence)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_universal_audit_idempotency
         ON universal_audit_events(idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_universal_audit_scope
         ON universal_audit_events(project_id, workspace_id, organization_id)`
    ],
    rollbackStatements: [
      `DROP TABLE IF EXISTS universal_audit_events`,
      `DROP TABLE IF EXISTS replay_checkpoints`,
      `DROP TABLE IF EXISTS attempts`
    ]
  },
  {
    // W1a (D-014 方案 A): the runtime worker already emits step-level
    // `RuntimeExecutionResult.events`; this table is their authoritative,
    // append-only home. It is deliberately NOT the transactional Outbox —
    // `outbox_events` carries a mutable `status` column and no `run_id`, so
    // routing the run event stream through it violated the W1b invariant
    // "the event log only ever grows". This table has no status column and no
    // updated_at: a row is written once and never rewritten.
    id: "0011_run_events",
    statements: [
      `CREATE TABLE IF NOT EXISTS run_events (
        event_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        attempt_id TEXT,
        sequence INTEGER NOT NULL,
        schema_version TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_ref TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        correlation_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        emitted_at TIMESTAMPTZ NOT NULL,
        data_class TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_run_sequence
         ON run_events(run_id, sequence)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_run_events_idempotency
         ON run_events(idempotency_key)`,
      `CREATE INDEX IF NOT EXISTS idx_run_events_attempt_sequence
         ON run_events(attempt_id, sequence)`
    ],
    // The table is isolated from existing analytics data, so local rollback is
    // safe and re-running 0011 recreates the same contract via IF NOT EXISTS.
    rollbackStatements: [`DROP TABLE IF EXISTS run_events`]
  },
  {
    // W2 (B1 §2): the retry dimension of the delivery Outbox is externalized
    // here because `outbox_events` (0005) has a frozen 5-state contract whose
    // FAILED state is terminal. One row per transport delivery attempt:
    // started → succeeded | failed. The partial unique index is the database
    // guard for "at most one successful delivery per idempotency key"; the
    // dispatcher additionally checks before calling the transport and claims
    // under a single-writer lease (no SKIP LOCKED dependency).
    id: "0012_outbox_delivery_attempts",
    statements: [
      `CREATE TABLE IF NOT EXISTS outbox_delivery_attempts (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        transport TEXT NOT NULL
          CHECK (transport IN ('webhook', 'smtp', 'preview')),
        idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('started', 'succeeded', 'failed')),
        http_status INTEGER,
        error TEXT,
        started_at TIMESTAMPTZ NOT NULL,
        ended_at TIMESTAMPTZ,
        next_attempt_at TIMESTAMPTZ
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_delivery_attempts_key_attempt
         ON outbox_delivery_attempts(idempotency_key, attempt_number)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_outbox_delivery_attempts_key_succeeded
         ON outbox_delivery_attempts(idempotency_key) WHERE status = 'succeeded'`,
      `CREATE INDEX IF NOT EXISTS idx_outbox_delivery_attempts_event
         ON outbox_delivery_attempts(event_id, attempt_number)`
    ],
    // The table is isolated from existing data, so local rollback is safe and
    // re-running 0012 recreates the same contract via IF NOT EXISTS.
    rollbackStatements: [`DROP TABLE IF EXISTS outbox_delivery_attempts`]
  },
  {
    // I-042 D1: the DurableJobQueue lifecycle checkpoints previously lived
    // only in process memory and were lost on restart. This append-only table
    // is their durable home: one row per (run, lifecycle stage) observation,
    // never rewritten. Deliberately no unique (run_id, stage) pair — the same
    // stage may legitimately recur (retries), so the stream is a log, not a
    // state machine. Reader ordering is (created_at, id).
    id: "0013_run_lifecycle_checkpoints",
    statements: [
      `CREATE TABLE IF NOT EXISTS run_lifecycle_checkpoints (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        stage TEXT NOT NULL
          CHECK (stage IN ('queued', 'runtime', 'waiting_approval', 'completed', 'failed')),
        created_at TIMESTAMPTZ NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_run_lifecycle_checkpoints_run_created
         ON run_lifecycle_checkpoints(run_id, created_at)`
    ],
    // The table is isolated from existing analytics data, so local rollback is
    // safe and re-running 0013 recreates the same contract via IF NOT EXISTS.
    rollbackStatements: [`DROP TABLE IF EXISTS run_lifecycle_checkpoints`]
  },
  {
    // I-042 D2 (GM-approved): resume semantics need a causal write order and a
    // database-side dedup guard.
    //
    //   * `run_lifecycle_checkpoints.seq` — a sequence-assigned, append-only
    //     order column. D1's (created_at, id) read order broke ties with a
    //     random UUID, i.e. deterministically but not causally; seq is the
    //     only authoritative write order for choosing a resume origin. Old
    //     rows are backfilled in their previous read order ((created_at, id))
    //     so history keeps its existing best-known ordering.
    //   * `jobs.idempotency_key` + unique index — the dedup guard for resume
    //     actions. Plain (non-partial) unique index: Postgres allows multiple
    //     NULLs, so every existing enqueue path (which sets no key) is
    //     unaffected. Repeated resume calls return the existing jobId.
    id: "0014_checkpoint_seq_and_job_idempotency",
    statements: [
      `CREATE SEQUENCE IF NOT EXISTS run_lifecycle_checkpoints_seq_seq`,
      `ALTER TABLE run_lifecycle_checkpoints ADD COLUMN IF NOT EXISTS seq BIGINT`,
      `UPDATE run_lifecycle_checkpoints c
         SET seq = ordered.rn
         FROM (
           SELECT id, row_number() OVER (ORDER BY created_at ASC, id ASC) AS rn
           FROM run_lifecycle_checkpoints
           WHERE seq IS NULL
         ) AS ordered
         WHERE c.id = ordered.id`,
      `ALTER TABLE run_lifecycle_checkpoints ALTER COLUMN seq SET NOT NULL`,
      `SELECT setval(
         'run_lifecycle_checkpoints_seq_seq',
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM run_lifecycle_checkpoints),
         false
       )`,
      `ALTER TABLE run_lifecycle_checkpoints
         ALTER COLUMN seq SET DEFAULT nextval('run_lifecycle_checkpoints_seq_seq')`,
      `CREATE INDEX IF NOT EXISTS idx_run_lifecycle_checkpoints_run_seq
         ON run_lifecycle_checkpoints(run_id, seq)`,
      `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency_key
         ON jobs(idempotency_key)`
    ],
    // Local rollback is safe: both additions are new columns with explicit
    // reverse SQL, and re-running 0014 recreates the same contract via
    // IF NOT EXISTS. Executed in reverse array order (see rollbackMigration):
    // drop seq first (its index/default go with the column), then the
    // sequence, then the jobs column (its unique index goes with it).
    rollbackStatements: [
      `ALTER TABLE jobs DROP COLUMN IF EXISTS idempotency_key`,
      `DROP SEQUENCE IF EXISTS run_lifecycle_checkpoints_seq_seq`,
      `ALTER TABLE run_lifecycle_checkpoints DROP COLUMN IF EXISTS seq`
    ]
  },
  {
    // AW-5 片1（GM 裁决②③）: instance-level work role for custom agents.
    // Nullable so every pre-0015 row and every legacy create path (no role)
    // stays valid; values are validated at the control-plane registration
    // boundary via contract `agentRoleKeySchema` (fail-closed).
    id: "0015_agents_role",
    statements: [`ALTER TABLE agents ADD COLUMN IF NOT EXISTS role TEXT`],
    // New nullable column only — dropping it loses nothing the schema did not
    // introduce; re-running up recreates the same contract via IF NOT EXISTS.
    rollbackStatements: [`ALTER TABLE agents DROP COLUMN IF EXISTS role`]
  }
];

/** Apply pending migrations; each applied id is recorded transactionally-ish. */
export async function runMigrations(db: Database): Promise<string[]> {
  await db.execute(
    sql.raw(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`
    )
  );

  const result = (await db.execute(sql.raw(`SELECT id FROM schema_migrations`))) as unknown as {
    rows?: Array<{ id: string }>;
  };
  const applied = new Set((result.rows ?? []).map((row) => row.id));
  const ranNow: string[] = [];

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    for (const statement of migration.statements) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(
      sql`INSERT INTO schema_migrations (id) VALUES (${migration.id})`
    );
    ranNow.push(migration.id);
  }

  return ranNow;
}

/**
 * Roll back one isolated migration in local development. Only the latest
 * applied migration may be rolled back, which avoids silently invalidating a
 * later schema. Migrations without explicit reverse SQL are not reversible.
 */
export async function rollbackMigration(db: Database, migrationId: string): Promise<boolean> {
  const migrationIndex = MIGRATIONS.findIndex((migration) => migration.id === migrationId);
  if (migrationIndex < 0) throw new Error(`Unknown migration: ${migrationId}`);

  const migration = MIGRATIONS[migrationIndex];
  if (!migration.rollbackStatements?.length) {
    throw new Error(`Migration '${migrationId}' does not define rollback SQL`);
  }

  const result = (await db.execute(sql.raw(`SELECT id FROM schema_migrations`))) as unknown as {
    rows?: Array<{ id: string }>;
  };
  const applied = new Set((result.rows ?? []).map((row) => row.id));
  if (!applied.has(migrationId)) return false;

  const laterApplied = MIGRATIONS.slice(migrationIndex + 1).some((candidate) => applied.has(candidate.id));
  const unknownLaterApplied = [...applied].some(
    (appliedId) =>
      !MIGRATIONS.some((candidate) => candidate.id === appliedId) &&
      MIGRATIONS.findIndex((candidate) => candidate.id === migrationId) < MIGRATIONS.length
  );
  if (laterApplied || unknownLaterApplied) {
    throw new Error(`Cannot roll back '${migrationId}' while a later migration is applied`);
  }

  await db.transaction(async (tx) => {
    for (const statement of [...migration.rollbackStatements!].reverse()) {
      await tx.execute(sql.raw(statement));
    }
    await tx.execute(sql`DELETE FROM schema_migrations WHERE id = ${migrationId}`);
  });
  return true;
}
