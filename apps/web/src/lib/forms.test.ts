import { describe, expect, it } from "vitest";

import {
  createEmptyFormValues,
  denormalizeFormInput,
  getTemplateFormFields,
  normalizeFormInput
} from "./forms.js";

describe("template form helpers", () => {
  it("maps template fields correctly", () => {
    expect(getTemplateFormFields("content_acquisition").some((field) => field.name === "contentGoal")).toBe(true);
    expect(getTemplateFormFields("weekly_review").some((field) => field.name === "metricsWindowDays")).toBe(true);
  });

  it("normalizes channel and numeric fields", () => {
    expect(
      normalizeFormInput("weekly_review", {
        businessSummary: "Weekly check",
        targetCustomer: "SMB operators",
        preferredChannels: "email, linkedin",
        metricsWindowDays: "7"
      })
    ).toEqual({
      businessSummary: "Weekly check",
      targetCustomer: "SMB operators",
      preferredChannels: ["email", "linkedin"],
      metricsWindowDays: 7
    });
  });

  it("denormalizes stored input for form reuse", () => {
    expect(
      denormalizeFormInput("content_acquisition", {
        businessSummary: "Launch campaign",
        targetCustomer: "SMB",
        preferredChannels: ["email", "linkedin"],
        contentGoal: "Three hooks"
      })
    ).toEqual({
      businessSummary: "Launch campaign",
      targetCustomer: "SMB",
      preferredChannels: "email, linkedin",
      contentGoal: "Three hooks"
    });
  });

  it("creates empty values for each field in a template", () => {
    expect(createEmptyFormValues("private_conversion")).toEqual({
      businessSummary: "",
      targetCustomer: "",
      preferredChannels: "",
      offerAsset: ""
    });
  });
});
