// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { PipelineStepper, InputSummaryStrip } from "../PipelineStepper.js";
import { makeRun, renderWithProviders } from "../../test/utils.js";

describe("InputSummaryStrip", () => {
  it("renders chips for business summary, audience and channels", () => {
    renderWithProviders(
      <InputSummaryStrip
        input={{
          businessSummary: "母婴店开业推广",
          targetCustomer: "新手妈妈",
          preferredChannels: ["xiaohongshu", "wechat"]
        }}
      />
    );
    expect(screen.getByText(/母婴店开业推广/)).toBeInTheDocument();
    expect(screen.getAllByText(/新手妈妈/).length).toBeGreaterThan(0);
    expect(screen.getByText(/xiaohongshu/)).toBeInTheDocument();
    expect(screen.getByText(/wechat/)).toBeInTheDocument();
  });
});

describe("PipelineStepper", () => {
  it("marks all nodes done for a completed run", () => {
    renderWithProviders(<PipelineStepper run={makeRun({ status: "completed" })} />);
    const items = screen.getAllByRole("listitem");
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.textContent).toContain("✓");
    }
  });

  it("shows a waiting node for pending approval mid-pipeline", () => {
    const run = makeRun({
      templateType: "private_conversion",
      status: "waiting_approval",
      stepResults: [
        { stepId: "generate", actionType: "mcp_generate_conversion_copy", status: "completed", summary: "draft ready" },
        { stepId: "approval", actionType: "notification_send_preview", status: "waiting_approval", summary: "awaiting you" }
      ]
    });
    const { container } = renderWithProviders(<PipelineStepper run={run} />);
    // Waiting icon span carries the warn palette.
    expect(container.querySelectorAll(".text-warn").length).toBeGreaterThan(0);
  });

  it("flags failed nodes when the run failed", () => {
    const run = makeRun({
      status: "failed",
      stepResults: [
        { stepId: "extract", actionType: "browser_extract", status: "failed", summary: "blocked" }
      ]
    });
    const { container } = renderWithProviders(<PipelineStepper run={run} />);
    expect(container.querySelectorAll(".text-danger").length).toBeGreaterThanOrEqual(2);
  });

  it("activates the first pending node while running", () => {
    const { container } = renderWithProviders(<PipelineStepper run={makeRun({ status: "running" })} />);
    expect(container.querySelectorAll(".pulse-dot").length).toBeGreaterThan(0);
  });
});
