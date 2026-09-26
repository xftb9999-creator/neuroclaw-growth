import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createInMemoryDb } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalKeys = process.env.NEUROCLAW_API_KEYS;

beforeAll(() => {
  delete process.env.NEUROCLAW_API_KEYS;
});

afterAll(() => {
  if (originalKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalKeys;
});

const RUN_INPUT = {
  businessSummary: "Round P stream campaign",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

describe("Round P: run event stream (SSE)", () => {
  it("emits a run frame and closes on terminal state", async () => {
    const service = await ControlPlaneService.create();
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "Stream Lab", plan: "team" }, "dev");
    const run = await service.createRun({
      workspaceId: ws.id,
      templateType: "content_acquisition",
      input: RUN_INPUT
    });
    // Inline mode: already terminal — the stream should emit exactly one
    // frame then close (server side), which the client reads to EOF.
    const res = await app.request(`/api/runs/${run.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    expect(body).toContain("event: run");
    expect(body).toContain(`"id":"${run.id}"`);
    expect(body).toContain('"status":"completed"');
    // Terminal state must close the stream (no ping/bye tail after).
    expect(body).not.toContain("event: bye");

    await service.shutdown();
  });

  it("maps unknown runs to a JSON error instead of a stream", async () => {
    const service = await ControlPlaneService.create();
    const app = createApp(service);

    const res = await app.request("/api/runs/nope/events");
    expect(res.status).toBe(404);

    await service.shutdown();
  });
});
