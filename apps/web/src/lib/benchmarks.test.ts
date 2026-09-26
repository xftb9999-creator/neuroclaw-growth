import { describe, expect, it } from "vitest";

import { summarizeIndustryBenchmarks } from "./benchmarks.js";

const entry = (overrides: Partial<Parameters<typeof summarizeIndustryBenchmarks>[0][number]> = {}) => ({
  industry: "beauty",
  templateType: "content_acquisition",
  totalRuns: 10,
  completedRuns: 8,
  successRate: 0.8,
  p50DurationSec: 100,
  p90DurationSec: 180,
  sampleSize: 10,
  period: "all",
  ...overrides
});

describe("summarizeIndustryBenchmarks", () => {
  it("returns empty metrics for no usable groups", () => {
    expect(summarizeIndustryBenchmarks([])).toEqual({
      groupCount: 0,
      sampleSize: 0,
      weightedSuccessRate: null,
      weightedP50DurationSec: null
    });
    expect(summarizeIndustryBenchmarks([entry({ sampleSize: 0 }), entry({ sampleSize: -1 })]).sampleSize).toBe(0);
  });

  it("does not let missing metrics corrupt the other weighted aggregate", () => {
    expect(
      summarizeIndustryBenchmarks([
        entry({ sampleSize: 5, successRate: null, p50DurationSec: 40 }),
        entry({ sampleSize: 5, successRate: 0.6, p50DurationSec: null })
      ])
    ).toEqual({
      groupCount: 2,
      sampleSize: 10,
      weightedSuccessRate: 0.6,
      weightedP50DurationSec: 40
    });
  });

  it("weights success and median duration by sample size", () => {
    const summary = summarizeIndustryBenchmarks([
      entry({ sampleSize: 5, successRate: 0.4, p50DurationSec: 60 }),
      entry({ sampleSize: 15, successRate: 0.8, p50DurationSec: 120 })
    ]);

    expect(summary.groupCount).toBe(2);
    expect(summary.sampleSize).toBe(20);
    expect(summary.weightedSuccessRate).toBeCloseTo(0.7);
    expect(summary.weightedP50DurationSec).toBe(105);
  });
});
