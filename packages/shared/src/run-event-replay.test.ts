import { describe, expect, it } from "vitest";

import {
  deriveRunSideEffects,
  deriveRunSteps,
  exportRunEventReplay,
  incidentReplayFixtureSchema,
  INCIDENT_REPLAY_FIXTURE_VERSION,
  replayIncidentFixture,
  serializeIncidentReplayFixture,
  verifyIncidentReplay
} from "./run-event-replay.js";
import type { RunEventPayload, RunEventRecord } from "./run-events.js";

/**
 * 梁一闭环 local slice — the fixture format, the `run_events` exporter, and the
 * replay assertion, all as pure functions (B1 §6, `B1:206-214`).
 *
 * These tests never touch a database or the control plane: `replay-gate` is
 * still unauthorized (stop-line), so what is pinned here is the body it will
 * call — export from rows, freeze expectations, replay, compare.
 */

const RUN_ID = "run_liangyi_replay";
const WORKSPACE_ID = "ws_liangyi_replay";
const T0 = "2026-09-27T10:00:00.000Z";
const T1 = "2026-09-27T10:00:12.000Z";

const RUN_BASE = {
  id: RUN_ID,
  workspaceId: WORKSPACE_ID,
  templateType: "content_acquisition",
  input: { businessSummary: "Liangyi incident", targetCustomer: "SMB" },
  createdAt: T0,
  updatedAt: T1,
  startedAt: T0,
  completedAt: T1
};

/**
 * The W2 outbox carrier this slice pins before W2 lands: the four delivery
 * fields nested under `sideEffect`. `runEventPayloadSchema` (W1) does not model
 * the keys yet, so only this test helper widens its input — no public change.
 */
interface SideEffectCarrier {
  sideEffect?: {
    stepId?: string;
    transport: string;
    recipientHash: string;
    contentDigest: string;
    deliveryOutcome: string;
  };
}

/** A `run_events` row as `SELECT * ORDER BY sequence` returns it. */
function row(
  sequence: number,
  type: string,
  extra: Partial<RunEventPayload> & SideEffectCarrier = {},
  overrides: Partial<RunEventRecord> = {}
): RunEventRecord {
  return {
    eventId: `evt_${String(sequence).padStart(3, "0")}`,
    runId: RUN_ID,
    sequence,
    eventType: `growth.run.${type}`,
    occurredAt: T0,
    emittedAt: T0,
    payload: {
      runId: RUN_ID,
      sequence,
      type,
      details: `${type}@${sequence}`,
      ...extra
    },
    ...overrides
  };
}

const STEP_RESULT = {
  stepId: "research",
  actionType: "browser_extract",
  status: "completed",
  summary: "Extracted the campaign brief"
};

function goldenLog(): RunEventRecord[] {
  return [
    row(1, "run_accepted", { runBase: RUN_BASE }),
    row(2, "step_started", { stepId: "research" }),
    row(3, "step_completed", { stepId: "research", stepResult: STEP_RESULT }),
    row(4, "run_completed", { outputPayload: { contentAngles: ["angle-a"] } })
  ];
}

describe("incident fixture format + exporter", () => {
  it("exports a `run_events` read into a schema-valid fixture", () => {
    const fixture = exportRunEventReplay(goldenLog(), {
      name: "incident-golden-sequence",
      description: "A completed run frozen as a replay golden."
    });

    expect(fixture.fixtureVersion).toBe(INCIDENT_REPLAY_FIXTURE_VERSION);
    expect(fixture.name).toBe("incident-golden-sequence");
    expect(fixture.source).toEqual({ runId: RUN_ID, table: "run_events", eventCount: 4 });

    // 夹具格式: 输入 + 期望 step 序列 + 期望副作用集合 + 期望终态 (B1:208)
    expect(fixture.expected.input).toEqual(RUN_BASE.input);
    expect(fixture.expected.steps).toEqual(["research"]);
    expect(fixture.expected.sideEffects).toEqual([]);
    expect(fixture.expected.run.status).toBe("completed");
    expect(fixture.expected.run.stepResults).toEqual([STEP_RESULT]);

    expect(incidentReplayFixtureSchema.parse(fixture)).toEqual(fixture);
  });

  it("is order-insensitive and byte-stable: the log's read order decides", () => {
    const rows = goldenLog();
    const shuffled = [rows[2]!, rows[0]!, rows[3]!, rows[1]!];

    const fixture = exportRunEventReplay(rows);
    const fromShuffled = exportRunEventReplay(shuffled);

    expect(fromShuffled).toEqual(fixture);
    expect(serializeIncidentReplayFixture(fromShuffled)).toBe(
      serializeIncidentReplayFixture(fixture)
    );
    expect(
      JSON.parse(serializeIncidentReplayFixture(fixture))
    ).toEqual(fixture);
  });

  it("fails closed on a read that is not a single gapless append-only log", () => {
    const rows = goldenLog();

    expect(() => exportRunEventReplay([])).toThrow(/empty run_events read/);
    expect(() =>
      exportRunEventReplay([...rows, row(5, "run_completed", {}, { runId: "run_other" })])
    ).toThrow(/exactly one run/);
    expect(() => exportRunEventReplay([...rows, row(5, "run_completed", {}, { eventId: "evt_001" })]))
      .toThrow(/duplicate event ids/);
    expect(() => exportRunEventReplay([rows[0]!, rows[2]!, rows[3]!])).toThrow(
      /not contiguous/
    );
  });

  it("rejects a row whose payload sequence disagrees with the row", () => {
    const tampered = goldenLog()[1]!;
    const payload = { ...(tampered.payload as Record<string, unknown>), sequence: 9 };

    expect(() =>
      exportRunEventReplay([goldenLog()[0]!, { ...tampered, payload }, ...goldenLog().slice(2)])
    ).toThrow(/disagrees with its payload/);
  });

  it("rejects a payload the shared contract cannot read", () => {
    const broken = { ...goldenLog()[0]!, payload: { runId: RUN_ID } };

    expect(() => exportRunEventReplay([broken])).toThrow(/sequence|details|payload/i);
  });
});

