import { afterAll, describe, expect, it } from "vitest";
import { eq, and, sql } from "drizzle-orm";

import { createInMemoryDb, memoryRecords, teamRuns, teams } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const originalKeys = process.env.NEUROCLAW_API_KEYS;

afterAll(() => {
  if (originalKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
  else process.env.NEUROCLAW_API_KEYS = originalKeys;
});

const BASE = {
  businessSummary: "Round V relay probe",
  targetCustomer: "SMB operators",
  preferredChannels: ["email"]
};

async function setupService(durable = false) {
  const db = await createInMemoryDb();
  const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
    durable
  });
  return { db, service };
}

describe("Round V: relay ↔ team linkage + team-visible memories", () => {
  it("threads crewTeamId through step runs and marks their memories team-visible", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "Link Lab", plan: "enterprise" }, "f");

    const agent = await service.createAgent({
      slug: "link-agent",
      name: "Link Agent",
      baseEngine: "content_acquisition",
      persona: "p",
      focusAreas: [],
      outputStyle: "structured",
      toolNames: []
    });
    const crew = (await service.createCrewTeam(ws.id, { name: "Alpha" }, "f")) as { id: string };
    await service.addCrewMember(crew.id, agent.id, "content");

    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "sprint",
      goal: "round v link",
      crewTeamId: crew.id
    })) as { teamRunId: string; run: { id: string; status: string } };

    // Drain inline? launchTeam steps are async via createRun inline — the
    // first run already completed synchronously inside launchTeamStep.
    const relayRow = (
      await db.select().from(teamRuns).where(eq(teamRuns.id, launched.teamRunId))
    )[0];
    expect(relayRow.teamId).toBe(crew.id);

    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    expect(runIds.length).toBeGreaterThan(0);
    const stepRun = await service.getRun(runIds[0]);
    expect(stepRun.teamId).toBe(crew.id);

    // Team-visible memory deposited for the completed step run.
    const mem = (await service.db.execute(
      sql`SELECT visibility FROM memory_records WHERE source_run_id = ${runIds[0]}`
    )) as unknown as { rows: Array<{ visibility: string }> };
    expect(mem.rows[0]?.visibility).toBe("team");

    await service.shutdown();
  });

  it("keeps standalone-run memories private", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Private Lab", plan: "starter" });
    const run = await service.createRun({
      workspaceId: ws.id,
      templateType: "content_acquisition",
      input: { ...BASE, contentGoal: "hooks" }
    });

    const mem = (await service.db.execute(
      sql`SELECT visibility FROM memory_records WHERE source_run_id = ${run.id}`
    )) as unknown as { rows: Array<{ visibility: string }> };
    expect(mem.rows[0]?.visibility).toBe("private");
    expect(run.teamId).toBeUndefined();

    await service.shutdown();
  });
});

