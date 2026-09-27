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

/** Durable projection of the worker's in-memory lifecycle checkpoint. */
export interface PersistedLifecycleCheckpoint {
  runId: string;
  stage: LifecycleCheckpointStage;
  createdAt: string;
}

/**
 * Append one lifecycle checkpoint. The call is not idempotent by design: the
 * checkpoint stream is an append-only log where the same (runId, stage) may
 * recur (e.g. retries). Returns an echo of the stored projection.
 */
export async function persistCheckpoint(
  db: Database,
  checkpoint: PersistedLifecycleCheckpoint
): Promise<PersistedLifecycleCheckpoint> {
  await db.insert(runLifecycleCheckpoints).values({
    id: `chk_${randomUUID()}`,
    runId: checkpoint.runId,
    stage: checkpoint.stage,
    createdAt: checkpoint.createdAt
  });

  return {
    runId: checkpoint.runId,
    stage: checkpoint.stage,
    createdAt: checkpoint.createdAt
  };
}

/**
 * Load the persisted checkpoint stream for one run, oldest first. Ordering is
 * (created_at, id): created_at has millisecond resolution, so id breaks ties
 * deterministically. Unknown runs return an empty list.
 */
export async function loadCheckpoints(
  db: Database,
  runId: string
): Promise<PersistedLifecycleCheckpoint[]> {
  const rows = await db
    .select({
      runId: runLifecycleCheckpoints.runId,
      stage: runLifecycleCheckpoints.stage,
      createdAt: runLifecycleCheckpoints.createdAt
    })
    .from(runLifecycleCheckpoints)
    .where(eq(runLifecycleCheckpoints.runId, runId))
    .orderBy(asc(runLifecycleCheckpoints.createdAt), asc(runLifecycleCheckpoints.id));

  return rows.map((row) => ({
    runId: row.runId,
    stage: row.stage as LifecycleCheckpointStage,
    // TIMESTAMPTZ is normalized to an ISO-8601 UTC string; drivers may hand
    // back a Date, so re-serialize defensively.
    createdAt: new Date(row.createdAt as string | Date).toISOString()
  }));
}
