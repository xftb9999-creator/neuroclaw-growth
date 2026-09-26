import type { BenchmarkEntry } from "./api.js";

export interface IndustryBenchmarkSummary {
  groupCount: number;
  sampleSize: number;
  weightedSuccessRate: number | null;
  weightedP50DurationSec: number | null;
}

function usableSampleSize(entry: BenchmarkEntry): number {
  return Number.isFinite(entry.sampleSize) && entry.sampleSize > 0 ? entry.sampleSize : 0;
}

/**
 * Aggregate already k-anonymous industry groups without inventing a mean that
 * the server contract does not provide. Duration is intentionally weighted P50.
 */
export function summarizeIndustryBenchmarks(entries: BenchmarkEntry[]): IndustryBenchmarkSummary {
  const validEntries = entries.filter((entry) => usableSampleSize(entry) > 0);
  const sampleSize = validEntries.reduce((total, entry) => total + usableSampleSize(entry), 0);
  const successEntries = validEntries.filter(
    (entry) => entry.successRate !== null && Number.isFinite(entry.successRate) && entry.successRate >= 0 && entry.successRate <= 1
  );
  const durationEntries = validEntries.filter(
    (entry) => entry.p50DurationSec !== null && Number.isFinite(entry.p50DurationSec) && entry.p50DurationSec >= 0
  );

  const weighted = (items: BenchmarkEntry[], value: (entry: BenchmarkEntry) => number | null) => {
    const weight = items.reduce((total, entry) => total + usableSampleSize(entry), 0);
    if (weight === 0) return null;
    const total = items.reduce((sum, entry) => sum + (value(entry) ?? 0) * usableSampleSize(entry), 0);
    return total / weight;
  };

  return {
    groupCount: validEntries.length,
    sampleSize,
    weightedSuccessRate: weighted(successEntries, (entry) => entry.successRate),
    weightedP50DurationSec: weighted(durationEntries, (entry) => entry.p50DurationSec)
  };
}
