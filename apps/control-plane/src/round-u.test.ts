import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

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

describe("Round U: crew migration baseline", () => {
  it("creates teams/team_members tables and memory visibility column", async () => {
    const db = await createInMemoryDb();

    const tables = (await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('teams','team_members')`
    )) as unknown as { rows: Array<{ table_name: string }> };
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(["team_members", "teams"]);

    const col = (await db.execute(
      sql`SELECT column_default FROM information_schema.columns
          WHERE table_name='memory_records' AND column_name='visibility'`
    )) as unknown as { rows: Array<{ column_default: string }> };
    expect(col.rows[0]?.column_default).toContain("private");

    await (await import("@neuroclaw/db")).closeDatabase(db);
  });
});

describe("Round U: crew team lifecycle", () => {
  it("creates, lists, transitions and archives a team", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Crew Lab", plan: "business" }, "founder");

    const created = (await service.createCrewTeam(ws.id, { name: "Growth Squad", goal: "Q4 push" }, "founder")) as {
      id: string;
      status: string;
      members: unknown[];
    };
    expect(created.status).toBe("active");
    expect(created.members).toHaveLength(0);

    const list = (await service.listCrewTeams(ws.id)) as Array<{ id: string; status: string }>;
    expect(list).toHaveLength(1);

    await service.setCrewTeamStatus(created.id, "paused");
    await service.setCrewTeamStatus(created.id, "active");
    await service.setCrewTeamStatus(created.id, "archived");

    // archived is terminal.
    await expect(service.setCrewTeamStatus(created.id, "active")).rejects.toThrow(/Cannot transition/);

    await service.shutdown();
  });

  it("manages members with agent existence + uniqueness enforcement", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Member Lab", plan: "team" }, "founder");
    const agentA = await service.createAgent({
      slug: "member-a",
      name: "Member A",
      baseEngine: "content_acquisition",
      persona: "test persona",
      focusAreas: [],
      outputStyle: "structured",
      toolNames: []
    });
    const agentB = await service.createAgent({
      slug: "member-b",
      name: "Member B",
      baseEngine: "content_acquisition",
      persona: "test persona",
      focusAreas: [],
      outputStyle: "structured",
      toolNames: []
    });

    const team = (await service.createCrewTeam(ws.id, { name: "Squad" }, "founder")) as { id: string };

    const added = (await service.addCrewMember(team.id, agentA.id, "content")) as { id: string };
    await service.addCrewMember(team.id, agentB.id, "conversion");

    await expect(
      service.addCrewMember(team.id, agentA.id, "review")
    ).rejects.toThrow(/already belongs/);

    await service.removeCrewMember(team.id, added.id);
    const detail = (await service.getCrewTeam(team.id)) as { members: Array<{ id: string; agentId: string }> };
    expect(detail.members).toHaveLength(1);
    // Members store the canonical agents row id (resolved from agt_ slug).
    const agentBRow = await service.db
      .select({ id: (await import("@neuroclaw/db")).agents.id })
      .from((await import("@neuroclaw/db")).agents)
      .where((await import("drizzle-orm")).eq((await import("@neuroclaw/db")).agents.slug, "member-b"));
    expect(detail.members[0].agentId).toBe(agentBRow[0].id);

    await expect(service.addCrewMember(team.id, "agent_missing", "content")).rejects.toThrow(
      /Agent not found/
    );

    await service.shutdown();
  });
});

describe("Round U: crew HTTP surface + ACL", () => {
  it("scopes teams per user and enforces membership on mutations", async () => {
    process.env.NEUROCLAW_API_KEYS = "u-key:user_a:admin,v-key:user_b:admin";
    const db = await createInMemoryDb();
    const service = await ControlPlaneService.create(undefined, db);
    const app = createApp(service);

    const created = await app.request("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u-key" },
      body: JSON.stringify({ workspaceId: "ws_none", name: "X", goal: "" })
    });
    // Unknown workspace still 404s via assertWorkspaceExists.
    expect([400, 404]).toContain(created.status);

    const ws = await service.createWorkspace({ name: "ACL Lab", plan: "starter" }, "user_a");
    const okCreate = await app.request("/api/teams", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u-key" },
      body: JSON.stringify({ workspaceId: ws.id, name: "Alpha Squad", goal: "grow" })
    });
    expect(okCreate.status).toBe(201);
    const team = (await okCreate.json()) as { id: string; status: string };

    // Outsider cannot read or mutate.
    const outsiderRead = await app.request(`/api/teams/${team.id}`, {
      headers: { Authorization: "Bearer v-key" }
    });
    expect(outsiderRead.status).toBe(403);

    process.env.NEUROCLAW_API_KEYS = "u2-key:user_a2:admin";
    const outsiderPatch = await app.request(`/api/teams/${team.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u2-key" },
      body: JSON.stringify({ teamId: team.id, status: "paused" })
    });
    expect(outsiderPatch.status).toBe(403);

    // Owner pauses then re-activates.
    process.env.NEUROCLAW_API_KEYS = "u-key:user_a:admin";
    const pause = await app.request(`/api/teams/${team.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u-key" },
      body: JSON.stringify({ teamId: team.id, status: "paused" })
    });
    expect(pause.status).toBe(200);
    const resume = await app.request(`/api/teams/${team.id}/status`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: "Bearer u-key" },
      body: JSON.stringify({ teamId: team.id, status: "active" })
    });
    expect(resume.status).toBe(200);

    await service.shutdown();
  });

  it("persists memory visibility default on completed runs", async () => {
    const service = await ControlPlaneService.create();
    const ws = await service.createWorkspace({ name: "Vis Lab", plan: "growth" });

    await service.createRun({
      workspaceId: ws.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "visibility probe",
        targetCustomer: "SMB operators",
        preferredChannels: ["email"],
        contentGoal: "hooks"
      }
    });

    const rows = (await service.db.execute(
      sql`SELECT visibility FROM memory_records LIMIT 1`
    )) as unknown as { rows: Array<{ visibility: string }> };
    expect(rows.rows[0]?.visibility).toBe("private");

    await service.shutdown();
  });
});