describe("replay + verify", () => {
  it("replays the exported fixture back to the same terminal run", () => {
    const fixture = exportRunEventReplay(goldenLog());
    const outcome = replayIncidentFixture(fixture);

    expect(outcome.eventCount).toBe(4);
    expect(outcome.steps).toEqual(["research"]);
    expect(outcome.sideEffects).toEqual([]);
    expect(outcome.run).toEqual(fixture.expected.run);
    expect(verifyIncidentReplay(fixture)).toEqual({ ok: true, mismatches: [] });
  });

  it("reports a drifted expectation instead of passing it", () => {
    const fixture = exportRunEventReplay(goldenLog());

    const wrongSteps = { ...fixture, expected: { ...fixture.expected, steps: ["research", "copy"] } };
    const wrongRun = {
      ...fixture,
      expected: { ...fixture.expected, run: { ...fixture.expected.run, status: "failed" as const } }
    };

    const stepReport = verifyIncidentReplay(wrongSteps);
    expect(stepReport.ok).toBe(false);
    expect(stepReport.mismatches.join("\n")).toMatch(/steps:/);

    const runReport = verifyIncidentReplay(wrongRun);
    expect(runReport.ok).toBe(false);
    expect(runReport.mismatches.join("\n")).toMatch(/run:/);
  });

  it("rejects an expectation of side effects the log does not evidence", () => {
    const fixture = exportRunEventReplay(goldenLog());
    const claimed = {
      ...fixture,
      expected: {
        ...fixture.expected,
        sideEffects: [
          {
            eventId: "evt_003",
            transport: "webhook",
            recipientHash: "sha256:abc",
            contentDigest: "sha256:def",
            deliveryOutcome: "DELIVERED"
          }
        ]
      }
    };

    const report = verifyIncidentReplay(claimed);
    expect(report.ok).toBe(false);
    expect(report.mismatches.join("\n")).toMatch(/sideEffects:/);
  });

  it("fails closed on a fixture that is not schema-valid", () => {
    const fixture = exportRunEventReplay(goldenLog());
    const broken = { ...fixture, fixtureVersion: "0.9", source: { ...fixture.source, table: "runs" } };

    const report = verifyIncidentReplay(broken as typeof fixture);
    expect(report.ok).toBe(false);
    expect(report.mismatches.length).toBeGreaterThan(0);
  });

  it("rejects a fixture whose source disagrees with its events", () => {
    const fixture = exportRunEventReplay(goldenLog());
    const drift = { ...fixture, source: { ...fixture.source, eventCount: 99 } };

    expect(() => replayIncidentFixture(drift)).toThrow(/claims 99 events/);
  });
});

describe("W2 side-effect carrier (contract pinned before W2 lands)", () => {
  it("reads the four delivery fields when an event carries them", () => {
    const delivered = row(4, "step_completed", {
      stepId: "notify",
      sideEffect: {
        stepId: "notify",
        transport: "webhook",
        recipientHash: "sha256:recipient",
        contentDigest: "sha256:content",
        deliveryOutcome: "DELIVERED"
      }
    });

    expect(deriveRunSideEffects([delivered])).toEqual([
      {
        eventId: "evt_004",
        stepId: "notify",
        transport: "webhook",
        recipientHash: "sha256:recipient",
        contentDigest: "sha256:content",
        deliveryOutcome: "DELIVERED"
      }
    ]);
  });

  it("derives [] from W1-only payloads: no delivery was attempted", () => {
    expect(deriveRunSideEffects(goldenLog())).toEqual([]);
    expect(deriveRunSteps(goldenLog())).toEqual(["research"]);
  });
});
