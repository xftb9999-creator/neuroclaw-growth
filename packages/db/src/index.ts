import { drizzle } from "drizzle-orm/libsql";
import { createClient, type Client } from "@libsql/client";
import { sql } from "drizzle-orm";

import * as schema from "./schema.js";

export {
  workspaces,
  runs,
  approvalRequests,
  memoryRecords,
  auditEvents,
  jobs,
  jobAttempts,
  agents,
  artifacts,
  knowledgeEntries,
  schedules,
  teamRuns
} from "./schema.js";

export interface CreateDbOptions {
  url?: string;
  authToken?: string;
  applyMigrations?: boolean;
}

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan TEXT NOT NULL,
    created_at TEXT NOT NULL
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    step_results TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    id TEXT PRIMARY KEY,
    workspace_id TEXT,
    actor_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS approval_requests (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    resolved_at TEXT,
    resolution TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS memory_records (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_type TEXT NOT NULL,
    type TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    is_pinned INTEGER NOT NULL,
    is_suppressed INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    claimed_at TEXT,
    completed_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS job_attempts (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT
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
    created_at TEXT NOT NULL
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
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS knowledge_entries (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    tags TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    template_type TEXT NOT NULL,
    label TEXT NOT NULL,
    input_json TEXT NOT NULL,
    interval_minutes INTEGER NOT NULL DEFAULT 1440,
    next_run_at TEXT NOT NULL,
    last_run_id TEXT,
    last_status TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`
];

function createDrizzleInstance(options: CreateDbOptions = {}) {
  const url = options.url ?? process.env.DATABASE_URL ?? ":memory:";
  const client: Client = createClient({
    url,
    authToken: options.authToken
  });
  return drizzle(client, { schema });
}

export type Database = ReturnType<typeof createDrizzleInstance>;

export async function createDb(options: CreateDbOptions = {}): Promise<Database> {
  const db = createDrizzleInstance(options);

  if (options.applyMigrations ?? true) {
    for (const statement of DDL_STATEMENTS) {
      await db.run(sql.raw(statement));
    }
  }

  return db;
}

export async function createInMemoryDb(): Promise<Database> {
  return createDb({ url: ":memory:", applyMigrations: true });
}

/**
 * Close the underlying libSQL client of a Drizzle database instance.
 * Safe to call on already-closed or in-memory databases.
 */
export async function closeDatabase(db: Database): Promise<void> {
  const client = (db as unknown as { $client?: { close?: () => void } }).$client;
  if (client && typeof client.close === "function") {
    client.close();
  }
}
