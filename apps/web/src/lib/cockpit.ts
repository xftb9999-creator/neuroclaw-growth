import type { RunRecord } from "../types.js";

export interface CockpitRunSummary {
  total: number;
  completed: number;
  active: number;
  waiting: number;
  failed: number;
  outputs: number;
}

export function summarizeCockpitRuns(runs: RunRecord[]): CockpitRunSummary {
  return runs.reduce<CockpitRunSummary>(
    (summary, run) => {
      const next = { ...summary, total: summary.total + 1 };
      if (run.status === "completed") next.completed += 1;
      if (run.status === "running" || run.status === "queued" || run.status === "draft") next.active += 1;
      if (run.status === "waiting_approval") next.waiting += 1;
      if (run.status === "failed" || run.status === "cancelled") next.failed += 1;
      if (run.outputSummary || run.outputPayload) next.outputs += 1;
      return next;
    },
    { total: 0, completed: 0, active: 0, waiting: 0, failed: 0, outputs: 0 }
  );
}

export function latestCockpitRuns(runs: RunRecord[], limit = 3): RunRecord[] {
  return [...runs]
    .sort((left, right) => {
      const leftTime = left.updatedAt ?? left.createdAt ?? "";
      const rightTime = right.updatedAt ?? right.createdAt ?? "";
      return rightTime.localeCompare(leftTime);
    })
    .slice(0, limit);
}
