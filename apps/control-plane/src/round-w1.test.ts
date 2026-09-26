import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, createInMemoryDb, runEvents, type Database } from "@neuroclaw/db";
import { rebuildRunFromEvents, type Run } from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

/**
 * W1a directed test — "step events are not dropped".
 *
 * The runtime worker already produced `RuntimeExecutionResult.events`; the
 * control plane used to discard them. These assertions pin the B1 acceptance
 * criteria for the durable path: the step-level stream survives, its
 * `sequence` is gapless, and the log is append-only and deterministic.
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
  businessSummary: "W1a directed campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

async function completedRun(service: ControlPlaneService): Promise<Run> {
  const workspace = await service.createWorkspace({ name: "W1a Lab", plan: "team" }, "dev");
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "content_acquisition",
    input: CONTENT_INPUT
  });
}

const APPROVAL_INPUT = {
  businessSummary: "W1b approval parity",
  targetCustomer: "Warm inbound leads",
  preferredChannels: ["email"],
  offerAsset: "Concierge conversion path"
};

async function waitingApprovalRun(service: ControlPlaneService): Promise<Run> {
  const workspace = await service.createWorkspace(
    { name: "W1b Approval Lab", plan: "growth" },
    "dev"
  );
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "private_conversion",
    input: APPROVAL_INPUT
  });
}

async function rowsFor(db: Database, runId: string) {
  const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

interface RunFrame {
  id: number;
  run: Run;
}

/** Parse the `event: run` frames out of an SSE body, order-agnostic. */
function parseRunFrames(body: string): RunFrame[] {
  const frames: RunFrame[] = [];
  for (const block of body.split("\n\n")) {
    const lines = block.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    if (event !== "run") continue;
    const id = Number(lines.find((line) => line.startsWith("id: "))?.slice(4));
    const data = lines
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6))
      .join("\n");
    frames.push({ id, run: JSON.parse(data) as Run });
  }
  return frames;
}

describe("W1a: step-level events are persisted without loss", () => {
  it("keeps the run's step events and a gapless 1..N sequence", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);

    const rows = await rowsFor(db, run.id);
    expect(rows.length).toBeGreaterThan(0);

    // ① sequence is contiguous with no holes, starting at 1
    expect(rows.map((row) => row.sequence)).toEqual(
      Array.from({ length: rows.length }, (_, index) => index + 1)
    );
    // every row belongs to this run and carries a distinct idempotency key
    expect(rows.every((row) => row.runId === run.id)).toBe(true);
    expect(new Set(rows.map((row) => row.idempotencyKey)).size).toBe(rows.length);

    // ④ the step-level events are not dropped
    const types = rows.map((row) => row.eventType);
    expect(types).toContain("growth.run.run_accepted");
    expect(types).toContain("growth.run.run_completed");
    expect(
      types.some(
        (type) => type === "growth.run.step_started" || type === "growth.run.step_completed"
      )
    ).toBe(true);

    // read-back projection preserves order and identity
    const events = await service.listRunRuntimeEvents(run.id);
    expect(events.map((event) => event.type)).toEqual(
      rows.map((row) => row.eventType.replace("growth.run.", ""))
    );
  });

  it("re-persisting the same stream is a deterministic append-only no-op", async () => {
    const { db, service } = await setup();
    const run = await completedRun(service);
    const before = await rowsFor(db, run.id);
    const events = await service.listRunRuntimeEvents(run.id);

    // ④ the log only grows: re-persisting adds nothing and rewrites nothing
    const first = await service.persistRuntimeEventStream(run, events);
    expect((await rowsFor(db, run.id)).map((row) => row.eventId)).toEqual(
      before.map((row) => row.eventId)
    );

    const second = await service.persistRuntimeEventStream(run, events);
    expect(second.eventIds).toEqual(first.eventIds);
    expect((await rowsFor(db, run.id)).map((row) => row.eventId)).toEqual(
      before.map((row) => row.eventId)
    );

    // ③ replaying the same events twice yields the same terminal state
    const replayA = await service.replayRunFromCheckpoint(run.id);
    const replayB = await service.replayRunFromCheckpoint(run.id);
    expect(replayA).toEqual(replayB);
    expect(replayA).toEqual(events);
  });
});

/**
 * W1b directed tests — the approval decision is a log event, and the SSE route
 * tails that log (`sequence > cursor`) with `Last-Event-ID` as the resume
 * cursor.
 */
