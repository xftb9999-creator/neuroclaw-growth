import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  attempts,
  closeDatabase,
  createInMemoryDb,
  replayCheckpoints,
  runEvents,
  type Database
} from "@neuroclaw/db";
import type { Run } from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

/**
 * Wave 1 wiring — the runtime worker already returned
 * `RuntimeExecutionResult.events`; these tests pin the path that now receives,
 * persists, and replays them.
 */

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

const CONTENT_INPUT = {
  businessSummary: "Wave 1 wiring campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

async function completedRun(service: ControlPlaneService): Promise<Run> {
  const workspace = await service.createWorkspace({ name: "Wave 1 Lab", plan: "team" }, "dev");
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "content_acquisition",
    input: CONTENT_INPUT
  });
}

function persistedEvents(db: Database, runId: string) {
  return db.select().from(runEvents).where(eq(runEvents.runId, runId));
}

describe("Wave 1 wiring: runtime event stream", () => {
  it("receives the worker's event stream and persists it durably", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);

    const rows = await persistedEvents(db, run.id);

    expect(rows.length).toBeGreaterThan(0);
    const eventTypes = rows.map((row) => row.eventType);
    expect(eventTypes).toContain("growth.run.run_accepted");
    expect(eventTypes).toContain("growth.run.run_completed");

    const events = await service.listRunRuntimeEvents(run.id);
    expect(events).toHaveLength(rows.length);
    expect(events[0]).toMatchObject({ type: "run_accepted", runId: run.id });
    expect(events[events.length - 1]).toMatchObject({ type: "run_completed", runId: run.id });

  });

  it("re-persisting the same outcome is idempotent", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);
    const events = await service.listRunRuntimeEvents(run.id);
    const before = await persistedEvents(db, run.id);

    const rewired = await service.persistRuntimeEventStream(run, events);

    expect(rewired.eventIds).toHaveLength(events.length);
    expect(rewired.checkpointId).toBeDefined();
    const after = await persistedEvents(db, run.id);
    expect(after).toHaveLength(before.length);
    // A repeated persist of the same stream must not invent a second attempt.
    expect(await db.select().from(attempts)).toHaveLength(1);
    expect(await db.select().from(replayCheckpoints)).toHaveLength(1);

  });

  it("replays the persisted stream from the replay checkpoint", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);

    const checkpointRows = await db.select().from(replayCheckpoints);
    expect(checkpointRows).toHaveLength(1);
    expect(checkpointRows[0]).toMatchObject({ runId: run.id, sequence: 1, status: "WRITABLE" });
    expect(await db.select().from(attempts)).toHaveLength(1);

    const persisted = await service.listRunRuntimeEvents(run.id);
    const replayed = await service.replayRunFromCheckpoint(run.id);
    expect(replayed).toEqual(persisted);
    expect(replayed.length).toBeGreaterThan(0);

  });

  it("keeps the approval gate fail-closed for a controlled external action", async () => {
    const { service } = await setup();
    const workspace = await service.createWorkspace({ name: "Wave 1 Gate", plan: "team" }, "dev");
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "Wave 1 offer",
        targetCustomer: "SMB",
        preferredChannels: ["email"],
        offerAsset: "Wave 1 offer asset",
        recipientEmail: "ops@example.com"
      }
    });

    expect(run.status).toBe("waiting_approval");

    const events = await service.listRunRuntimeEvents(run.id);
    const types = events.map((event) => event.type);
    expect(types).toContain("approval_requested");
    expect(types).not.toContain("run_completed");
    // Only the allowed copy step ran; the gated notification never executed.
    expect(types.filter((type) => type === "step_completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "approval_requested")?.stepId).toBe("preview-send");

  });
});

describe("Wave 1 wiring: fail-closed negatives", () => {
  it("rejects a side-effect call for a run that is not durably persisted", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);
    const events = await service.listRunRuntimeEvents(run.id);

    const forged: Run = { ...run, id: "run_forged_wave1" };
    await expect(service.persistRuntimeEventStream(forged, events)).rejects.toThrow(
      /no durable run row/
    );
    expect(await persistedEvents(db, forged.id)).toHaveLength(0);

  });

  it("rejects an outcome whose status disagrees with the durable run", async () => {
    const { service } = await setup();
    const run = await completedRun(service);
    const events = await service.listRunRuntimeEvents(run.id);

    await expect(
      service.persistRuntimeEventStream({ ...run, status: "failed" }, events)
    ).rejects.toThrow(/does not match outcome/);

  });

  it("refuses to replay a stream whose persisted event was tampered with", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);
    const rows = await persistedEvents(db, run.id);
    const target = rows.find((row) => row.eventType === "growth.run.step_completed");
    expect(target).toBeDefined();

    const payload = JSON.parse(target!.payload) as Record<string, unknown>;
    await db
      .update(runEvents)
      .set({ payload: JSON.stringify({ ...payload, details: "tampered after the fact" }) })
      .where(eq(runEvents.eventId, target!.eventId));

    await expect(service.replayRunFromCheckpoint(run.id)).rejects.toThrow(
      /Replay integrity failure/
    );

  });

  it("rejects a replay checkpoint that does not bind to a persisted attempt", async () => {
    const { service } = await setup();

    await expect(
      service.persistReplayCheckpoint({
        id: "checkpoint_orphan_wave1",
        schemaVersion: "1.0",
        scope: { workspaceId: "ws_orphan" },
        createdBy: "wave1-test",
        createdAt: "2026-09-23T00:00:00Z",
        updatedAt: "2026-09-23T00:00:00Z",
        sourceRefs: ["test:orphan"],
        runId: "run_orphan_wave1",
        workItemId: "work_item_run_orphan_wave1",
        attemptId: "attempt_missing_wave1",
        sequence: 1,
        workflowVersion: "1.0.0",
        stateHash: "0".repeat(64),
        sourceEventRefs: ["evt_missing_wave1"],
        status: "WRITABLE",
        metadata: {}
      })
    ).rejects.toThrow(/Attempt not found/);

  });
});
