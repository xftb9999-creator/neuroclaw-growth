import { afterEach, describe, expect, it } from "vitest";

import {
  approvalRequests,
  artifacts,
  auditEvents,
  closeDatabase,
  createInMemoryDb,
  memoryRecords,
  runs,
  workItems,
  type Database
} from "@neuroclaw/db";
import { ControlPlaneService } from "./index.js";

/**
 * I-017 L0 directed test — 月度档案读路径（Q1=C 内部先行 / Q2=增长链降级口径 /
 * Q3=内部运营接口 + workspace 边界）。覆盖：
 *
 *   ① period（YYYY-MM）过滤 + workspace 边界：跨租户/跨月 run、audit 不泄漏；
 *   ② 四段来源齐备：input / outputPayload（含 stepResults 降级标注）/ approvals /
 *      artifacts / memory 按 runId 汇总，runs 按 createdAt 升序；
 *   ③ runs→work_items 绑定（legacy_run_id）与 receipt_json 原样透出；
 *   ④ fail-closed：未知 workspace → NotFoundError；非法 period → 拒绝；
 *      空月份返回空模型（不报错）；
 *   ⑤ 业务月界时区：默认 +08（Asia/Shanghai），参数化可显式覆盖（0 = UTC）。
 */

const AUGUST = "2026-08";
const SEPTEMBER = "2026-09";

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

interface SeedRunInput {
  id: string;
  workspaceId: string;
  createdAt: string;
  status?: string;
  approvalStatus?: string;
  input?: unknown;
  outputPayload?: unknown;
  stepResults?: unknown;
  tokensUsed?: number | null;
  costUsd?: number | null;
}

async function seedRun(db: Database, input: SeedRunInput): Promise<void> {
  await db.insert(runs).values({
    id: input.id,
    workspaceId: input.workspaceId,
    templateType: "content_acquisition",
    status: input.status ?? "completed",
    input: JSON.stringify(input.input ?? { businessSummary: "archive test" }),
    outputPayload:
      input.outputPayload === undefined ? null : JSON.stringify(input.outputPayload),
    failureReason: null,
    currentStep: null,
    approvalStatus: input.approvalStatus ?? "not_required",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    startedAt: null,
    completedAt: input.status === "completed" ? input.createdAt : null,
    stepResults: input.stepResults === undefined ? null : JSON.stringify(input.stepResults),
    tokensUsed: input.tokensUsed ?? null,
    costUsd: input.costUsd ?? null,
    teamId: null,
    relayId: null
  });
}

async function seedWorkItem(
  db: Database,
  legacyRunId: string,
  receipt: unknown
): Promise<void> {
  await db.insert(workItems).values({
    id: `wi_${legacyRunId}`,
    legacyRunId,
    projectId: "prj_archive",
    initiativeId: "initiative_archive",
    assigneeRef: "operator_archive",
    organizationId: "org_archive",
    workspaceId: null,
    scopeProjectId: "prj_archive",
    packId: "pack_growth",
    packVersion: "1.0.0",
    workflowRef: "workflow_growth_content_acquisition",
    workflowVersion: "1.0.0",
    adapterRef: "adapter_growth_content_acquisition",
    adapterVersion: "1.0.0",
    packSnapshotRef: "pack_snapshot",
    workflowSnapshotRef: "workflow_snapshot",
    adapterSnapshotRef: "adapter_snapshot",
    inputSnapshotRef: "input_snapshot",
    policySnapshotRef: "policy_snapshot",
    workItemJson: JSON.stringify({ id: `wi_${legacyRunId}` }),
    runJson: JSON.stringify({ id: legacyRunId }),
    receiptJson: receipt === undefined ? null : JSON.stringify(receipt),
    createdAt: "2026-08-05T09:30:00.000Z",
    updatedAt: "2026-08-05T09:30:00.000Z"
  });
}

