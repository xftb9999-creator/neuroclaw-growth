import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { createInMemoryDb, industryBenchmarks } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalKeys = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalKeys;
});

const RUN_INPUT = {
  businessSummary: "Round Y benchmark campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

describe("Round Y: industry benchmark cloud v0", () => {
  it("aggregates completed runs by industry into benchmarks (k-anonymity ≥5)", async () => {
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);

    // Create 3 workspaces in the same industry, each with 2 completed runs
    // (6 total ≥ 5 k-anonymity threshold).
    for (let i = 0; i < 3; i += 1) {
      const ws = await service.createWorkspace({ name: `Beauty ${i}`, plan: "team" });
      await service.setWorkspaceIndustry(ws.id, "beauty");
      for (let j = 0; j < 2; j += 1) {
        await service.createRun({
          workspaceId: ws.id,
          templateType: "content_acquisition",
          input: RUN_INPUT
        });
      }
    }

    // Also create a workspace with a different industry — should not appear.
    const other = await service.createWorkspace({ name: "Edu", plan: "starter" });
    await service.setWorkspaceIndustry(other.id, "education");
    await service.createRun({
      workspaceId: other.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });

    const computed = await service.computeIndustryBenchmarks();
    expect(computed).toBeGreaterThanOrEqual(1);

    const benchmarks = await service.getIndustryBenchmarks("beauty");
    expect(benchmarks.length).toBeGreaterThan(0);

    const contentBench = benchmarks.find((b) => b.templateType === "content_acquisition");
    expect(contentBench).toBeDefined();
    expect(contentBench!.sampleSize).toBeGreaterThanOrEqual(5);
    expect(contentBench!.successRate).toBeGreaterThan(0);

    // Education has only 1 sample — should be excluded by k-anonymity.
    const eduBenchmarks = await service.getIndustryBenchmarks("education");
    expect(eduBenchmarks.length).toBe(0);

    await service.shutdown();
  });

  it("returns benchmarks via HTTP without leaking workspace data", async () => {
    process.env.NEUROCLAW_API_KEYS = "y-key:y_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "Y Lab", plan: "team" }, "y_user");
    await service.setWorkspaceIndustry(ws.id, "beauty");
    for (let i = 0; i < 6; i += 1) {
      await service.createRun({
        workspaceId: ws.id,
        templateType: "content_acquisition",
        input: RUN_INPUT
      });
    }
    await service.computeIndustryBenchmarks();

    const res = await app.request("/api/benchmarks/beauty", {
      headers: { Authorization: "Bearer y-key" }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ sampleSize: number; successRate: number }>;
    expect(body.length).toBeGreaterThan(0);
    // No workspace_id leakage.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("ws_");

    await service.shutdown();
  });

  it("setWorkspaceIndustry stores and clears the industry field", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Industry Lab", plan: "starter" });

    await service.setWorkspaceIndustry(ws.id, "beauty");
    const rows = (await service.db.execute(
      sql`SELECT industry FROM workspaces WHERE id = ${ws.id}`
    )) as unknown as { rows: Array<{ industry: string }> };
    expect(rows.rows[0]?.industry).toBe("beauty");

    await service.setWorkspaceIndustry(ws.id, "");
    const cleared = (await service.db.execute(
      sql`SELECT industry FROM workspaces WHERE id = ${ws.id}`
    )) as unknown as { rows: Array<{ industry: string | null }> };
    expect(cleared.rows[0]?.industry).toBeNull();

    await service.shutdown();
  });
});
