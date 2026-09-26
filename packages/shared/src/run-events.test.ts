import { describe, expect, it } from "vitest";

import {
  rebuildRunFromEvents,
  type RunEventPayload,
  type RunEventRecord
} from "./run-events.js";

/**
 * W1b directed test — the pure projection `rebuildRunFromEvents`.
 *
 * The log→row contract lives in the shared package, so these tests run with no
 * database and no control plane: they pin the event vocabulary semantics that
 * the control plane's parity tests then confirm against a real `runs` row.
 */

const RUN_ID = "run_w1b_shared";
const WORKSPACE_ID = "ws_w1b_shared";
const T0 = "2026-09-24T10:00:00.000Z";
const T1 = "2026-09-24T10:00:10.000Z";

const RUN_BASE = {
  id: RUN_ID,
  workspaceId: WORKSPACE_ID,
  templateType: "content_acquisition",
  input: { businessSummary: "W1b pure projection" },
  createdAt: T0,
  updatedAt: T1,
  startedAt: T0,
  completedAt: T1
};

function record(
  sequence: number,
  type: string,
  extra: Partial<RunEventPayload> = {}
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
    }
  };
}

const STEP_RESULT = {
  stepId: "research",
  actionType: "browser_extract",
  status: "completed",
  summary: "Extracted the campaign brief"
};

describe("W1b: rebuildRunFromEvents is a pure projection", () => {
  it("golden sequence: a full run log rebuilds the exact runs row", () => {
    const history: RunEventRecord[] = [
      record(1, "run_accepted", { runBase: RUN_BASE }),
      record(2, "step_started", { stepId: "research" }),
      record(3, "step_completed", { stepId: "research", stepResult: STEP_RESULT }),
      record(4, "run_completed", {
        outputPayload: { contentAngles: ["angle-a", "angle-b"] }
      })
    ];

    expect(rebuildRunFromEvents(history)).toEqual({
      id: RUN_ID,
      workspaceId: WORKSPACE_ID,
      templateType: "content_acquisition",
      status: "completed",
      input: { businessSummary: "W1b pure projection" },
      outputPayload: { contentAngles: ["angle-a", "angle-b"] },
      currentStep: null,
      approvalStatus: "not_required",
      createdAt: T0,
      updatedAt: T1,
      startedAt: T0,
      completedAt: T1,
      stepResults: [STEP_RESULT]
    });
  });

  it("approval_decided(approved) rebuilds running/approved", () => {
    const history: RunEventRecord[] = [
      record(1, "run_accepted", { runBase: { ...RUN_BASE, completedAt: undefined } }),
      record(2, "approval_requested"),
      record(3, "approval_decided", { approvalDecision: { approved: true } })
    ];

    const rebuilt = rebuildRunFromEvents(history);
    expect(rebuilt.status).toBe("running");
    expect(rebuilt.approvalStatus).toBe("approved");
    expect(rebuilt.completedAt).toBeUndefined();
  });

  it("approval_decided(rejected) rebuilds cancelled/rejected", () => {
    const history: RunEventRecord[] = [
      record(1, "run_accepted", { runBase: { ...RUN_BASE, completedAt: undefined } }),
      record(2, "approval_requested"),
      record(3, "approval_decided", { approvalDecision: { approved: false } })
    ];

    const rebuilt = rebuildRunFromEvents(history);
    expect(rebuilt.status).toBe("cancelled");
    expect(rebuilt.approvalStatus).toBe("rejected");
  });

  it("fails closed when approval_decided carries no decision", () => {
    const history: RunEventRecord[] = [
      record(1, "run_accepted", { runBase: RUN_BASE }),
      record(2, "approval_requested"),
      record(3, "approval_decided")
    ];

    expect(() => rebuildRunFromEvents(history)).toThrow(/does not carry its decision/);
  });

  it("is deterministic: order-insensitive and repeatable", () => {
    const history: RunEventRecord[] = [
      record(1, "run_accepted", { runBase: RUN_BASE }),
      record(2, "step_started", { stepId: "research" }),
      record(3, "step_completed", { stepId: "research", stepResult: STEP_RESULT }),
      record(4, "run_completed", { outputPayload: { contentAngles: ["angle-a"] } })
    ];
    const shuffled = [history[2]!, history[0]!, history[3]!, history[1]!];

    const first = rebuildRunFromEvents(history);
    const second = rebuildRunFromEvents(history);
    const fromShuffled = rebuildRunFromEvents(shuffled);

    expect(second).toEqual(first);
    expect(fromShuffled).toEqual(first);
    expect(JSON.stringify(fromShuffled)).toBe(JSON.stringify(first));
  });

  it("rejects an empty stream and a stream without its identity baseline", () => {
    expect(() => rebuildRunFromEvents([])).toThrow(/empty event stream/);
    expect(() => rebuildRunFromEvents([record(1, "run_accepted")])).toThrow(
      /identity baseline/
    );
  });
});