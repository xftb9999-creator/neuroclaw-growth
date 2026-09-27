import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createInMemoryDb, runs, teamRuns } from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";

/**
 * AW-5 片 2 · relay 结构化交接集成验收（判据①③）：
 * - 正向：内置 sprint 接力，第二棒 run.input.handoffPayload＝上游产出结构化投影
 *   （保持 string[] 结构；businessSummary 不再拼接 carried 文本）。
 * - 负向：构造含下游/上游均未声明字段的 payload ⇒ 拒且零下游 run 创建；
 *   期望字段缺失 ⇒ 拒；类型错配 ⇒ 拒。relay 拒绝后置 failed。
 * - 播种路径：直接构造 relay/上游 run 行 + paused→running 恢复，以精确控制
 *   上游 outputPayload（覆盖真实运行中难以构造的污染/错配场景）。
 */

async function setupService() {
  const db = await createInMemoryDb();
  const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
    durable: false
  });
  return { db, service };
}

async function seedRelay(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  workspaceId: string,
  options: { upstreamOutput: Record<string, unknown>; feedFrom: string[] }
) {
  const now = new Date().toISOString();
  const upstreamRunId = `run_aw5p2_seed_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(runs).values({
    id: upstreamRunId,
    workspaceId,
    templateType: "content_acquisition",
    status: "completed",
    input: JSON.stringify({ businessSummary: "seed" }),
    outputPayload: JSON.stringify(options.upstreamOutput),
    approvalStatus: "not_required",
    createdAt: now,
    updatedAt: now,
    completedAt: now
  });
  const relayId = `team_aw5p2_seed_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(teamRuns).values({
    id: relayId,
    workspaceId,
    playbookKey: "aw5_p2_seeded",
    goal: "aw5 p2 seed probe",
    audience: "",
    status: "paused",
    currentStep: 1,
    stepsJson: JSON.stringify([
      { templateType: "content_acquisition", roleKey: "content_editor", feedFrom: [] },
      { templateType: "private_conversion", roleKey: "conversion_writer", feedFrom: options.feedFrom }
    ]),
    runIdsJson: JSON.stringify([upstreamRunId]),
    createdAt: now,
    updatedAt: now
  });
  return { relayId, upstreamRunId };
}

describe("AW-5 片2: relay 结构化交接（判据①③）", () => {
  it("正向：内置 sprint 第二棒携带 handoffPayload（结构保留，无字符串拼接）", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P2", plan: "business" }, "founder");

    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "sprint",
      goal: "aw5 p2 probe"
    })) as { teamRunId: string };

    const relayRow = (
      await db.select().from(teamRuns).where(eq(teamRuns.id, launched.teamRunId))
    )[0];
    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    expect(runIds).toHaveLength(2); // 第一棒 completed → 第二棒已创建（waiting_approval）

    const step1 = await service.getRun(runIds[0]);
    const step2 = await service.getRun(runIds[1]);
    const upstreamPayload = step1.outputPayload ?? {};
    const step2Input = step2.input as Record<string, unknown>;

    expect(step2Input.handoffPayload).toEqual({
      contentAngles: upstreamPayload.contentAngles,
      channelRecommendations: upstreamPayload.channelRecommendations
    });
    // 结构保留：string[] 仍是数组（非 join 字符串）
    expect(Array.isArray((step2Input.handoffPayload as Record<string, unknown>).contentAngles)).toBe(
      true
    );
    // 字符串拼接路径已被结构化路径替代
    expect(step2Input.businessSummary).toBe("aw5 p2 probe");

    await service.shutdown();
  });

  it("负向③：payload 含未声明字段 ⇒ 拒且零下游 run 创建，relay failed", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P2 Rogue", plan: "business" }, "founder");
    const { relayId, upstreamRunId } = await seedRelay(db, ws.id, {
      upstreamOutput: { rogueField: "pollution" },
      feedFrom: ["rogueField"]
    });

    await expect(service.updateRelayRunStatus(relayId, "running")).rejects.toThrow(
      /UNDECLARED_FIELD\(rogueField\)/
    );

    const relayRow = (await db.select().from(teamRuns).where(eq(teamRuns.id, relayId)))[0];
    expect(relayRow.status).toBe("failed");
    expect(JSON.parse(relayRow.runIdsJson)).toEqual([upstreamRunId]); // 未追加下游 run
    const runsInWorkspace = await db.select().from(runs).where(eq(runs.workspaceId, ws.id));
    expect(runsInWorkspace).toHaveLength(1); // 零下游 run 创建

    await service.shutdown();
  });

  it("负向：期望交接字段缺失 ⇒ 拒且零下游 run 创建（不再静默丢字段）", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P2 Missing", plan: "business" }, "founder");
    const { relayId } = await seedRelay(db, ws.id, {
      upstreamOutput: { contentAngles: ["a1"] },
      feedFrom: ["missingField"]
    });

    await expect(service.updateRelayRunStatus(relayId, "running")).rejects.toThrow(
      /MISSING_HANDOFF_FIELD\(missingField\)/
    );
    expect(
      (await db.select().from(teamRuns).where(eq(teamRuns.id, relayId)))[0].status
    ).toBe("failed");
    expect(await db.select().from(runs).where(eq(runs.workspaceId, ws.id))).toHaveLength(1);

    await service.shutdown();
  });

  it("负向①：交接值类型错配 ⇒ 拒且零下游 run 创建", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P2 Type", plan: "business" }, "founder");
    const { relayId } = await seedRelay(db, ws.id, {
      upstreamOutput: { contentAngles: "not-an-array" },
      feedFrom: ["contentAngles"]
    });

    await expect(service.updateRelayRunStatus(relayId, "running")).rejects.toThrow(
      /TYPE_MISMATCH\(contentAngles\)/
    );
    expect(await db.select().from(runs).where(eq(runs.workspaceId, ws.id))).toHaveLength(1);

    await service.shutdown();
  });

  it("对照组：声明内字段（上游 outputContract）通过并结构化注入下游 run", async () => {
    const { db, service } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P2 Pass", plan: "business" }, "founder");
    const { relayId, upstreamRunId } = await seedRelay(db, ws.id, {
      upstreamOutput: { contentAngles: ["a1", "a2"] },
      feedFrom: ["contentAngles"]
    });

    await service.updateRelayRunStatus(relayId, "running");

    const relayRow = (await db.select().from(teamRuns).where(eq(teamRuns.id, relayId)))[0];
    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    expect(runIds).toEqual([upstreamRunId, expect.any(String)]);
    const downstream = await service.getRun(runIds[1]);
    expect((downstream.input as Record<string, unknown>).handoffPayload).toEqual({
      contentAngles: ["a1", "a2"]
    });

    await service.shutdown();
  });
});
