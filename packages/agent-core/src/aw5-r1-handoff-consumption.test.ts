import { describe, expect, it } from "vitest";

import {
  buildContentBriefPrompt,
  buildConversionCopyPrompt,
  buildWeeklyReviewPrompt,
  formatHandoffContext
} from "./index.js";

/**
 * AW-5 R1（遗留消费面）：第 2 棒起 run.input 携带契约校验后的 handoffPayload
 * （control-plane launchTeamStep → 任务队列 → runtime-worker 内置分支
 * generateContentBrief/ConversionCopy/WeeklyReview → 本包 builders）。
 * 本文件经真实 builders 验证消费与降级，不重实现格式化逻辑。
 */
const handoffPayload = {
  businessSummary: "上游简报：已验证方向",
  contentAngles: ["角度A", "角度B"],
  metricsWindowDays: 14
};

describe("AW-5 R1 handoffPayload consumption (second relay step onward)", () => {
  it("判据② content brief prompt 含交接字段（真实消费路径）", () => {
    const prompt = buildContentBriefPrompt({ handoffPayload });

    expect(prompt).toContain("Handoff from previous step (contract-validated fields):");
    expect(prompt).toContain("- businessSummary: 上游简报：已验证方向");
    expect(prompt).toContain("- contentAngles: 角度A, 角度B");
    expect(prompt).toContain("- metricsWindowDays: 14");
  });

  it("判据② conversion copy prompt 含交接字段（真实消费路径）", () => {
    const prompt = buildConversionCopyPrompt({ handoffPayload });

    expect(prompt).toContain("- businessSummary: 上游简报：已验证方向");
    expect(prompt).toContain("- contentAngles: 角度A, 角度B");
  });

  it("判据② weekly review prompt 含交接字段（真实消费路径）", () => {
    const prompt = buildWeeklyReviewPrompt({ handoffPayload });

    expect(prompt).toContain("- businessSummary: 上游简报：已验证方向");
    expect(prompt).toContain("- metricsWindowDays: 14");
  });

  it("降级：handoffPayload 缺失时无交接段（既有行为不变）", () => {
    const prompt = buildContentBriefPrompt({ businessSummary: "团队目标" });

    expect(prompt).not.toContain("Handoff from previous step");
    expect(prompt).toContain("Business context: 团队目标");
  });

  it("降级：handoffPayload 为畸形值时不崩且无交接段", () => {
    const malformed: unknown[] = ["oops", 42, true, null, [], {}, undefined];

    for (const value of malformed) {
      const prompt = buildContentBriefPrompt({ handoffPayload: value });
      expect(prompt).not.toContain("Handoff from previous step");
    }
  });

  it("降级：交接值里的 null/undefined 条目被跳过，其余照常", () => {
    const prompt = buildContentBriefPrompt({
      handoffPayload: { keep: "yes", skipA: null, skipB: undefined }
    });

    expect(prompt).toContain("- keep: yes");
    expect(prompt).not.toContain("skipA");
    expect(prompt).not.toContain("skipB");
  });

  it("formatHandoffContext 缺失/畸形入参返回空串", () => {
    expect(formatHandoffContext({})).toBe("");
    expect(formatHandoffContext({ handoffPayload: null })).toBe("");
    expect(formatHandoffContext({ handoffPayload: "oops" })).toBe("");
  });
});
