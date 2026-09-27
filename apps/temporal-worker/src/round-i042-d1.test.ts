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
 * Resume semantics over this stream are explicitly deferred to D2.
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

    expect(await persistCheckpoint(db, first)).toEqual(first);
    expect(await persistCheckpoint(db, second)).toEqual(second);

    expect(await loadCheckpoints(db, first.runId)).toEqual([first, second]);
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
    expect(await loadCheckpoints(second, checkpoint.runId)).toEqual([checkpoint]);
  });

  it("rolls back and re-applies migration 0013 cleanly", async () => {
    const db = await setupDb();
    expect(await runMigrations(db)).toEqual([]);

    expect(await rollbackMigration(db, "0013_run_lifecycle_checkpoints")).toBe(true);
    await expect(loadCheckpoints(db, "run_i042_after_rollback")).rejects.toThrow();

    expect(await runMigrations(db)).toEqual(["0013_run_lifecycle_checkpoints"]);
    const checkpoint = {
      runId: "run_i042_after_rollback",
      stage: "runtime" as const,
      createdAt: "2026-09-27T10:00:00.000Z"
    };
    await persistCheckpoint(db, checkpoint);
    expect(await loadCheckpoints(db, checkpoint.runId)).toEqual([checkpoint]);
  });

  it("returns an empty list for a run with no checkpoints", async () => {
    const db = await setupDb();
    expect(await loadCheckpoints(db, "run_i042_missing")).toEqual([]);
  });
});
