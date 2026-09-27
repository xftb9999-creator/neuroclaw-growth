import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createDb,
  createInMemoryDb,
  loadCheckpoints,
  persistCheckpoint,
  rollbackMigration,
  runMigrations,
  type Database
} from "@neuroclaw/db";
import type { Run } from "@neuroclaw/shared";

import { DurableJobQueue } from "./index.js";

/**
 * I-042 D1: lifecycle checkpoints of the durable job queue are persisted to
 * `run_lifecycle_checkpoints` (migration 0013) and survive a store reopen.
 * D2 added `seq` + `jobs.idempotency_key` (migration 0014) and resume
 * semantics on top; this file pins the D1 persistence contract it still owns.
 */

const openDatabases: Database[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    await closeDatabase(openDatabases.pop()!);
  }
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

async function setupDb(): Promise<Database> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return db;
}

function queuedRun(id: string): Run {
  const now = new Date("2026-09-27T00:00:00.000Z").toISOString();
  return {
    id,
    workspaceId: "ws_i042",
    templateType: "growth_ops",
    status: "queued",
    input: {},
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: now,
    updatedAt: now
  };
}

describe("I-042 D1 run lifecycle checkpoint persistence", () => {
  it("round-trips a checkpoint byte-for-byte and appends repeated stages", async () => {
    const db = await setupDb();
    const first = {
      runId: "run_i042_roundtrip",
      stage: "queued" as const,
      createdAt: "2026-09-27T08:00:00.000Z"
    };
    // Same stage twice: the stream is an append-only log, not a state machine.
    const second = {
      runId: "run_i042_roundtrip",
      stage: "queued" as const,
      createdAt: "2026-09-27T08:00:01.000Z"
    };

    const storedFirst = await persistCheckpoint(db, first);
    const storedSecond = await persistCheckpoint(db, second);
    // D2: stored rows carry DB identity (id) + authoritative write order (seq).
    expect(storedFirst).toMatchObject(first);
    expect(storedSecond).toMatchObject(second);
    expect(storedFirst.id).toMatch(/^chk_/);
    expect(storedFirst.seq).toBeLessThan(storedSecond.seq);

    const loaded = await loadCheckpoints(db, first.runId);
    expect(
      loaded.map((cp) => ({ runId: cp.runId, stage: cp.stage, createdAt: cp.createdAt }))
    ).toEqual([first, second]);
  });

  it("is readable from a fresh queue instance over the same database", async () => {
    const db = await setupDb();
    const run = queuedRun("run_i042_reopen");
    await new DurableJobQueue(db).enqueue(run);

    const reopened = new DurableJobQueue(db);
    expect(reopened.listCheckpoints()).toEqual([]); // per-instance memory is cold
    const checkpoints = await reopened.listPersistedCheckpoints(run.id);
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].runId).toBe(run.id);
    expect(checkpoints[0].stage).toBe("queued");
    expect(Number.isNaN(Date.parse(checkpoints[0].createdAt))).toBe(false);
  });

  it("survives a full store reopen (close + reconnect to the same data dir)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "i042-d1-"));
    tempDirs.push(dir);
    const url = `file:${join(dir, "checkpoints-store")}`;
    const checkpoint = {
      runId: "run_i042_store_reopen",
      stage: "waiting_approval" as const,
      createdAt: "2026-09-27T09:30:00.000Z"
    };

    const first = await createDb({ url });
    await persistCheckpoint(first, checkpoint);
    await closeDatabase(first);

    const second = await createDb({ url });
    openDatabases.push(second);
    const loaded = await loadCheckpoints(second, checkpoint.runId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject(checkpoint);
    expect(loaded[0].seq).toBeGreaterThan(0);
  });

  it("rolls back and re-applies migrations 0014 + 0013 in order", async () => {
    const db = await setupDb();
    expect(await runMigrations(db)).toEqual([]);

    // 0013 is no longer the latest applied migration: 0014 must go first.
    await expect(rollbackMigration(db, "0013_run_lifecycle_checkpoints")).rejects.toThrow(
      /later migration/i
    );
    expect(await rollbackMigration(db, "0014_checkpoint_seq_and_job_idempotency")).toBe(true);
    expect(await rollbackMigration(db, "0013_run_lifecycle_checkpoints")).toBe(true);
    await expect(loadCheckpoints(db, "run_i042_after_rollback")).rejects.toThrow();

    expect(await runMigrations(db)).toEqual([
      "0013_run_lifecycle_checkpoints",
      "0014_checkpoint_seq_and_job_idempotency"
    ]);
    const checkpoint = {
      runId: "run_i042_after_rollback",
      stage: "runtime" as const,
      createdAt: "2026-09-27T10:00:00.000Z"
    };
    await persistCheckpoint(db, checkpoint);
    const loaded = await loadCheckpoints(db, checkpoint.runId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject(checkpoint);
  });

  it("returns an empty list for a run with no checkpoints", async () => {
    const db = await setupDb();
    expect(await loadCheckpoints(db, "run_i042_missing")).toEqual([]);
  });
});
