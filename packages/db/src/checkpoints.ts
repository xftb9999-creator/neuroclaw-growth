import { randomUUID } from "node:crypto";

import { asc, eq } from "drizzle-orm";

import type { Database } from "./index.js";
import { runLifecycleCheckpoints } from "./schema.js";

/**
 * I-042 D1: durable read/write API for the DurableJobQueue lifecycle
 * checkpoints (apps/temporal-worker). Mirrors migration 0013 — keep the stage
 * union in sync with its CHECK constraint.
 */
export const LIFECYCLE_CHECKPOINT_STAGES = [
  "queued",
  "runtime",
  "waiting_approval",
  "completed",
  "failed"
] as const;

export type LifecycleCheckpointStage = (typeof LIFECYCLE_CHECKPOINT_STAGES)[number];

/** Input / in-memory projection of a lifecycle checkpoint (no DB identity). */
export interface LifecycleCheckpoint {
  runId: string;
  stage: LifecycleCheckpointStage;
  createdAt: string;
}

/**
 * I-042 D2: persisted row. `id` is the stable checkpoint identity used by the
 * resume idempotency key; `seq` is the database-assigned append order
 * (migration 0014) and the authoritative read/resume order.
 */
export interface PersistedLifecycleCheckpoint extends LifecycleCheckpoint {
  id: string;
  seq: number;
}

/**
 * Append one lifecycle checkpoint. The call is not idempotent by design: the
 * checkpoint stream is an append-only log where the same (runId, stage) may
 * recur (e.g. retries). Returns the stored row (DB-assigned id and seq
 * included).
 */
export async function persistCheckpoint(
  db: Database,
  checkpoint: LifecycleCheckpoint
): Promise<PersistedLifecycleCheckpoint> {
  const id = `chk_${randomUUID()}`;
  const rows = await db
    .insert(runLifecycleCheckpoints)
    .values({
      id,
      runId: checkpoint.runId,
      stage: checkpoint.stage,
      createdAt: checkpoint.createdAt
    })
    .returning({
      id: runLifecycleCheckpoints.id,
      seq: runLifecycleCheckpoints.seq
    });

  const stored = rows[0];
  return {
    id: stored?.id ?? id,
    seq: Number(stored?.seq ?? 0),
    runId: checkpoint.runId,
    stage: checkpoint.stage,
    createdAt: checkpoint.createdAt
  };
}

/**
 * Load the persisted checkpoint stream for one run, oldest first.
 *
 * Ordering is `seq` (migration 0014): a database-assigned, append-only total
 * order, i.e. the only causally correct write order. D1's (created_at, id)
 * tie-break is deliberately gone — created_at has millisecond resolution and
 * id is a random UUID, so it was deterministic but not causal. Unknown runs
 * return an empty list.
 */
export async function loadCheckpoints(
  db: Database,
  runId: string
): Promise<PersistedLifecycleCheckpoint[]> {
  const rows = await db
    .select({
      id: runLifecycleCheckpoints.id,
      runId: runLifecycleCheckpoints.runId,
      stage: runLifecycleCheckpoints.stage,
      createdAt: runLifecycleCheckpoints.createdAt,
      seq: runLifecycleCheckpoints.seq
    })
    .from(runLifecycleCheckpoints)
    .where(eq(runLifecycleCheckpoints.runId, runId))
    .orderBy(asc(runLifecycleCheckpoints.seq));

  return rows.map((row) => ({
    id: row.id,
    runId: row.runId,
    stage: row.stage as LifecycleCheckpointStage,
    // TIMESTAMPTZ is normalized to an ISO-8601 UTC string; drivers may hand
    // back a Date, so re-serialize defensively.
    createdAt: new Date(row.createdAt as string | Date).toISOString(),
    seq: Number(row.seq)
  }));
}
