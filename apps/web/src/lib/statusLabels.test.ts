import { describe, expect, it } from "vitest";

import { formatRunStatus } from "./statusLabels.js";

describe("formatRunStatus", () => {
  it("maps statuses to Chinese labels for zh-CN", () => {
    expect(formatRunStatus("queued", "zh-CN")).toBe("排队中");
    expect(formatRunStatus("waiting_approval", "zh-CN")).toBe("待审批");
    expect(formatRunStatus("completed", "zh-CN")).toBe("已完成");
  });

  it("keeps raw enum for other locales (E2E contract)", () => {
    expect(formatRunStatus("waiting_approval", "en-US")).toBe("waiting_approval");
    expect(formatRunStatus("failed", "en")).toBe("failed");
  });

  it("passes unknown statuses through untouched", () => {
    expect(formatRunStatus("mystery", "zh-CN")).toBe("mystery");
  });
});
