import { describe, expect, it } from "vitest";

import {
  appendRunStepResult,
  applyApprovalDecision,
  assertTemplateType,
  canTransitionRunStatus,
  transitionRun,
  validateTemplateInputContract,
  type Run
} from "./index.js";

function makeRun(): Run {
  return {
    id: "run_1",
    workspaceId: "ws_1",
    templateType: "content_acquisition",
    status: "draft",
    input: {
      businessSummary: "Help SMB founders launch a first campaign",
      targetCustomer: "SMB operators",
      preferredChannels: ["linkedin"],
      contentGoal: "Generate three short campaign angles"
    },
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

describe("shared contracts", () => {
  it("allows only the P0 template types", () => {
    expect(assertTemplateType("content_acquisition")).toBe(
      "content_acquisition"
    );
    expect(() => assertTemplateType("crew_ops")).toThrow(
      /Unsupported template type/
    );
  });

  it("validates template contracts", () => {
    expect(() =>
      validateTemplateInputContract(
        {
          businessSummary: "x",
          preferredChannels: ["email"]
        },
        {
          fields: [
            {
              name: "businessSummary",
              type: "string",
              required: true,
              description: ""
            },
            {
              name: "preferredChannels",
              type: "string[]",
              required: true,
              description: ""
            },
            {
              name: "contentGoal",
              type: "string",
              required: true,
              description: ""
            }
          ]
        }
      )
    ).toThrow(/contentGoal/);
  });

  it("enforces run transitions", () => {
    const draft = makeRun();
    expect(canTransitionRunStatus("draft", "queued")).toBe(true);
    expect(() => transitionRun(draft, "running")).toThrow(/Invalid run/);
  });

  it("applies approval decisions only from waiting_approval", () => {
    const waiting = {
      ...makeRun(),
      status: "waiting_approval" as const,
      approvalStatus: "pending" as const
    };

    const approved = applyApprovalDecision(waiting, {
      approved: true,
      reviewerId: "owner_1"
    });

    expect(approved.status).toBe("running");
    expect(approved.approvalStatus).toBe("approved");
  });

  it("keeps terminal states closed", () => {
    expect(canTransitionRunStatus("completed", "running")).toBe(false);
    expect(canTransitionRunStatus("failed", "queued")).toBe(false);
    expect(canTransitionRunStatus("cancelled", "draft")).toBe(false);
  });

  it("appends step results to the run", () => {
    const run = appendRunStepResult(makeRun(), {
      stepId: "step_1",
      actionType: "browser_extract",
      status: "completed",
      summary: "Extracted content inputs"
    });

    expect(run.stepResults).toHaveLength(1);
    expect(run.currentStep).toBe("step_1");
  });
});
