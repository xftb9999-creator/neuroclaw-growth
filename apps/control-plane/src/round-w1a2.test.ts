import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  replayCheckpoints,
  runEvents,
  type Database
} from "@neuroclaw/db";
import { rebuildRunFromEvents, type Run, type RuntimeEvent } from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

/**
 * W1a close-out (second pass) — R-W1a fix, the event-log read route, and the
 * rebuild parity assertion.
 *
 * Independent QA (`.artifacts/qa-wave1/w1a.md` §3) reproduced a hard failure:
 * two byte-identical events inside one stream both resolved to the same
 * `eventId`, so the replay checkpoint's `sourceEventRefs` were not unique and
 * the whole `persistRuntimeEventStream` call aborted with a `ZodError` — the
 * implementer had described it as a silent merge. These tests pin the real
 * behaviour: one content identity is one event, and the call succeeds.
 */

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{
  db: Database;
  service: ControlPlaneService;
  app: ReturnType<typeof createApp>;
}> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db);
  return { db, service, app: createApp(service) };
}

const CONTENT_INPUT = {
  businessSummary: "W1a close-out campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

async function completedRun(service: ControlPlaneService): Promise<Run> {
  const workspace = await service.createWorkspace({ name: "W1a Close-out Lab", plan: "team" }, "dev");
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "content_acquisition",
    input: CONTENT_INPUT
  });
}

async function rowsFor(db: Database, runId: string) {
  const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

describe("W1a close-out: R-W1a duplicate sourceEventRefs", () => {
  it("R-W1a: a byte-identical duplicate in one stream no longer hard-fails", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);
    const before = await rowsFor(db, run.id);
    const events = await service.listRunRuntimeEvents(run.id);

    // Two copies of one never-seen event: the runtime-retry shape QA reproduced.
    const probe: RuntimeEvent = {
      type: "contract_validated",
      runId: run.id,
      details: "R-W1a duplicate probe"
    };
    const stream = [...events, probe, probe];

    // ① no ZodError, no IdempotencyConflictError — the call completes
    const result = await service.persistRuntimeEventStream(run, stream);

    // ② the returned ids are unique (the pre-fix failure was a duplicate here)
    expect(new Set(result.eventIds).size).toBe(result.eventIds.length);
    expect(result.eventIds).toHaveLength(events.length + 1);

    // ③ the duplicate collapsed into exactly one appended row, not two
    const after = await rowsFor(db, run.id);
    expect(after).toHaveLength(before.length + 1);
    expect(after.map((row) => row.sequence)).toEqual(
      Array.from({ length: after.length }, (_, index) => index + 1)
    );

    // ④ the checkpoint's sourceEventRefs satisfy the uniqueness invariant that
    //    used to reject the whole call
    const checkpoints = await db
      .select()
      .from(replayCheckpoints)
      .where(eq(replayCheckpoints.runId, run.id));
    expect(checkpoints.length).toBeGreaterThan(0);
    for (const checkpoint of checkpoints) {
      const refs = JSON.parse(checkpoint.sourceEventRefs) as string[];
      expect(new Set(refs).size).toBe(refs.length);
    }

    // ⑤ the stream is still replayable end to end
    const replay = await service.replayRunFromCheckpoint(run.id);
    expect(replay).toEqual(await service.listRunRuntimeEvents(run.id));
  });
});

describe("W1a close-out: rebuild parity", () => {
  it("parity: rebuildRunFromEvents reproduces the runs row field for field", async () => {
    const { service } = await setup();
    const run = await completedRun(service);
    const persisted = await service.getRun(run.id);
    const history = await service.listRunEventHistory(run.id);
    expect(history.length).toBeGreaterThan(0);

    const rebuilt = rebuildRunFromEvents(history);

    // field-by-field, not a single deep-equal blob
    for (const key of Object.keys(persisted) as (keyof Run)[]) {
      expect(rebuilt[key], `parity field '${String(key)}'`).toEqual(persisted[key]);
    }
    // ...and under JSON semantics, which is what the log and the wire carry.
    // `rowToRun` materialises absent optional columns as `undefined` keys; JSON
    // drops them, so the JSON forms — and their key sets — must be identical.
    const asJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Run;
    expect(asJson(rebuilt)).toEqual(asJson(persisted));
    expect(Object.keys(asJson(rebuilt)).sort()).toEqual(Object.keys(asJson(persisted)).sort());
    expect(rebuilt).toEqual(persisted);
  });

  it("parity is falsifiable: dropping a step outcome breaks the assertion", async () => {
    const { service } = await setup();
    const run = await completedRun(service);
    const persisted = await service.getRun(run.id);
    const history = await service.listRunEventHistory(run.id);

    const withStepResult = history.findIndex(
      (entry) => (entry.payload as { stepResult?: unknown }).stepResult !== undefined
    );
    expect(withStepResult).toBeGreaterThanOrEqual(0);
    const targetStepId = (history[withStepResult]!.payload as { stepId?: string }).stepId;
    expect(targetStepId).toBeTruthy();

    // Strip the step's outcome from every event of that step's span.
    const tampered = history.map((entry) => {
      const payload = entry.payload as Record<string, unknown>;
      if (payload.stepId !== targetStepId) return entry;
      const { stepResult: _dropped, ...rest } = payload;
      return { ...entry, payload: rest };
    });

    expect(rebuildRunFromEvents(tampered)).not.toEqual(persisted);
  });

  it("rebuild rejects a non-contiguous stream instead of guessing", async () => {
    const { service } = await setup();
    const run = await completedRun(service);
    const history = await service.listRunEventHistory(run.id);

    expect(() => rebuildRunFromEvents(history.slice(1))).toThrow(/not contiguous/);
  });
});

describe("W1a close-out: GET /api/runs/:runId/events/history", () => {
  it("returns the ordered append-only log for a run", async () => {
    const { app, service } = await setup();
    const run = await completedRun(service);

    const res = await app.request(`/api/runs/${run.id}/events/history`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      runId: string;
      count: number;
      events: { sequence: number; eventType: string; runId: string }[];
    };
    expect(body.runId).toBe(run.id);
    expect(body.count).toBeGreaterThan(0);
    expect(body.count).toBe(body.events.length);
    expect(body.events.map((entry) => entry.sequence)).toEqual(
      body.events.map((_, index) => index + 1)
    );
    expect(body.events[0]?.eventType).toBe("growth.run.run_accepted");
    expect(body.events.every((entry) => entry.runId === run.id)).toBe(true);
  });

  it("404s for an unknown run", async () => {
    const { app } = await setup();
    const res = await app.request("/api/runs/run_w1a_missing/events/history");
    expect(res.status).toBe(404);
  });
});
