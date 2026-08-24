import { describe, expect, it } from "vitest";

import type { TemplateContractField } from "@neuroclaw/shared";

import { formatTemplateOutput, getTemplateByType, validateTemplateInput } from "./index.js";

describe("template definitions", () => {
  it("exposes three P0 templates with contracts", () => {
    const template = getTemplateByType("content_acquisition");
    expect(template.supportedActions).toHaveLength(2);
    expect(
      template.inputContract.fields.some(
        (field: TemplateContractField) => field.name === "contentGoal"
      )
    ).toBe(true);
  });

  it("rejects missing required template input fields", () => {
    expect(() =>
      validateTemplateInput("private_conversion", {
        businessSummary: "Convert warm leads",
        targetCustomer: "warm leads",
        preferredChannels: ["email"]
      })
    ).toThrow(/offerAsset/);
  });

  it("validates required output fields", () => {
    expect(() =>
      formatTemplateOutput("weekly_review", {
        reviewSummary: "Stable week"
      })
    ).toThrow(/nextActions/);
  });

  it("accepts optional metricsSummary and recipientEmail fields", () => {
    expect(() =>
      validateTemplateInput("weekly_review", {
        businessSummary: "SMB growth sprint",
        targetCustomer: "Founders",
        preferredChannels: ["email"],
        metricsWindowDays: 7,
        metricsSummary: "Leads up 15%"
      })
    ).not.toThrow();

    expect(() =>
      validateTemplateInput("private_conversion", {
        businessSummary: "Convert warm leads",
        targetCustomer: "warm leads",
        preferredChannels: ["email"],
        offerAsset: "VIP audit",
        recipientEmail: "owner@example.com"
      })
    ).not.toThrow();
  });

  it("type-checks optional contract fields when present", () => {
    expect(() =>
      validateTemplateInput("weekly_review", {
        businessSummary: "SMB growth sprint",
        targetCustomer: "Founders",
        preferredChannels: ["email"],
        metricsWindowDays: 7,
        metricsSummary: 123
      })
    ).toThrow(/metricsSummary must be a string/);

    expect(() =>
      validateTemplateInput("private_conversion", {
        businessSummary: "Convert warm leads",
        targetCustomer: "warm leads",
        preferredChannels: ["email"],
        offerAsset: "VIP audit",
        recipientEmail: ["not", "an", "email"]
      })
    ).toThrow(/recipientEmail must be a string/);
  });
});
