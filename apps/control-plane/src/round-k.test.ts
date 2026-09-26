import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createInMemoryDb } from "@neuroclaw/db";
import { ControlPlaneService, QuotaExceededError } from "./index.js";
import { createApp } from "./app.js";

const originalEnv = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalEnv === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalEnv;
});

const RUN_INPUT = {
  businessSummary: "Round K commerce campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "Generate hooks"
};

describe("Round K: billing & quota enforcement (audit P0-B3)", () => {
  it("auto-provisions a trial subscription and reports usage in the summary", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({ name: "Billing Lab", plan: "starter" });

    const summary = await service.getBillingSummary(workspace.id);
    expect(summary.status).toBe("trialing");
    expect(summary.monthlyRunQuota).toBe(30);
    expect(summary.usage.quotaRemaining).toBe(30);

    await service.shutdown();
  });

  it("blocks run creation once the monthly quota is exhausted (402 path)", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({ name: "Quota Lab", plan: "starter" });
    await service.ensureSubscription(workspace.id);

    // Shrink the quota to make the test fast and deterministic.
    await service.db
      .update((await import("@neuroclaw/db")).subscriptions)
      .set({ monthlyRunQuota: 1 })
      .where(eq((await import("@neuroclaw/db")).subscriptions.workspaceId, workspace.id));

    await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });

    await expect(
      service.createRun({
        workspaceId: workspace.id,
        templateType: "content_acquisition",
        input: RUN_INPUT
      })
    ).rejects.toThrowError(QuotaExceededError);

    const summary = await service.getBillingSummary(workspace.id);
    expect(summary.usage.runsCreated).toBe(1);
    expect(summary.usage.quotaRemaining).toBe(0);

    await service.shutdown();
  });

  it("changePlan upgrades the subscription and raises the quota", async () => {
    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({ name: "Upgrade Lab", plan: "starter" });

    await service.changePlan(workspace.id, "business");

    const summary = await service.getBillingSummary(workspace.id);
    expect(summary.plan).toBe("business");
    expect(summary.status).toBe("active");
    expect(summary.monthlyRunQuota).toBe(500);
    expect(summary.usage.quotaRemaining).toBe(500);

    await service.shutdown();
  });

  it("exposes billing endpoints over HTTP with ACL", async () => {
    process.env.NEUROCLAW_API_KEYS = "roundk-admin:user_a:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "HTTP Billing", plan: "starter" }, "user_a");

    const summary = await app.request(`/api/billing/summary?workspaceId=${ws.id}`, {
      headers: { Authorization: "Bearer roundk-admin" }
    });
    expect(summary.status).toBe(200);
    const body = (await summary.json()) as { status: string; monthlyRunQuota: number };
    expect(body.status).toBe("trialing");
    expect(body.monthlyRunQuota).toBe(30);

    const upgraded = await app.request("/api/billing/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer roundk-admin" },
      body: JSON.stringify({ workspaceId: ws.id, plan: "enterprise" })
    });
    expect(upgraded.status).toBe(200);
    const upgradedBody = (await upgraded.json()) as { plan: string; monthlyRunQuota: number };
    expect(upgradedBody.plan).toBe("enterprise");
    expect(upgradedBody.monthlyRunQuota).toBe(0);

    await service.shutdown();
  });
});

describe("Round K: north-star instrumentation (audit P1-07)", () => {
  it("records lifecycle events and computes activation/day7 rates", async () => {
    process.env.NEUROCLAW_API_KEYS = undefined;
    delete process.env.NEUROCLAW_API_KEYS;

    const service = await ControlPlaneService.create();
    const workspace = await service.createWorkspace({ name: "NorthStar Lab", plan: "growth" }, "founder");

    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    expect(run.status).toBe("completed"); // inline mode

    const overview = await service.getNorthStarOverview({ days: 30 });
    expect(overview.totals["workspace.created"]).toBeGreaterThanOrEqual(1);
    expect(overview.totals["run.created"]).toBeGreaterThanOrEqual(1);
    expect(overview.totals["run.completed"]).toBeGreaterThanOrEqual(1);
    expect(overview.totals["day7_first_result"]).toBeGreaterThanOrEqual(1);
    expect(overview.activationRate).toBeGreaterThan(0);
    expect(overview.day7SuccessRate).toBeGreaterThan(0);

    // Workspace-scoped view stays member-scoped over HTTP; global needs admin.
    process.env.NEUROCLAW_API_KEYS = "roundk-viewer:viewer_u:viewer";
    const db = await (await import("@neuroclaw/db")).createInMemoryDb();
    const scoped = await ControlPlaneService.create(undefined, db);
    const app = createApp(scoped);
    const forbidden = await app.request("/api/analytics/northstar", {
      headers: { Authorization: "Bearer roundk-viewer" }
    });
    expect(forbidden.status).toBe(403);

    await service.shutdown();
    await scoped.shutdown();
  });
});
