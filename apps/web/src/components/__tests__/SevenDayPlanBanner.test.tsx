// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { SevenDayPlanBanner } from "../SevenDayPlanBanner.js";
import { renderWithProviders as render } from "../../test/utils.js";

function startedAt(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString();
}

describe("SevenDayPlanBanner", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("shows the start CTA before any activity", () => {
    render(<SevenDayPlanBanner runs={[]} />);
    expect(screen.getByTestId("seven-day-plan")).toBeInTheDocument();
    expect(screen.getByText(/启动第一个任务/)).toBeInTheDocument();
  });

  it("derives Day N progress from stored workspace creation time", () => {
    window.localStorage.setItem("neuroclaw.workspaceCreatedAt", startedAt(2));
    const run = {
      id: "run_x", workspaceId: "ws", templateType: "content_acquisition" as const,
      status: "completed" as const, input: {}, currentStep: null,
      approvalStatus: "not_required", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    render(<SevenDayPlanBanner runs={[run]} />);

    expect(screen.getByText(/第 3 天 · 共 7 天/)).toBeInTheDocument();
    expect(screen.getByText(/补齐内容库存至 10 篇/)).toBeInTheDocument();
    expect(screen.queryByText(/启动第一个任务/)).not.toBeInTheDocument();
  });

  it("marks the cycle finished after day 7", () => {
    window.localStorage.setItem("neuroclaw.workspaceCreatedAt", startedAt(9));
    render(<SevenDayPlanBanner runs={[]} />);
    expect(screen.getByText(/7 天周期已完成/)).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "100");
  });
});
