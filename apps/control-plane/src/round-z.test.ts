import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createInMemoryDb } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalKeys = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalKeys;
});

const RUN_INPUT = {
  businessSummary: "Round Z injection probe",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

describe("Round Z: knowledge recall visibility filter", () => {
  it("only recalls knowledge from the requesting workspace (cross-tenant isolation)", async () => {
    process.env.NEUROCLAW_API_KEYS = "z-key:z_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const wsA = await service.createWorkspace({ name: "Tenant A", plan: "team" }, "z_user");
    const wsB = await service.createWorkspace({ name: "Tenant B", plan: "team" }, "z_user");

    // Seed knowledge in wsB only.
    await service.createKnowledgeEntry({
      workspaceId: wsB.id,
      title: "Tenant B secret",
      content: "B-exclusive strategy"
    });

    // Run in wsA should NOT recall wsB knowledge.
    const runA = await service.createRun({
      workspaceId: wsA.id,
      templateType: "content_acquisition",
      input: { ...RUN_INPUT, _teamId: undefined }
    });

    const knowledgeA = (runA.input as { _knowledge?: Array<{ title: string }> })._knowledge;
    if (Array.isArray(knowledgeA)) {
      for (const k of knowledgeA) {
        expect(k.title).not.toContain("Tenant B secret");
      }
    }

    await service.shutdown();
  });

  it("excludes recalled knowledge from other workspaces in semantic search", async () => {
    process.env.NEUROCLAW_API_KEYS = "z-key:z_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const wsA = await service.createWorkspace({ name: "Sep A", plan: "team" }, "z_user");
    const wsB = await service.createWorkspace({ name: "Sep B", plan: "team" }, "z_user");

    // Seed in both.
    await service.createKnowledgeEntry({
      workspaceId: wsA.id,
      title: "A knowledge",
      content: "A content"
    });
    await service.createKnowledgeEntry({
      workspaceId: wsB.id,
      title: "B knowledge",
      content: "B content"
    });

    // Search wsA should only return A entries.
    const resultsA = await service.searchKnowledge(wsA.id, "knowledge");
    expect(resultsA.every((entry) => entry.workspaceId === wsA.id)).toBe(true);

    await service.shutdown();
  });
});