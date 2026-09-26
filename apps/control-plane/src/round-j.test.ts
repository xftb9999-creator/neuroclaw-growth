import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";
import { assertProductionReadiness, assertProductionStaticAssets } from "./server.js";

const originalEnv = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  NEUROCLAW_API_KEYS: process.env.NEUROCLAW_API_KEYS
};

afterAll(() => {
  if (originalEnv.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalEnv.NODE_ENV;
  if (originalEnv.DATABASE_URL === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalEnv.DATABASE_URL;
  if (originalEnv.NEUROCLAW_API_KEYS === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalEnv.NEUROCLAW_API_KEYS;
});

describe("Round J: durable execution mode (audit P0-C1)", () => {
  it("returns queued runs immediately and completes them via the job loop", async () => {
    const service = await ControlPlaneService.create(undefined, undefined, undefined, undefined, {
      durable: true
    });

    const workspace = await service.createWorkspace(
      { name: "Durable Lab", plan: "growth" },
      "founder"
    );
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "Launch a durable-mode campaign",
        targetCustomer: "SMB operators",
        preferredChannels: ["email"],
        contentGoal: "Generate hooks"
      }
    });

    expect(run.status).toBe("queued");

    const queuedRow = await service.getRun(run.id);
    expect(queuedRow.status).toBe("queued");

    // Drain the background loop exactly like the server timer would.
    let processed = 0;
    while (await service.processNextJob()) processed += 1;
    expect(processed).toBeGreaterThan(0);

    const finished = await service.getRun(run.id);
    expect(finished.status).toBe("completed");
    expect(finished.outputPayload?.contentAngles).toBeDefined();

    await service.shutdown();
  });

  it("keeps approval-required runs resumable through the job loop", async () => {
    const service = await ControlPlaneService.create(undefined, undefined, undefined, undefined, {
      durable: true
    });

    const workspace = await service.createWorkspace(
      { name: "Durable Approval Lab", plan: "growth" },
      "founder"
    );
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "High-touch conversion preview",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "VIP audit"
      }
    });

    let processed = 0;
    while (await service.processNextJob()) processed += 1;

    const waiting = await service.getRun(run.id);
    expect(waiting.status).toBe("waiting_approval");

    const resumed = await service.updateApproval(run.id, { approved: true, reviewerId: "op_j" });
    // Durable mode returns immediately after enqueueing the resume job.
    expect(resumed.approvalStatus).toBe("approved");
    expect(resumed.status).not.toBe("waiting_approval");

    while (await service.processNextJob()) processed += 1;
    expect(processed).toBeGreaterThan(1);

    const finished = await service.getRun(run.id);
    expect(finished.status).toBe("completed");

    await service.shutdown();
  });
});

describe("Round J: workspace membership ACL (audit P0-C4)", () => {
  it("rejects cross-tenant reads once membership exists", async () => {
    process.env.NEUROCLAW_API_KEYS =
      "roundj-a-key:user_a:admin,roundj-b-key:user_b:admin";
    const db = await (await import("@neuroclaw/db")).createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const created = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer roundj-a-key" },
      body: JSON.stringify({ name: "Tenant A", plan: "growth" })
    });
    expect(created.status).toBe(201);
    const workspace = (await created.json()) as { id: string };

    // Owner can read.
    const ownerRead = await app.request(`/api/workspaces/${workspace.id}/runs`, {
      headers: { Authorization: "Bearer roundj-a-key" }
    });
    expect(ownerRead.status).toBe(200);

    // Another tenant admin is rejected.
    const outsiderRead = await app.request(`/api/workspaces/${workspace.id}/runs`, {
      headers: { Authorization: "Bearer roundj-b-key" }
    });
    expect(outsiderRead.status).toBe(403);
    const body = (await outsiderRead.json()) as { code?: string };
    expect(body.code).toBe("WORKSPACE_FORBIDDEN");

    await service.shutdown();
  });

  it("allows bootstrap access only while a workspace has no member rows", async () => {
    process.env.NEUROCLAW_API_KEYS = "roundj-b-key:user_b:admin";
    const db = await (await import("@neuroclaw/db")).createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    // Created at service level (legacy path) — no membership seeded.
    const workspace = await service.createWorkspace({ name: "Legacy WS", plan: "starter" });

    const read = await app.request(`/api/workspaces/${workspace.id}/runs`, {
      headers: { Authorization: "Bearer roundj-b-key" }
    });
    expect(read.status).toBe(200);

    await service.shutdown();
  });
});

describe("Round J: production readiness gate (audit P0-C2)", () => {
  it("refuses to start in production without a persistent database", () => {
    process.env.NODE_ENV = "production";
    delete process.env.DATABASE_URL;
    process.env.NEUROCLAW_API_KEYS = "k:u:admin";
    expect(() => assertProductionReadiness()).toThrow(/DATABASE_URL/);
  });

  it("refuses to start in production when auth would fail open", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "postgres://localhost/neuroclaw";
    process.env.NEUROCLAW_API_KEYS = "";
    expect(() => assertProductionReadiness()).toThrow(/NEUROCLAW_API_KEYS/);
  });

  it("refuses local-file PGlite as a production database", () => {
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = "file:./data/neuroclaw.db";
    process.env.NEUROCLAW_API_KEYS = "k:u:admin";
    expect(() => assertProductionReadiness()).toThrow(/postgres:\/\//);
  });

  it("refuses to start in production when the web artifact is missing", () => {
    process.env.NODE_ENV = "production";
    expect(() => assertProductionStaticAssets("/definitely/missing/neuroclaw-web"))
      .toThrow(/web build artifact/);
  });

  it("requires a valid release manifest alongside the production web artifact", async () => {
    process.env.NODE_ENV = "production";
    const staticDir = await mkdtemp(path.join(os.tmpdir(), "neuroclaw-static-"));
    try {
      await writeFile(path.join(staticDir, "index.html"), "<!doctype html>");
      expect(() => assertProductionStaticAssets(staticDir)).toThrow(/release-manifest/);

      await writeFile(
        path.join(staticDir, "release-manifest.json"),
        JSON.stringify({ schemaVersion: 1, buildId: "invalid", assets: [] })
      );
      expect(() => assertProductionStaticAssets(staticDir)).toThrow(/release-manifest/);

      await writeFile(
        path.join(staticDir, "release-manifest.json"),
        JSON.stringify({ schemaVersion: 1, buildId: "a".repeat(64), assets: [] })
      );
      expect(() => assertProductionStaticAssets(staticDir)).not.toThrow();
    } finally {
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("does not enforce gates outside production", () => {
    delete process.env.NODE_ENV;
    delete process.env.DATABASE_URL;
    process.env.NEUROCLAW_API_KEYS = "";
    expect(() => assertProductionReadiness()).not.toThrow();
  });
});
