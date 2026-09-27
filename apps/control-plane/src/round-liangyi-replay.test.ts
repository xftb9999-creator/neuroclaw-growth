import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, createInMemoryDb, outboxEvents, runEvents, type Database } from "@neuroclaw/db";
import {
  OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
  buildOutboxDeliveryIntent,
  exportRunEventReplay,
  incidentReplayFixtureSchema,
  outboxDeliveryIntentSchema,
  verifyIncidentReplay,
  type IncidentReplayFixture
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

/**
 * 梁一闭环 local slice — 「事故 → 夹具 → 重放」三件套 (B1 §6, `B1:206-214`).
 *
 * The `replay-gate` CI job itself is **unauthorized** (stop-line: a CI push is
 * outside the grant), so this file is the local half of the loop:
 *
 *  1. committed incident fixtures under `__fixtures__/incidents/` all replay
 *     green through the shared pure functions (no DB, no control plane);
 *  2. the exporter really is the `SELECT * ... ORDER BY sequence` projection —
 *     a real W1 run row is exported, replayed, and checked field-for-field
 *     against the durable `runs` row.
 *
 * Event payloads for delivery (`transport / recipientHash / contentDigest /
 * deliveryOutcome`) belong to W2's outbox. The W1-only incidents expect an
 * empty side-effect set; `incident-webhook-intent.json` is the W2-era fixture
 * whose `growth.outbox.delivery_intent_recorded` event evidences one recorded
 * delivery intent, whose key is replayed through the real W2 builder/enqueue.
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

const FIXTURE_DIR = new URL("./__fixtures__/incidents/", import.meta.url);

function committedFixtures(): Array<{ file: string; fixture: IncidentReplayFixture }> {
  const files = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => ({
    file,
    fixture: incidentReplayFixtureSchema.parse(
      JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), "utf8")) as unknown
    )
  }));
}

async function rowsFor(db: Database, runId: string) {
  const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

describe("梁一: committed incident fixtures replay green", () => {
  it("replays every fixture in __fixtures__/incidents/", () => {
    const fixtures = committedFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    for (const { file, fixture } of fixtures) {
      const report = verifyIncidentReplay(fixture);
      expect(report.mismatches, `${file} must replay green`).toEqual([]);
      expect(report.ok, `${file} must replay green`).toBe(true);
      expect(fixture.source.table, file).toBe("run_events");
      expect(fixture.source.eventCount, file).toBe(fixture.events.length);
    }

    // The slice ships a genuine failure, not only happy-path goldens.
    expect(
      fixtures.some(({ fixture }) => fixture.expected.run.status === "failed"),
      "at least one committed fixture must be a failed run"
    ).toBe(true);

    // W2 era: at least one committed fixture evidences a recorded delivery
    // intent (non-empty side effects), while the W1-only ones stay empty.
    expect(
      fixtures.some(({ fixture }) => fixture.expected.sideEffects.length > 0),
      "at least one committed fixture must evidence a W2 side effect"
    ).toBe(true);
    expect(
      fixtures.some(({ fixture }) => fixture.expected.sideEffects.length === 0),
      "W1-only fixtures must still expect no side effect"
    ).toBe(true);
  });

  it("rejects a tampered copy of a committed fixture", () => {
    const [first] = committedFixtures();
    expect(first).toBeDefined();

    const tampered: IncidentReplayFixture = {
      ...first!.fixture,
      expected: {
        ...first!.fixture.expected,
        run: { ...first!.fixture.expected.run, status: "completed" }
      }
    };
    // completed is a terminal state only reachable if the log says so — for a
    // failed-run fixture the replay must not be able to produce it.
    if (first!.fixture.expected.run.status !== "completed") {
      const report = verifyIncidentReplay(tampered);
      expect(report.ok).toBe(false);
      expect(report.mismatches.join("\n")).toMatch(/run:/);
    }
  });
});

describe("梁一: exporter over a real W1 log", () => {
  it("exports a preflight-denied incident and replays it green", async () => {
    const { db, service } = await setup();
    const workspace = await service.createWorkspace(
      { name: "Liangyi Incident Lab", plan: "team" },
      "dev"
    );
    // `forbidden` is the blocked keyword `evaluateRunPolicy` denies on, so the
    // run fails in preflight — a real, network-free W1 failure.
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "forbidden keyword blocked by preflight policy",
        targetCustomer: "SMB operators",
        preferredChannels: ["email"],
        contentGoal: "hooks"
      }
    });
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("Run denied by preflight policy");

    const rows = await rowsFor(db, run.id);
    expect(rows.map((row) => row.eventType)).toEqual(["growth.run.run_failed"]);

    const fixture = exportRunEventReplay(rows, {
      name: "incident-preflight-deny",
      description: "Preflight policy denied the run before any step executed."
    });

    expect(fixture.source.runId).toBe(run.id);
    expect(fixture.expected.steps).toEqual([]);
    expect(fixture.expected.sideEffects).toEqual([]);
    expect(fixture.expected.run.failureReason).toBe("Run denied by preflight policy");

    const report = verifyIncidentReplay(fixture);
    expect(report).toEqual({ ok: true, mismatches: [] });

    // The log alone must reproduce the durable row, field for field.
    expect(fixture.expected.run).toEqual(await service.getRun(run.id));
  });

  it("exports an approval-rejected incident (multi-event) and replays it green", async () => {
    const { db, service } = await setup();
    const workspace = await service.createWorkspace(
      { name: "Liangyi Rejection Lab", plan: "growth" },
      "dev"
    );
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "Liangyi gated send",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "Concierge conversion path",
        recipientEmail: "ops@example.com"
      }
    });
    expect(run.status).toBe("waiting_approval");

    const rejected = await service.updateApproval(run.id, {
      approved: false,
      reviewerId: "op_liangyi",
      note: "Incident review: send blocked"
    });
    expect(rejected.status).toBe("cancelled");

    const rows = await rowsFor(db, run.id);
    expect(rows.length).toBeGreaterThan(1);

    const fixture = exportRunEventReplay(rows, {
      name: "incident-approval-rejected",
      description: "Approval rejected: the gated notification never executed."
    });

    expect(fixture.expected.steps).toContain("preview-send");
    expect(fixture.expected.run.status).toBe("cancelled");
    expect(fixture.expected.run.approvalStatus).toBe("rejected");
    // No delivery: W1 payloads carry no W2 side-effect fields, and the gated
    // step never ran — the empty set is the honest expectation.
    expect(fixture.expected.sideEffects).toEqual([]);
    expect(verifyIncidentReplay(fixture)).toEqual({ ok: true, mismatches: [] });
    expect(fixture.expected.run).toEqual(await service.getRun(run.id));
  });
});

const W2_FIXTURE_FILE = "incident-webhook-intent.json";
const OUTBOX_SWITCH_ENV = "NEUROCLAW_OUTBOX_DISPATCH_ENABLED";

function w2Fixture(): IncidentReplayFixture {
  const found = committedFixtures().find((entry) => entry.file === W2_FIXTURE_FILE);
  expect(found, `${W2_FIXTURE_FILE} must be committed`).toBeDefined();
  return found!.fixture;
}

function intentRecordEvent(fixture: IncidentReplayFixture) {
  const event = fixture.events.find(
    (candidate) => candidate.eventType === "growth.outbox.delivery_intent_recorded"
  );
  expect(event, "fixture must carry the outbox delivery-intent record event").toBeDefined();
  return event!;
}

function intentPayload(fixture: IncidentReplayFixture): Record<string, unknown> {
  return intentRecordEvent(fixture).payload as Record<string, unknown>;
}

describe("梁一: W2 delivery-intent fixture (sideEffects non-empty)", () => {
  it("replays the committed intent fixture green, evidencing exactly one side effect", () => {
    const fixture = w2Fixture();
    const event = intentRecordEvent(fixture);

    expect(fixture.expected.steps).toEqual(["preview-send"]);
    expect(fixture.expected.sideEffects).toEqual([
      {
        eventId: event.eventId,
        stepId: "preview-send",
        transport: "webhook",
        recipientHash: "c8cd3c64",
        contentDigest: "c61aacb8312fae95",
        deliveryOutcome: "PENDING"
      }
    ]);
    expect(fixture.expected.run.status).toBe("completed");
    expect(verifyIncidentReplay(fixture)).toEqual({ ok: true, mismatches: [] });
  });

  it("replays the recorded intent through the W2 builder: key agrees with the side effect", () => {
    const fixture = w2Fixture();
    const payload = intentPayload(fixture);
    const intent = outboxDeliveryIntentSchema.parse(payload.deliveryIntent);
    const sideEffect = payload.sideEffect as {
      transport: string;
      recipientHash: string;
      contentDigest: string;
    };

    // 意图记录可重放: the builder regenerates the recorded key byte-for-byte.
    expect(
      buildOutboxDeliveryIntent({ transport: intent.transport, body: intent.body }).idempotencyKey
    ).toBe(intent.idempotencyKey);

    // 键一致: the `rcpt` / `body` segments are the same digests the side effect
    // carries, so the replay reader and the delivery key share one source.
    const keyMatch = /^run:[^:]+:action:[^:]+:rcpt:([0-9a-f]{8}):body:([0-9a-f]{16})$/.exec(
      intent.idempotencyKey
    );
    expect(keyMatch).not.toBeNull();
    expect(sideEffect.transport).toBe(intent.transport);
    expect(sideEffect.recipientHash).toBe(keyMatch![1]);
    expect(sideEffect.contentDigest).toBe(keyMatch![2]);
  });

  it("the real W2 transactional enqueue accepts and persists the recorded intent", async () => {
    const fixture = w2Fixture();
    const intent = outboxDeliveryIntentSchema.parse(intentPayload(fixture).deliveryIntent);

    const previous = process.env[OUTBOX_SWITCH_ENV];
    process.env[OUTBOX_SWITCH_ENV] = "1";
    try {
      const { db, service } = await setup();
      // The replayed terminal row already carries the adapter-recorded intent,
      // exactly the shape `collectRunDeliveryIntents` reads at enqueue time.
      const run = fixture.expected.run;
      expect(run.stepResults?.[0]?.payload?.deliveryIntent).toEqual(intent);

      await service.persistRunProjection(run, "insert");

      const rows = await db.select().from(outboxEvents);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.eventType).toBe("growth.outbox.delivery_intent_recorded");
      expect(row.idempotencyScope).toBe(OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE);
      expect(row.idempotencyKey).toBe(intent.idempotencyKey);
      expect(row.subjectRef).toBe(run.id);
      expect(row.status).toBe("PENDING");
      expect(JSON.parse(row.payload)).toEqual({ deliveryIntent: intent });
    } finally {
      if (previous === undefined) delete process.env[OUTBOX_SWITCH_ENV];
      else process.env[OUTBOX_SWITCH_ENV] = previous;
    }
  });
});
