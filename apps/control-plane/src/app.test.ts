import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createInMemoryDb, auditEvents, type Database } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalEnv = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalEnv === undefined) {
    delete process.env.NEUROCLAW_API_KEYS;
  } else {
    process.env.NEUROCLAW_API_KEYS = originalEnv;
  }
});

async function setupApp(db?: Database) {
  const database = db ?? (await createInMemoryDb());
  const service = await ControlPlaneService.create(undefined, database);
  const app = createApp(service);
  return { app, service, db: database };
}

describe("Hono app: validation", () => {
  it("rejects invalid workspace input with 422", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", plan: "invalid_plan" })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
    expect(body.issues).toHaveLength(2);
  });

  it("rejects invalid run input with 422", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: "", templateType: "unknown" })
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("VALIDATION_ERROR");
  });
});

describe("Hono app: API key auth", () => {
  beforeAll(() => {
    process.env.NEUROCLAW_API_KEYS = "test-key-admin-123:admin_user:admin,test-key-viewer-456:viewer_user:viewer";
  });

  it("rejects requests without API key", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/templates");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_MISSING");
  });

  it("rejects invalid API key", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/templates", {
      headers: { Authorization: "Bearer wrong-key" }
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("AUTH_INVALID");
  });

  it("accepts valid admin API key via Bearer", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/templates", {
      headers: { Authorization: "Bearer test-key-admin-123" }
    });
    expect(res.status).toBe(200);
  });

  it("accepts valid API key via X-API-Key header", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/templates", {
      headers: { "X-API-Key": "test-key-viewer-456" }
    });
    expect(res.status).toBe(200);
  });

  it("viewer role cannot create workspaces (403)", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key-viewer-456"
      },
      body: JSON.stringify({ name: "Test", plan: "starter" })
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe("AUTH_FORBIDDEN");
  });

  it("admin role can create workspaces", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/workspaces", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key-admin-123"
      },
      body: JSON.stringify({ name: "Admin WS", plan: "growth" })
    });
    expect(res.status).toBe(201);
  });
});

describe("Hono app: audit logging", () => {
  beforeAll(() => {
    delete process.env.NEUROCLAW_API_KEYS;
  });

  it("logs audit events for workspace creation", async () => {
    const db = await createInMemoryDb();
    const { app } = await setupApp(db);

    await app.request("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Audited WS", plan: "growth" })
    });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "workspace.create"));
    expect(events).toHaveLength(1);
    expect(events[0].resourceType).toBe("workspace");
    expect(events[0].actorId).toBe("dev");
  });

  it("logs audit events for run creation", async () => {
    const db = await createInMemoryDb();
    const { app, service } = await setupApp(db);

    const ws = await service.createWorkspace({ name: "Test", plan: "growth" });

    await app.request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: ws.id,
        templateType: "private_conversion",
        input: {
          businessSummary: "Test",
          targetCustomer: "Test",
          preferredChannels: ["email"],
          offerAsset: "Test"
        }
      })
    });

    const events = await db.select().from(auditEvents).where(eq(auditEvents.action, "run.create"));
    expect(events).toHaveLength(1);
    expect(events[0].workspaceId).toBe(ws.id);
  });
});