describe("Round V: relay-level control (pause / resume / cancel)", () => {
  it("pause holds advancement at the boundary; resume continues; cancel cascades", async () => {
    const { db, service } = await setupService();

    const ws = await service.createWorkspace({ name: "Control Lab", plan: "business" }, "founder");
    // Custom playbook: approval-gated first step keeps the relay in a
    // deterministic waiting state for pause/resume/cancel assertions.
    await service.savePlaybook("v_controlled", {
      name: "V Controlled",
      steps: [
        { templateType: "private_conversion", roleKey: "conversion", feedFrom: [] },
        { templateType: "content_acquisition", roleKey: "content", feedFrom: [] }
      ]
    });

    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "v_controlled",
      goal: "control probe"
    })) as { teamRunId: string; run: { id: string; status: string } };
    expect(launched.run.status).toBe("waiting_approval");

    // Pause while waiting — completion of this step must NOT auto-advance.
    await service.updateRelayRunStatus(launched.teamRunId, "paused");
    let relay = (await service.getTeam(launched.teamRunId)) as unknown as { status: string };
    expect(relay.status).toBe("paused");

    await service.updateApproval(launched.run.id, { approved: true, reviewerId: "op" });

    relay = (await service.getTeam(launched.teamRunId)) as unknown as { status: string };
    expect(relay.status).toBe("paused"); // held at boundary

    // Resume → launches the second step now.
    await service.updateRelayRunStatus(launched.teamRunId, "running");
    relay = (await service.getTeam(launched.teamRunId)) as unknown as { status: string };
    expect(["running", "completed"]).toContain(relay.status);

    await service.shutdown();
  });

  it("cancelling a waiting relay cascades to its active step run", async () => {
    const { db, service } = await setupService(true); // durable: step runs are cancellable
    const ws = await service.createWorkspace({ name: "Cancel Cascade", plan: "team" }, "founder");

    await service.savePlaybook("v_cancel", {
      name: "V Cancel",
      steps: [{ templateType: "content_acquisition", roleKey: "content", feedFrom: [] }]
    });

    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "v_cancel",
      goal: "cancel me"
    })) as { teamRunId: string; run: { id: string; status: string } };

    await service.updateRelayRunStatus(launched.teamRunId, "cancelled");

    const relayRow = (
      await db.select().from(teamRuns).where(eq(teamRuns.id, launched.teamRunId))
    )[0];
    expect(relayRow.status).toBe("cancelled");

    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    for (const id of runIds) {
      expect((await service.getRun(id)).status).toBe("cancelled");
    }

    await service.shutdown();
  });
});

describe("Round V: team memory aggregation endpoint", () => {
  it("returns only team-visible memories over HTTP with ACL", async () => {
    process.env.NEUROCLAW_API_KEYS = "v-key:v_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "TM Lab", plan: "team" }, "v_user");
    const crew = (await service.createCrewTeam(ws.id, { name: "Mem Team" }, "v_user")) as { id: string };

    // One team-visible memory (direct insert for determinism).
    await service.db.execute(
      sql`INSERT INTO memory_records (id, workspace_id, template_type, type, summary, source_run_id, is_pinned, is_suppressed, visibility, created_at, updated_at)
          VALUES ('mem_team1', ${ws.id}, 'content_acquisition', 'successful_output', 'team insight', 'run_x', FALSE, FALSE, 'team', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    );
    // One private memory that must NOT appear.
    await service.db.execute(
      sql`INSERT INTO memory_records (id, workspace_id, template_type, type, summary, source_run_id, is_pinned, is_suppressed, visibility, created_at, updated_at)
          VALUES ('mem_priv1', ${ws.id}, 'content_acquisition', 'successful_output', 'private note', 'run_y', FALSE, FALSE, 'private', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`
    );

    const res = await app.request(`/api/teams/${crew.id}/memory`, {
      headers: { Authorization: "Bearer v-key" }
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      team: { id: string };
      memories: Array<{ summary: string }>;
    };
    expect(body.team.id).toBe(crew.id);
    expect(body.memories.some((m) => m.summary === "team insight")).toBe(true);
    expect(body.memories.some((m) => m.summary === "private note")).toBe(false);

    await service.shutdown();
  });
});

describe("Round W: crewTeamId survives HTTP validation", () => {
  it("persists runs.team_id when launching via the HTTP layer", async () => {
    process.env.NEUROCLAW_API_KEYS = "w-key:w_user:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const ws = await service.createWorkspace({ name: "W Link", plan: "enterprise" }, "w_user");
    const crew = (await service.createCrewTeam(ws.id, { name: "W Crew" }, "w_user")) as { id: string };

    const res = await app.request("/api/relay-runs/launch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer w-key" },
      body: JSON.stringify({
        workspaceId: ws.id,
        playbookKey: "sprint",
        goal: "http thread probe",
        crewTeamId: crew.id
      })
    });
    expect(res.status).toBe(201);

    // Every run row in this workspace must carry the crew team id.
    const allRuns = (await service.db.execute(
      sql`SELECT team_id FROM runs WHERE workspace_id = ${ws.id}`
    )) as unknown as { rows: Array<{ team_id: string | null }> };
    expect(allRuns.rows.length).toBeGreaterThan(0);
    for (const row of allRuns.rows) {
      expect(row.team_id).toBe(crew.id);
    }

    await service.shutdown();
  });
});