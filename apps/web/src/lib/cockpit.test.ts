import { describe, expect, it } from "vitest";

import { latestCockpitRuns, summarizeCockpitRuns } from "./cockpit.js";
import type { RunRecord } from "../types.js";

const run = (overrides: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-1",
  workspaceId: "ws-1",
  templateType: "content_acquisition",
  status: "completed",
  input: {},
  currentStep: null,
  approvalStatus: "none",
  ...overrides
});

describe("summarizeCockpitRuns", () => {
  it("returns a zero-safe summary for an empty workspace", () => {
    expect(summarizeCockpitRuns([])).toEqual({
      total: 0,
      completed: 0,
      active: 0,
      waiting: 0,
      failed: 0,
      outputs: 0
    });
  });

  it("separates active, waiting, failed, and output-bearing runs", () => {
    const summary = summarizeCockpitRuns([
      run({ id: "completed", outputSummary: "done" }),
      run({ id: "running", status: "running" }),
      run({ id: "waiting", status: "waiting_approval" }),
      run({ id: "failed", status: "failed" }),
      run({ id: "cancelled", status: "cancelled" })
    ]);

    expect(summary).toEqual({ total: 5, completed: 1, active: 1, waiting: 1, failed: 2, outputs: 1 });
  });
});

describe("latestCockpitRuns", () => {
  it("uses updated time and never mutates the source list", () => {
    const runs = [
      run({ id: "old", updatedAt: "2026-09-01T00:00:00Z" }),
      run({ id: "new", updatedAt: "2026-09-03T00:00:00Z" }),
      run({ id: "mid", updatedAt: "2026-09-02T00:00:00Z" })
    ];

    expect(latestCockpitRuns(runs, 2).map((item) => item.id)).toEqual(["new", "mid"]);
    expect(runs.map((item) => item.id)).toEqual(["old", "new", "mid"]);
  });
});
