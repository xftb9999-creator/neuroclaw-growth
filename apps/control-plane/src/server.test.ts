import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ControlPlaneService } from "./index.js";
import { createHttpServer, resolveStaticDir, startServer } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const staticDir = path.resolve(__dirname, "../../web/dist");

const servers: Array<ReturnType<typeof createHttpServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          // .close() errors when the server is already shut down (e.g. after
          // a graceful shutdown test). Treat that as success.
          server.close((error) => resolve());
        })
    )
  );
});

describe("control-plane http server", () => {
  it("resolves the default static dir to apps/web/dist and honors explicit override", () => {
    const resolved = resolveStaticDir();
    expect(resolved.replace(/\\/g, "/")).toContain("apps/web/dist");

    const override = resolveStaticDir("/custom/static");
    expect(override.replace(/\\/g, "/")).toBe("/custom/static");
  });

  it("creates workspaces, runs, and approvals over HTTP", async () => {
    const server = createHttpServer(await ControlPlaneService.create(), staticDir);
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const workspaceResponse = await fetch(`${baseUrl}/api/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Growth Lab",
        plan: "growth"
      })
    });

    const workspace = (await workspaceResponse.json()) as { id: string };
    expect(workspace.id).toBeDefined();

    const templates = (await fetch(`${baseUrl}/api/templates`).then((response) => response.json())) as Array<{ type: string }>;
    expect(templates).toHaveLength(3);

    const runResponse = await fetch(`${baseUrl}/api/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: workspace.id,
        templateType: "private_conversion",
        input: {
          businessSummary: "Send a high-touch conversion preview",
          targetCustomer: "Warm inbound leads",
          preferredChannels: ["email"],
          offerAsset: "Concierge conversion path"
        }
      })
    });

    const run = (await runResponse.json()) as { id: string; status: string };
    expect(run.status).toBe("waiting_approval");

    const approvals = (await fetch(`${baseUrl}/api/runs/${run.id}/approvals`).then((response) => response.json())) as Array<{ actionType: string }>;
    expect(approvals[0]?.actionType).toBe("notification_send_preview");

    const approved = (await fetch(`${baseUrl}/api/runs/${run.id}/approval`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        approved: true,
        reviewerId: "operator_1"
      })
    }).then((response) => response.json())) as { status: string };

    expect(approved.status).toBe("completed");

    const history = (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/runs`).then((response) => response.json())) as Array<{ id: string }>;
    expect(history[0]?.id).toBe(run.id);

    const clone = (await fetch(`${baseUrl}/api/runs/${run.id}/clone`, {
      method: "POST"
    }).then((response) => response.json())) as { sourceRunId: string };
    expect(clone.sourceRunId).toBe(run.id);

    const memory = (await fetch(`${baseUrl}/api/workspaces/${workspace.id}/memory`).then((response) => response.json())) as Array<{ id: string; isPinned: boolean }>;
    expect(memory).toHaveLength(1);

    const updatedMemory = (await fetch(`${baseUrl}/api/memory/${memory[0].id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        summary: "Pinned summary",
        isPinned: true
      })
    }).then((response) => response.json())) as { summary: string; isPinned: boolean };

    expect(updatedMemory.summary).toBe("Pinned summary");
    expect(updatedMemory.isPinned).toBe(true);

    const deleteResponse = await fetch(`${baseUrl}/api/memory/${memory[0].id}`, {
      method: "DELETE"
    }).then((response) => response.json());

    expect(deleteResponse.ok).toBe(true);
  });

  it("returns workspace-specific 404 codes for stale workspace reads", async () => {
    const server = createHttpServer(
      await ControlPlaneService.create(),
      staticDir
    );
    servers.push(server);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;

    const historyResponse = await fetch(`${baseUrl}/api/workspaces/missing/runs`);
    expect(historyResponse.status).toBe(404);
    await expect(historyResponse.json()).resolves.toEqual({
      message: "Workspace not found: missing",
      code: "WORKSPACE_NOT_FOUND"
    });

    const memoryResponse = await fetch(`${baseUrl}/api/workspaces/missing/memory`);
    expect(memoryResponse.status).toBe(404);
    await expect(memoryResponse.json()).resolves.toEqual({
      message: "Workspace not found: missing",
      code: "WORKSPACE_NOT_FOUND"
    });
  });

  it("gracefully shuts down the server and service via startServer().shutdown()", async () => {
    const runtime = await startServer({ port: 0, hostname: "127.0.0.1", staticDir });
    servers.push(runtime.httpServer);

    await once(runtime.httpServer, "listening");
    const address = runtime.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("Missing server address");
    }

    const baseUrl = `http://127.0.0.1:${address.port}`;
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);

    // Initiate graceful shutdown — should not throw and should close the server.
    await runtime.shutdown();

    // After shutdown, the server should reject new connections.
    await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
  });
});
