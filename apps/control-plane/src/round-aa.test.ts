import { afterAll, describe, expect, it } from "vitest";

import { createInMemoryDb, industryBenchmarks } from "@neuroclaw/db";
import { formatBenchmarkContext } from "@neuroclaw/agent-core";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalKeys = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalKeys;
});

const RUN_INPUT = {
  businessSummary: "Round AA benchmark injection campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

describe("Round AA: industry benchmark cloud v1 — persona prompt injection", () => {
  it("computes duration percentiles and injects _benchmarks into run input", async () => {
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);

    // 3 workspaces × 2 completed runs in the same industry (6 ≥ 5 k-anonymity).
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

    const computed = await service.computeIndustryBenchmarks();
    expect(computed).toBeGreaterThanOrEqual(1);

    const benchmarks = await service.getIndustryBenchmarks("beauty");
    const contentBench = benchmarks.find((b) => b.templateType === "content_acquisition");
    expect(contentBench).toBeDefined();
    expect(contentBench!.p50DurationSec).not.toBeNull();
    expect(contentBench!.p90DurationSec).not.toBeNull();
    expect(contentBench!.p90DurationSec!).toBeGreaterThanOrEqual(contentBench!.p50DurationSec!);

    // Seed a higher-sample peer group to exercise the top-5 sort deterministically.
    await db.insert(industryBenchmarks).values({
      id: "bench_beauty_conversion_copy",
      industry: "beauty",
      templateType: "conversion_copy",
      totalRuns: 99,
      completedRuns: 88,
      successRate: 0.88,
      p50DurationSec: 12,
      p90DurationSec: 40,
      sampleSize: 99,
      period: "all",
      createdAt: new Date().toISOString()
    });

    // Injection: workspace with industry + aggregated data → _benchmarks in input.
    const alpha = await service.createWorkspace({ name: "Alpha", plan: "team" });
    await service.setWorkspaceIndustry(alpha.id, "beauty");
    const alphaRun = await service.createRun({
      workspaceId: alpha.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    const persisted = await service.getRun(alphaRun.id);
    const injected = (persisted.input as { _benchmarks?: Array<{ templateType: string; sampleSize: number }> })._benchmarks;
    expect(Array.isArray(injected)).toBe(true);
    expect(injected![0].templateType).toBe("conversion_copy"); // sorted by sampleSize desc
    expect(injected!.some((b) => b.templateType === "content_acquisition")).toBe(true);

    // Workspace without industry → no injection.
    const beta = await service.createWorkspace({ name: "Beta", plan: "team" });
    const betaRun = await service.createRun({
      workspaceId: beta.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    const betaPersisted = await service.getRun(betaRun.id);
    expect((betaPersisted.input as { _benchmarks?: unknown })._benchmarks).toBeUndefined();

    // Industry without aggregated data → no injection.
    const gamma = await service.createWorkspace({ name: "Gamma", plan: "team" });
    await service.setWorkspaceIndustry(gamma.id, "empty_industry");
    const gammaRun = await service.createRun({
      workspaceId: gamma.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    const gammaPersisted = await service.getRun(gammaRun.id);
    expect((gammaPersisted.input as { _benchmarks?: unknown })._benchmarks).toBeUndefined();

    await service.shutdown();
  });

  it("exposes workspace industry via HTTP with ACL (cross-tenant 403)", async () => {
    process.env.NEUROCLAW_API_KEYS = "aa-key:aa_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "AA Lab", plan: "team" }, "aa_user");

    const patch = await app.request(`/api/workspaces/${ws.id}/industry`, {
      method: "PATCH",
      headers: { Authorization: "Bearer aa-key", "Content-Type": "application/json" },
      body: JSON.stringify({ industry: "beauty" })
    });
    expect(patch.status).toBe(200);

    const get = await app.request(`/api/workspaces/${ws.id}/industry`, {
      headers: { Authorization: "Bearer aa-key" }
    });
    expect(get.status).toBe(200);
    expect(((await get.json()) as { industry: string }).industry).toBe("beauty");

    // Cross-tenant workspace is invisible to aa_user.
    const foreign = await service.createWorkspace({ name: "Foreign", plan: "team" }, "mallory");
    const denied = await app.request(`/api/workspaces/${foreign.id}/industry`, {
      headers: { Authorization: "Bearer aa-key" }
    });
    expect(denied.status).toBe(403);

    // Benchmarks endpoint stays auth-gated and never leaks workspace ids.
    const benchmarks = await app.request("/api/benchmarks/beauty", {
      headers: { Authorization: "Bearer aa-key" }
    });
    expect(benchmarks.status).toBe(200);
    const raw = JSON.stringify(await benchmarks.json());
    expect(raw).not.toContain("ws_");

    await service.shutdown();
  });

  it("formatBenchmarkContext renders an optional prompt section", () => {
    expect(formatBenchmarkContext({} as Record<string, unknown>)).toBe("");

    const section = formatBenchmarkContext({
      _benchmarks: [
        {
          templateType: "content_acquisition",
          successRate: 0.8,
          p50DurationSec: 45.4,
          p90DurationSec: 120.9,
          sampleSize: 120
        },
        { templateType: "conversion_copy", successRate: null, sampleSize: 30 }
      ]
    } as Record<string, unknown>);

    expect(section).toContain("Industry benchmarks");
    expect(section).toContain("content_acquisition: peer success 80%");
    expect(section).toContain("n=120");
    expect(section).toContain("n/a");
  });
});
