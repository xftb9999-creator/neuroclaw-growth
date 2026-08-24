import { describe, expect, it } from "vitest";

import { buildWeeklyReviewPrompt } from "./index.js";

describe("weekly review prompt", () => {
  it("includes metricsSummary when provided", () => {
    const prompt = buildWeeklyReviewPrompt({
      businessSummary: "SMB growth sprint",
      targetCustomer: "Founders",
      preferredChannels: ["email"],
      metricsWindowDays: 7,
      metricsSummary: "Leads 120 (+15%), CAC down 8%"
    });

    expect(prompt).toContain("Metrics summary: Leads 120 (+15%), CAC down 8%");
  });

  it("formats structured metrics entries with deltas", () => {
    const prompt = buildWeeklyReviewPrompt({
      businessSummary: "SMB growth sprint",
      targetCustomer: "Founders",
      preferredChannels: ["email"],
      metricsWindowDays: 7,
      metrics: [
        { name: "leads", value: 120, delta: "+15%" },
        { name: "cac", value: 42 }
      ]
    });

    expect(prompt).toContain("Structured metrics:");
    expect(prompt).toContain("- leads: 120 (delta +15%)");
    expect(prompt).toContain("- cac: 42");
  });

  it("omits metric sections when absent", () => {
    const prompt = buildWeeklyReviewPrompt({
      businessSummary: "SMB growth sprint",
      targetCustomer: "Founders",
      preferredChannels: ["email"],
      metricsWindowDays: 7
    });

    expect(prompt).not.toContain("Metrics summary:");
    expect(prompt).not.toContain("Structured metrics:");
  });
});
