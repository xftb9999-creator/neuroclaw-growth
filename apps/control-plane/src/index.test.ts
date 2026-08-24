import { describe, expect, it } from "vitest";

import { ControlPlaneService, NotFoundError } from "./index.js";

describe("control plane service", () => {
  it("creates workspaces and runs on the happy path", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({
      name: "Growth Lab",
      plan: "growth"
    });

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "Launch a first founder-led campaign",
        targetCustomer: "SMB operators",
        preferredChannels: ["linkedin", "email"],
        contentGoal: "Generate hooks"
      }
    });

    expect(run.workspaceId).toBe(workspace.id);
    expect(run.templateType).toBe("content_acquisition");
    expect(run.status).toBe("completed");
    expect(run.outputPayload?.contentAngles).toBeDefined();
  });

  it("fails when key run input is missing", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({
      name: "Growth Lab",
      plan: "starter"
    });

    await expect(
      service.createRun({
        workspaceId: workspace.id,
        templateType: "weekly_review",
        input: {
          businessSummary: "Review weekly metrics",
          targetCustomer: "SMB operators",
          preferredChannels: ["notion"]
        }
      })
    ).rejects.toThrow(/metricsWindowDays/);
  });

  it("returns not found for an unknown run", async () => {
    const service = await ControlPlaneService.create();

    await expect(service.getRun("missing")).rejects.toThrow(NotFoundError);
  });

  it("fails history and memory lookups for an unknown workspace", async () => {
    const service = await ControlPlaneService.create();

    await expect(service.listRunsByWorkspace("missing")).rejects.toThrowError(
      expect.objectContaining({
        code: "WORKSPACE_NOT_FOUND"
      })
    );
    await expect(service.listWorkspaceMemory("missing")).rejects.toThrowError(
      expect.objectContaining({
        code: "WORKSPACE_NOT_FOUND"
      })
    );
  });

  it("routes approval-required runs into waiting_approval", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({
      name: "Approval Workspace",
      plan: "growth"
    });

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "Send a high-touch conversion preview",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "Concierge conversion path"
      }
    });

    expect(run.status).toBe("waiting_approval");
    expect(run.approvalStatus).toBe("pending");
    expect(await service.listApprovalRequests(run.id)).toHaveLength(1);

    const approved = await service.updateApproval(run.id, {
      approved: true,
      reviewerId: "owner_1"
    });

    expect(approved.status).toBe("completed");
    expect(approved.approvalStatus).toBe("approved");
    expect(approved.outputPayload?.approvalPreview).toBeDefined();
  });

  it("preserves rejection as a terminal state", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({
      name: "Approval Workspace",
      plan: "growth"
    });

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "Send a high-touch conversion preview",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "Concierge conversion path"
      }
    });

    const rejected = await service.updateApproval(run.id, {
      approved: false,
      reviewerId: "owner_1",
      note: "Needs revisions"
    });

    expect(rejected.status).toBe("cancelled");
    expect(rejected.approvalStatus).toBe("rejected");
  });

  it("sorts history newest-first after multiple runs", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({
      name: "History Workspace",
      plan: "growth"
    });

    const firstRun = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "Launch a first founder-led campaign",
        targetCustomer: "SMB operators",
        preferredChannels: ["linkedin", "email"],
        contentGoal: "Generate hooks"
      }
    });

    const secondRun = await service.createRun({
      workspaceId: workspace.id,
      templateType: "weekly_review",
      input: {
        businessSummary: "Review weekly metrics",
        targetCustomer: "SMB operators",
        preferredChannels: ["email"],
        metricsWindowDays: 7
      }
    });

    expect((await service.listRunsByWorkspace(workspace.id)).map((run) => run.id)).toEqual([
      secondRun.id,
      firstRun.id
    ]);
  });
});