describe("W1b: approval decision parity", () => {
  it("approve: the decision is persisted and rebuild === runs row", async () => {
    const { db, service } = await setup();
    const run = await waitingApprovalRun(service);
    expect(run.status).toBe("waiting_approval");

    const approved = await service.updateApproval(run.id, {
      approved: true,
      reviewerId: "op_w1b"
    });
    expect(approved.status).toBe("completed");

    // the decision itself is an append-only row carrying its verdict
    const rows = await rowsFor(db, run.id);
    const decisionRow = rows.find(
      (row) => row.eventType === "growth.run.approval_decided"
    );
    expect(decisionRow).toBeDefined();
    const payload = JSON.parse(decisionRow!.payload) as { approvalDecision?: unknown };
    expect(payload.approvalDecision).toEqual({ approved: true });

    // the log alone reproduces the post-decision row, field for field
    const persisted = await service.getRun(run.id);
    const rebuilt = rebuildRunFromEvents(await service.listRunEventHistory(run.id));
    expect(rebuilt.approvalStatus).toBe("approved");
    for (const key of Object.keys(persisted) as (keyof Run)[]) {
      expect(rebuilt[key], `parity field '${String(key)}'`).toEqual(persisted[key]);
    }
    expect(rebuilt).toEqual(persisted);
  });

  it("reject: the decision is persisted and rebuild === runs row", async () => {
    const { db, service } = await setup();
    const run = await waitingApprovalRun(service);

    const rejected = await service.updateApproval(run.id, {
      approved: false,
      reviewerId: "op_w1b",
      note: "Needs revisions"
    });
    expect(rejected.status).toBe("cancelled");
    expect(rejected.approvalStatus).toBe("rejected");

    const rows = await rowsFor(db, run.id);
    const decisionRow = rows.find(
      (row) => row.eventType === "growth.run.approval_decided"
    );
    expect(decisionRow).toBeDefined();
    const payload = JSON.parse(decisionRow!.payload) as { approvalDecision?: unknown };
    expect(payload.approvalDecision).toEqual({ approved: false });

    const persisted = await service.getRun(run.id);
    const rebuilt = rebuildRunFromEvents(await service.listRunEventHistory(run.id));
    expect(rebuilt.approvalStatus).toBe("rejected");
    expect(rebuilt).toEqual(persisted);
  });
});

describe("W1b: SSE tail and Last-Event-ID resume", () => {
  it("replays the projected run with the log cursor as the SSE id", async () => {
    const { service } = await setup();
    const app = createApp(service);
    const run = await completedRun(service);
    const history = await service.listRunEventHistory(run.id);
    const maxSequence = history[history.length - 1]!.sequence;

    const res = await app.request(`/api/runs/${run.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();

    const frames = parseRunFrames(body);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(maxSequence);
    expect(frames[0]!.run).toEqual(await service.getRun(run.id));
    expect(body).not.toContain("event: bye");
  });

  it("a Last-Event-ID beyond the log restarts from the full history", async () => {
    const { service } = await setup();
    const app = createApp(service);
    const run = await completedRun(service);
    const history = await service.listRunEventHistory(run.id);
    const maxSequence = history[history.length - 1]!.sequence;

    const res = await app.request(`/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": "999999" }
    });
    expect(res.status).toBe(200);
    const body = await res.text();

    const frames = parseRunFrames(body);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(maxSequence);
    expect(frames[0]!.run.status).toBe("completed");
  });

  it("a Last-Event-ID at the cursor skips the replay and closes on the terminal row", async () => {
    const { service } = await setup();
    const app = createApp(service);
    const run = await completedRun(service);
    const history = await service.listRunEventHistory(run.id);
    const maxSequence = history[history.length - 1]!.sequence;

    const res = await app.request(`/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": String(maxSequence) }
    });
    const body = await res.text();

    const frames = parseRunFrames(body);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.id).toBe(maxSequence);
    expect(frames[0]!.run).toEqual(await service.getRun(run.id));
  });

  it("tails events appended after the cursor and closes on terminal", async () => {
    const { service } = await setup();
    const app = createApp(service);
    const run = await waitingApprovalRun(service);
    const before = await service.listRunEventHistory(run.id);
    const cursor = before[before.length - 1]!.sequence;

    const res = await app.request(`/api/runs/${run.id}/events`, {
      headers: { "Last-Event-ID": String(cursor) }
    });
    expect(res.status).toBe(200);

    // The run is not terminal yet: approve while the stream is tailing.
    const approved = await service.updateApproval(run.id, {
      approved: true,
      reviewerId: "op_w1b"
    });
    expect(approved.status).toBe("completed");

    const body = await res.text();
    const frames = parseRunFrames(body);
    expect(frames.length).toBeGreaterThan(0);
    const last = frames[frames.length - 1]!;
    expect(last.id).toBeGreaterThan(cursor);
    expect(last.run.status).toBe("completed");
    expect(last.run).toEqual(await service.getRun(run.id));
    expect(body).not.toContain("event: bye");
  });
});
