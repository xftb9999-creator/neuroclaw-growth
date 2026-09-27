import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { createInMemoryDb, runs, teamRuns } from "@neuroclaw/db";
import { InMemoryTraceLog } from "@neuroclaw/observability";
import { ControlPlaneService } from "./index.js";

/**
 * AW-5 片 3 · relay 交接事件（判据②）＋ carried 收口（判据④）集成验收：
 * - ② 内置 sprint 接力推进（第二棒创建）时发射 `team_handoff_accepted`，
 *   冻结 `{fromTask, toTask, fields}` 三字段且值正确；拒绝路径对照发
 *   `team_handoff_rejected`（片2 起即有，本片补事件断言）。
 * - ④ 替代路径覆盖旧场景：下游 run 以结构化 `handoffPayload` 承载上游字段，
 *   businessSummary 不再拼接 carried 文本；旧字符串拼接通道已移除（零引用）。
 * 事件通道＝注入的 InMemoryTraceLog（control-plane relay 级现有通道）。
 */

async function setupService() {
  const db = await createInMemoryDb();
  const traceLog = new InMemoryTraceLog();
  const service = await ControlPlaneService.create(undefined, db, undefined, traceLog, {
    durable: false
  });
  return { db, service, traceLog };
}

async function seedRelay(
  db: Awaited<ReturnType<typeof createInMemoryDb>>,
  workspaceId: string,
  options: { upstreamOutput: Record<string, unknown>; feedFrom: string[] }
) {
  const now = new Date().toISOString();
  const upstreamRunId = `run_aw5p3_seed_${Math.random().toString(36).slice(2, 10)}`;
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
  const relayId = `team_aw5p3_seed_${Math.random().toString(36).slice(2, 10)}`;
  await db.insert(teamRuns).values({
    id: relayId,
    workspaceId,
    playbookKey: "aw5_p3_seeded",
    goal: "aw5 p3 seed probe",
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

function handoffEvents(traceLog: InMemoryTraceLog) {
  return traceLog.list().filter((event) => event.action.startsWith("team_handoff"));
}

describe("AW-5 片3: relay 交接事件（判据②）＋ carried 收口（判据④）", () => {
  it("② 正向：内置 sprint 接力发射 team_handoff_accepted（fromTask/toTask/fields 齐全且值正确）", async () => {
    const { db, service, traceLog } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P3 Event", plan: "business" }, "founder");

    const launched = (await service.launchTeam({
      workspaceId: ws.id,
      playbookKey: "sprint",
      goal: "aw5 p3 handoff event"
    })) as { teamRunId: string };

    const relayRow = (
      await db.select().from(teamRuns).where(eq(teamRuns.id, launched.teamRunId))
    )[0];
    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    expect(runIds).toHaveLength(2); // 第一棒 completed → 第二棒已创建

    const events = handoffEvents(traceLog).filter(
      (event) => event.action === "team_handoff_accepted"
    );
    expect(events).toHaveLength(1);
    const metadata = events[0].metadata ?? {};
    expect(metadata.fromTask).toBe(runIds[0]);
    expect(metadata.toTask).toBe("step_1_private_conversion");
    expect(JSON.parse(metadata.fields ?? "null")).toEqual([
      "channelRecommendations",
      "contentAngles"
    ]);
    expect(metadata.downstreamRunId).toBe(runIds[1]);

    // ④ 替代路径：下游 run 结构化承接（非字符串拼接）
    const step2 = await service.getRun(runIds[1]);
    const step2Input = step2.input as Record<string, unknown>;
    expect(step2Input.businessSummary).toBe("aw5 p3 handoff event");
    expect(step2Input.handoffPayload).toEqual({
      channelRecommendations: expect.any(Array),
      contentAngles: expect.any(Array)
    });

    await service.shutdown();
  });

  it("④ 替代路径：种子 relay 恢复推进后下游结构化承接，businessSummary 不含 carried 文本", async () => {
    const { db, service, traceLog } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P3 Struct", plan: "business" }, "founder");
    const { relayId, upstreamRunId } = await seedRelay(db, ws.id, {
      upstreamOutput: { contentAngles: ["a1", "a2"] },
      feedFrom: ["contentAngles"]
    });

    await service.updateRelayRunStatus(relayId, "running");

    const relayRow = (await db.select().from(teamRuns).where(eq(teamRuns.id, relayId)))[0];
    const runIds = JSON.parse(relayRow.runIdsJson) as string[];
    expect(runIds).toEqual([upstreamRunId, expect.any(String)]);
    const downstream = await service.getRun(runIds[1]);
    const input = downstream.input as Record<string, unknown>;
    expect(input.handoffPayload).toEqual({ contentAngles: ["a1", "a2"] });
    // 旧字符串拼接场景（carried 文本并入 businessSummary）已被替代
    expect(input.businessSummary).toBe("aw5 p3 seed probe");
    expect(String(input.businessSummary)).not.toContain("a1");

    const events = handoffEvents(traceLog).filter(
      (event) => event.action === "team_handoff_accepted"
    );
    expect(events).toHaveLength(1);
    expect(events[0].metadata?.fromTask).toBe(upstreamRunId);
    expect(events[0].metadata?.toTask).toBe("step_1_private_conversion");
    expect(JSON.parse(events[0].metadata?.fields ?? "null")).toEqual(["contentAngles"]);

    await service.shutdown();
  });

  it("② 负向对照：拒绝路径发 team_handoff_rejected（fromTask/toTask 在案、无 accepted）", async () => {
    const { db, service, traceLog } = await setupService();
    const ws = await service.createWorkspace({ name: "AW5 P3 Reject", plan: "business" }, "founder");
    const { relayId, upstreamRunId } = await seedRelay(db, ws.id, {
      upstreamOutput: { rogueField: "pollution" },
      feedFrom: ["rogueField"]
    });

    await expect(service.updateRelayRunStatus(relayId, "running")).rejects.toThrow(
      /UNDECLARED_FIELD\(rogueField\)/
    );

    const events = handoffEvents(traceLog);
    const rejected = events.find((event) => event.action === "team_handoff_rejected");
    expect(rejected).toBeDefined();
    expect(rejected?.metadata?.fromTask).toBe(upstreamRunId);
    expect(rejected?.metadata?.toTask).toBe("step_1_private_conversion");
    expect(events.some((event) => event.action === "team_handoff_accepted")).toBe(false);

    await service.shutdown();
  });
});
