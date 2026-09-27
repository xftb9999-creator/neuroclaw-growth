import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { agents, createInMemoryDb } from "@neuroclaw/db";
import { createAgentInputSchema, updateAgentInputSchema, type CreateAgentInput } from "@neuroclaw/shared";
import { AGENT_ROLE_KEYS } from "@neuroclaw/agent-workforce-contract";
import { ControlPlaneService, TEAM_PLAYBOOKS, TEMPLATE_ROLE_MAP } from "./index.js";

/**
 * AW-5 片1 · role 实例层贯通验收（GM 裁决②③）：
 * - shared 层宽松 string 承载；control-plane 注册边界 fail-closed 解析；
 * - 非法 role 零 DB 写、零注册；旧行为（无 role / 旧 roleKey）兼容；
 * - 内置 playbook 经 TEMPLATE_ROLE_MAP 派生 contract §1 的 AgentRoleKey。
 */

async function setupService() {
  const db = await createInMemoryDb();
  const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
    durable: false
  });
  return { db, service };
}

function baseInput(slug: string): CreateAgentInput {
  return {
    slug,
    name: "AW5 Agent",
    baseEngine: "content_acquisition",
    persona: "aw5 persona",
    focusAreas: [],
    outputStyle: "structured",
    toolNames: []
  };
}

describe("AW-5 片1: agent role 边界（fail-closed）", () => {
  it("shared schema 宽松承载 role（任意字符串过、非字符串拒）", () => {
    const base = { slug: "x_1", name: "X", baseEngine: "weekly_review", persona: "persona!" };
    expect(createAgentInputSchema.safeParse({ ...base, role: "any_future_role" }).success).toBe(true);
    expect(createAgentInputSchema.safeParse({ ...base, role: 42 }).success).toBe(false);
    expect(updateAgentInputSchema.safeParse({ role: "any_future_role" }).success).toBe(true);
    expect(updateAgentInputSchema.safeParse({ role: 42 }).success).toBe(false);
  });

  it("createAgent 持久化合法 role 并回读（DB + listAgents）", async () => {
    const { db, service } = await setupService();
    const template = await service.createAgent({ ...baseInput("aw5_role_ok"), role: "content_editor" });
    expect(template.id).toBe("agt_aw5_role_ok");

    const rows = await db.select().from(agents).where(eq(agents.slug, "aw5_role_ok"));
    expect(rows[0]?.role).toBe("content_editor");

    const listed = await service.listAgents();
    expect(listed.find((agent) => agent.slug === "aw5_role_ok")?.role).toBe("content_editor");
    await service.shutdown();
  });

  it("旧行为兼容：不带 role 的 createAgent 仍合法（NULL）", async () => {
    const { db, service } = await setupService();
    await service.createAgent(baseInput("aw5_role_legacy"));
    const rows = await db.select().from(agents).where(eq(agents.slug, "aw5_role_legacy"));
    expect(rows[0]?.role).toBeNull();
    await service.shutdown();
  });

  it("非法 role 在注册边界被拒：零 DB 写、零注册", async () => {
    const { db, service } = await setupService();
    await expect(
      service.createAgent({ ...baseInput("aw5_role_bad"), role: "growth_hacker" })
    ).rejects.toThrow(/Invalid agent role/);
    const rows = await db.select().from(agents).where(eq(agents.slug, "aw5_role_bad"));
    expect(rows).toHaveLength(0);
    expect(service.registry.get("aw5_role_bad")).toBeUndefined();
    await service.shutdown();
  });

  it("updateAgent 非法 role 拒绝且不落库；合法 role 持久化", async () => {
    const { db, service } = await setupService();
    await service.createAgent(baseInput("aw5_update"));
    const [row] = await db.select().from(agents).where(eq(agents.slug, "aw5_update"));
    expect(row).toBeDefined();

    await expect(service.updateAgent(row.id, { role: "side_quest" })).rejects.toThrow(
      /Invalid agent role/
    );
    const [unchanged] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(unchanged.role).toBeNull();

    await service.updateAgent(row.id, { role: "analyst" });
    const [updated] = await db.select().from(agents).where(eq(agents.id, row.id));
    expect(updated.role).toBe("analyst");
    await service.shutdown();
  });

  it("loadCustomAgents 对篡改的非法 role fail-closed（拒绝装载）", async () => {
    const { db, service } = await setupService();
    await service.createAgent({ ...baseInput("aw5_tamper"), role: "analyst" });
    await db.execute(sql`UPDATE agents SET role = 'rogue' WHERE slug = 'aw5_tamper'`);
    await expect(service.loadCustomAgents()).rejects.toThrow(/Invalid agent role/);
    await service.shutdown();
  });
});

describe("AW-5 片1: templates ↔ AgentRoleKey 映射与内置 playbook", () => {
  it("TEMPLATE_ROLE_MAP 覆盖三内置模板且值域为 contract §1", () => {
    expect(TEMPLATE_ROLE_MAP).toEqual({
      content_acquisition: "content_editor",
      private_conversion: "conversion_writer",
      weekly_review: "analyst"
    });
    const valid = new Set<string>(AGENT_ROLE_KEYS);
    for (const steps of Object.values(TEAM_PLAYBOOKS)) {
      for (const step of steps) expect(valid.has(step.roleKey)).toBe(true);
    }
  });

  it("运行路径证据：getPlaybooks 返回内置 playbook 的升级后 roleKey", async () => {
    const { service } = await setupService();
    const playbooks = await service.getPlaybooks();
    const sprint = playbooks.find((playbook) => playbook.key === "sprint");
    expect(sprint?.steps.map((step) => step.roleKey)).toEqual([
      "content_editor",
      "conversion_writer",
      "analyst"
    ]);
    await service.shutdown();
  });

  it("旧行为兼容：历史 roleKey（content）的自定义 playbook 仍可保存并接力", async () => {
    const { service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 Compat", plan: "business" }, "founder");
    await service.savePlaybook("aw5_legacy_keys", {
      name: "Legacy Keys",
      steps: [{ templateType: "content_acquisition", roleKey: "content", feedFrom: [] }]
    });
    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "aw5_legacy_keys",
      goal: "compat probe"
    })) as { teamRunId: string };
    expect(launched.teamRunId).toBeTruthy();
    await service.shutdown();
  });
});