describe("I-017 L0 monthly archive read path", () => {
  it("filters by workspace + period, keeps createdAt order, and counts totals", async () => {
    const { db, service } = await setup();
    const wsA = await service.createWorkspace({ name: "Archive A", plan: "growth" });
    const wsB = await service.createWorkspace({ name: "Archive B", plan: "growth" });

    await seedRun(db, {
      id: "run_a_aug_1",
      workspaceId: wsA.id,
      createdAt: "2026-08-05T09:00:00.000Z",
      outputPayload: { drafts: [{ draftId: "d1", content: "hello" }] },
      tokensUsed: 120,
      costUsd: 0.5
    });
    await seedRun(db, {
      id: "run_a_aug_2",
      workspaceId: wsA.id,
      createdAt: "2026-08-20T09:00:00.000Z",
      status: "waiting_approval",
      approvalStatus: "pending",
      stepResults: [
        {
          stepId: "step_1",
          actionType: "mcp_generate_brief",
          status: "degraded",
          summary: "no model credential — degraded mock output"
        },
        {
          stepId: "step_2",
          actionType: "mcp_generate_brief",
          status: "completed",
          summary: "ok"
        }
      ]
    });
    await seedRun(db, {
      id: "run_a_sep_1",
      workspaceId: wsA.id,
      createdAt: "2026-09-02T09:00:00.000Z"
    });
    await seedRun(db, {
      id: "run_b_aug_1",
      workspaceId: wsB.id,
      createdAt: "2026-08-11T09:00:00.000Z"
    });

    await db.insert(auditEvents).values({
      id: "audit_a_aug",
      workspaceId: wsA.id,
      actorId: "operator_archive",
      action: "run.create",
      resourceType: "run",
      resourceId: "run_a_aug_1",
      metadata: JSON.stringify({ method: "POST", path: "/api/runs" }),
      createdAt: "2026-08-05T09:01:00.000Z"
    });
    await db.insert(auditEvents).values({
      id: "audit_a_sep",
      workspaceId: wsA.id,
      actorId: "operator_archive",
      action: "run.create",
      resourceType: "run",
      resourceId: "run_a_sep_1",
      metadata: null,
      createdAt: "2026-09-02T09:01:00.000Z"
    });
    await db.insert(auditEvents).values({
      id: "audit_b_aug",
      workspaceId: wsB.id,
      actorId: "operator_b",
      action: "run.create",
      resourceType: "run",
      resourceId: "run_b_aug_1",
      metadata: null,
      createdAt: "2026-08-11T09:01:00.000Z"
    });

    const aggregate = await service.aggregateMonthlyArchive(wsA.id, AUGUST);

    expect(aggregate.workspaceId).toBe(wsA.id);
    expect(aggregate.period).toBe(AUGUST);
    expect(aggregate.runs.map((bundle) => bundle.run.runId)).toEqual([
      "run_a_aug_1",
      "run_a_aug_2"
    ]);
    expect(aggregate.runs[0].run.outputPayload).toEqual({
      drafts: [{ draftId: "d1", content: "hello" }]
    });
    expect(aggregate.runs[0].run.tokensUsed).toBe(120);
    expect(aggregate.runs[0].run.costUsd).toBe(0.5);
    expect(aggregate.runs[1].run.degraded).toBe(true);
    expect(aggregate.runs[1].run.degradationSummaries).toEqual([
      "no model credential — degraded mock output"
    ]);
    expect(aggregate.totals).toEqual({
      runs: 2,
      degradedRuns: 1,
      workItems: 0,
      approvals: 0,
      artifacts: 0,
      memoryRecords: 0,
      auditEvents: 1
    });
    expect(aggregate.auditEvents.map((event) => event.auditEventId)).toEqual([
      "audit_a_aug"
    ]);
    expect(aggregate.auditEvents[0].metadata).toEqual({
      method: "POST",
      path: "/api/runs"
    });
  });

  it("bundles the four-segment sources and the runs→work_items binding per run", async () => {
    const { db, service } = await setup();
    const ws = await service.createWorkspace({ name: "Archive C", plan: "growth" });

    await seedRun(db, {
      id: "run_c_1",
      workspaceId: ws.id,
      createdAt: "2026-08-05T09:00:00.000Z",
      approvalStatus: "approved",
      input: { businessSummary: "client c" }
    });
    await seedRun(db, {
      id: "run_c_2",
      workspaceId: ws.id,
      createdAt: "2026-08-20T09:00:00.000Z",
      status: "waiting_approval",
      approvalStatus: "pending"
    });
    await seedWorkItem(db, "run_c_1", { receiptId: "receipt_c_1", approved: true });

    await db.insert(approvalRequests).values({
      id: "approval_c_1",
      runId: "run_c_1",
      actionType: "publish",
      reason: "needs review",
      status: "approved",
      requestedAt: "2026-08-05T10:00:00.000Z",
      resolvedAt: "2026-08-05T11:00:00.000Z",
      resolution: "approved"
    });
    await db.insert(approvalRequests).values({
      id: "approval_c_2",
      runId: "run_c_2",
      actionType: "publish",
      reason: "needs review",
      status: "pending",
      requestedAt: "2026-08-20T10:00:00.000Z",
      resolvedAt: null,
      resolution: null
    });
    await db.insert(artifacts).values({
      id: "art_c_1",
      workspaceId: ws.id,
      runId: "run_c_1",
      agentType: "content_acquisition",
      kind: "note",
      title: "Draft set",
      summary: "10 drafts",
      contentJson: JSON.stringify({ drafts: [{ draftId: "d1" }] }),
      createdAt: "2026-08-05T09:10:00.000Z"
    });
    await db.insert(memoryRecords).values({
      id: "mem_c_1",
      workspaceId: ws.id,
      templateType: "content_acquisition",
      type: "insight",
      summary: "client prefers direct tone",
      sourceRunId: "run_c_1",
      isPinned: false,
      isSuppressed: false,
      createdAt: "2026-08-05T09:20:00.000Z",
      updatedAt: "2026-08-05T09:20:00.000Z",
      visibility: "private"
    });

    const aggregate = await service.aggregateMonthlyArchive(ws.id, AUGUST);

    const first = aggregate.runs[0];
    expect(first.run.input).toEqual({ businessSummary: "client c" });
    expect(first.workItem).toMatchObject({
      legacyRunId: "run_c_1",
      workItemId: "wi_run_c_1",
      workflowRef: "workflow_growth_content_acquisition",
      hasReceipt: true
    });
    expect(first.workItem?.receipt).toEqual({ receiptId: "receipt_c_1", approved: true });
    expect(first.approvals).toEqual([
      {
        approvalId: "approval_c_1",
        runId: "run_c_1",
        actionType: "publish",
        status: "approved",
        reason: "needs review",
        requestedAt: "2026-08-05T10:00:00.000Z",
        resolvedAt: "2026-08-05T11:00:00.000Z",
        resolution: "approved"
      }
    ]);
    expect(first.artifacts).toEqual([
      {
        artifactId: "art_c_1",
        runId: "run_c_1",
        agentType: "content_acquisition",
        kind: "note",
        title: "Draft set",
        summary: "10 drafts",
        createdAt: "2026-08-05T09:10:00.000Z",
        content: { drafts: [{ draftId: "d1" }] }
      }
    ]);
    expect(first.memory).toEqual([
      {
        memoryId: "mem_c_1",
        sourceRunId: "run_c_1",
        type: "insight",
        summary: "client prefers direct tone",
        isPinned: false,
        isSuppressed: false,
        visibility: "private",
        createdAt: "2026-08-05T09:20:00.000Z"
      }
    ]);
    expect(first.run.degraded).toBe(false);

    const second = aggregate.runs[1];
    expect(second.workItem).toBeNull();
    expect(second.approvals.map((approval) => approval.approvalId)).toEqual([
      "approval_c_2"
    ]);
    expect(aggregate.totals).toEqual({
      runs: 2,
      degradedRuns: 0,
      workItems: 1,
      approvals: 2,
      artifacts: 1,
      memoryRecords: 1,
      auditEvents: 0
    });
  });

  it("defaults to the +08 business month boundary and honors an explicit tz offset", async () => {
    const { db, service } = await setup();
    const ws = await service.createWorkspace({ name: "Archive TZ", plan: "growth" });

    // +08 月界：2026-08 = [2026-07-31T16:00:00Z, 2026-08-31T16:00:00Z)
    await seedRun(db, {
      id: "run_tz_aug_start",
      workspaceId: ws.id,
      createdAt: "2026-07-31T16:00:00.000Z" // = 2026-08-01 00:00 +08（左闭，含）
    });
    await seedRun(db, {
      id: "run_tz_jul_end",
      workspaceId: ws.id,
      createdAt: "2026-07-31T15:59:59.999Z" // = 2026-07-31 23:59 +08（属 7 月）
    });
    await seedRun(db, {
      id: "run_tz_sep_start",
      workspaceId: ws.id,
      createdAt: "2026-08-31T16:00:00.000Z" // = 2026-09-01 00:00 +08（右开，属 9 月）
    });
    await db.insert(auditEvents).values({
      id: "audit_tz_aug_start",
      workspaceId: ws.id,
      actorId: "operator_tz",
      action: "run.create",
      resourceType: "run",
      resourceId: "run_tz_aug_start",
      metadata: null,
      createdAt: "2026-07-31T16:00:00.000Z"
    });

    const augustCst = await service.aggregateMonthlyArchive(ws.id, AUGUST);
    expect(augustCst.runs.map((bundle) => bundle.run.runId)).toEqual(["run_tz_aug_start"]);
    expect(augustCst.auditEvents.map((event) => event.auditEventId)).toEqual([
      "audit_tz_aug_start"
    ]);

    const septemberCst = await service.aggregateMonthlyArchive(ws.id, SEPTEMBER);
    expect(septemberCst.runs.map((bundle) => bundle.run.runId)).toEqual(["run_tz_sep_start"]);

    // 显式覆盖为 UTC（0）：同一批数据在 UTC 月界下 2026-08 = [08-01T00:00Z, 09-01T00:00Z)
    const augustUtc = await service.aggregateMonthlyArchive(ws.id, AUGUST, 0);
    expect(augustUtc.runs.map((bundle) => bundle.run.runId)).toEqual(["run_tz_sep_start"]);
    expect(augustUtc.auditEvents).toEqual([]);

    const septemberUtc = await service.aggregateMonthlyArchive(ws.id, SEPTEMBER, 0);
    expect(septemberUtc.runs).toEqual([]);

    await expect(
      service.aggregateMonthlyArchive(ws.id, AUGUST, 90.5)
    ).rejects.toThrow(/Invalid tz offset minutes/);
  });

  it("fails closed on unknown workspace / invalid period and returns an empty month", async () => {
    const { service } = await setup();
    const ws = await service.createWorkspace({ name: "Archive D", plan: "growth" });

    await expect(
      service.aggregateMonthlyArchive("ws_missing", AUGUST)
    ).rejects.toMatchObject({ code: "WORKSPACE_NOT_FOUND" });
    await expect(
      service.aggregateMonthlyArchive(ws.id, "2026-13")
    ).rejects.toThrow(/Invalid archive period/);
    await expect(
      service.aggregateMonthlyArchive(ws.id, "2026-8")
    ).rejects.toThrow(/Invalid archive period/);

    const empty = await service.aggregateMonthlyArchive(ws.id, SEPTEMBER);
    expect(empty.runs).toEqual([]);
    expect(empty.auditEvents).toEqual([]);
    expect(empty.totals.runs).toBe(0);
    expect(empty.totals.auditEvents).toBe(0);
  });
});
