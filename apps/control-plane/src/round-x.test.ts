import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { createInMemoryDb } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";

const BASE = {
  targetCustomer: "SMB operators",
  preferredChannels: ["email"],
  contentGoal: "hooks"
};

async function seedTeamMemory(service: ControlPlaneService, wsId: string, summary: string) {
  await service.db.execute(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await import("drizzle-orm")).sql`INSERT INTO memory_records
      (id, workspace_id, template_type, type, summary, source_run_id, is_pinned, is_suppressed, visibility, created_at, updated_at)
      VALUES (${"mem_x_" + Math.random().toString(16).slice(2)}, ${wsId}, 'content_acquisition', 'successful_output', ${summary}, 'run_seed', FALSE, FALSE, 'team', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
  );
}

describe("Round X: team memory recall into run prompts", () => {
  it("injects team-visible memories into crew-linked runs", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Recall Lab", plan: "enterprise" });
    await seedTeamMemory(service, ws.id, "小红书晚8点发布转化最佳");
    const crew = (await service.createCrewTeam(ws.id, { name: "Recall Crew" })) as { id: string };

    const run = await service.createRun({
      workspaceId: ws.id,
      templateType: "content_acquisition",
      input: { ...BASE, _teamId: crew.id, businessSummary: "week campaign" }
    });

    const memories = (run.input as { _memories?: string[] })._memories;
    expect(Array.isArray(memories)).toBe(true);
    expect(memories).toContain("小红书晚8点发布转化最佳");

    await service.shutdown();
  });

  it("does not inject memories for standalone runs", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Solo Lab", plan: "starter" });
    await seedTeamMemory(service, ws.id, "private lab insight");

    const run = await service.createRun({
      workspaceId: ws.id,
      templateType: "content_acquisition",
      input: { ...BASE, businessSummary: "solo campaign" }
    });

    expect((run.input as { _memories?: string[] })._memories).toBeUndefined();

    await service.shutdown();
  });
});
