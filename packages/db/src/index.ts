import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Pool, types as pgTypes } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { vector as pgvectorExtension } from "@electric-sql/pglite-pgvector";
import { sql } from "drizzle-orm";

import * as schema from "./schema.js";
import { runMigrations } from "./migrations.js";

export {
  workspaces,
  workspaceMembers,
  runs,
  workItems,
  attempts,
  replayCheckpoints,
  universalAuditEvents,
  auditEventRecords,
  approvalRequests,
  memoryRecords,
  auditEvents,
  jobs,
  jobAttempts,
  agents,
  artifacts,
  knowledgeEntries,
  schedules,
  teamRuns,
  playbooks,
  subscriptions,
  usageCounters,
  productEvents,
  outboxEvents,
  runEvents,
  workflowDefinitions,
  projectPackRegistry,
  packRegistry,
  adapterRegistry,
  adapterManifests,
  teams,
  teamMembers,
  industryBenchmarks
} from "./schema.js";

export {
  evidenceRecords,
  evidences,
  receipts,
  taskReceipts,
  metricDefinitions,
  metricObservations
} from "./schema.js";

export {
  runMigrations,
  rollbackMigration,
  MIGRATIONS,
  type Migration
} from "./migrations.js";
export { schema };

export interface CreateDbOptions {
  url?: string;
  applyMigrations?: boolean;
}

type NodePgDatabase = ReturnType<typeof drizzle>;
type PgliteDatabase = ReturnType<typeof drizzlePglite>;

/**
 * Facade type: the app is written against the node-postgres drizzle shape;
 * PGlite instances are API-compatible for every call site we use and are
 * cast at the creation boundary (ADR-56 Appendix A).
 */
export type Database = NodePgDatabase;

// ---------------------------------------------------------------------------
// Temporal read contract (Round O / ADR-56 Appendix B)
//
// Physical columns are TIMESTAMPTZ; the application keeps its ISO-8601 UTC
// string contract. node-postgres returns Date objects for timestamptz unless
// told otherwise — these global parsers normalize every read to ISO so all
// existing string handling (slice/Date.parse/comparison) stays valid.
// ---------------------------------------------------------------------------

let parsersInstalled = false;
function installPgTypeParsers(): void {
  if (parsersInstalled) return;
  const iso = (value: string): string => new Date(value).toISOString();
  pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMPTZ, iso);
  pgTypes.setTypeParser(pgTypes.builtins.TIMESTAMP, iso);
  // count(*) comes back as int8/string — normalize for arithmetic.
  pgTypes.setTypeParser(pgTypes.builtins.INT8, (value) => Number(value));
  parsersInstalled = true;
}

function resolveUrl(options: CreateDbOptions): string {
  return options.url ?? process.env.DATABASE_URL ?? ":memory:";
}

function createDrizzleInstance(options: CreateDbOptions = {}): Database {
  const url = resolveUrl(options);

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    installPgTypeParsers();
    const pool = new Pool({ connectionString: url });
    return drizzle(pool as never, { schema }) as Database;
  }

  // PGlite (embedded Postgres) — load the pgvector extension so migration
  // 0003 applies identically locally and in CI.
  if (url === ":memory:") {
    const client = new PGlite({ extensions: { vector: pgvectorExtension } });
    return drizzlePglite(client as never, { schema }) as unknown as Database;
  }

  if (url.startsWith("file:")) {
    const dataDir = url.slice("file:".length) || "./data/neuroclaw-pg";
    const client = new PGlite(dataDir, { extensions: { vector: pgvectorExtension } });
    return drizzlePglite(client as never, { schema }) as unknown as Database;
  }

  throw new Error(
    `Unsupported DATABASE_URL '${url}'. Use postgres://… (production), file:./path (embedded local) or :memory: (tests).`
  );
}

export async function createDb(options: CreateDbOptions = {}): Promise<Database> {
  const db = createDrizzleInstance(options);

  if (options.applyMigrations ?? true) {
    await runMigrations(db);
  }

  return db;
}

export async function createInMemoryDb(): Promise<Database> {
  return createDb({ url: ":memory:", applyMigrations: true });
}

/**
 * Close the underlying client of a Drizzle database instance.
 * Handles both node-postgres Pool (.end) and PGlite (.close).
 */
export async function closeDatabase(db: Database): Promise<void> {
  const client = (db as unknown as { $client?: { end?: () => unknown; close?: () => unknown } })
    .$client;
  if (!client) return;
  if (typeof client.close === "function") {
    await client.close();
  } else if (typeof client.end === "function") {
    await client.end();
  }
}
