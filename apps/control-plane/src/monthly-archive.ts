/**
 * I-017 L0 读路径：按 workspace + period 聚合「月度档案中间模型」。
 *
 * 口径（GM 已裁，见 .artifacts/i017-format/options.md）：
 *   - Q1 = C：内部运营先行，产品化导出格式（A/B）与 L3 路由/序列化**不在本层**；
 *   - Q2 = 增长链降级口径：只读**已接线**的增长链产物
 *     （runs.input/outputPayload/stepResults/tokensUsed/costUsd/approvalStatus、
 *      approval_requests、audit_events、artifacts、memory_records，E3）；
 *     universal 口径（evidence_records/receipts 写接线，L2）**不在此实现**，
 *     v1.5 候选；
 *   - Q3 = 内部运营接口：workspace 边界 fail-closed（workspace 不存在即拒），
 *     非自助、非对客。
 *   - A4（GM 2026-09-27 裁决）：业务月界默认 +08（Asia/Shanghai，480 分钟），
 *     经 `periodBounds(period, tzOffsetMinutes)` 参数化，可显式覆盖（如 0 = UTC）。
 *
 * 本模块只做「读 + 汇总」，不冻结任何对客字段契约；`format_version`
 * / `archive_id` / `batches[]` / `client_name` / 对客渲染属 L3/L4。
 *
 * 已声明歧义（不在本层发明，回报 GM/后续线程）：
 *   1. 批次的批号规则（batch_no）——runs 无 batch 列，options §1.1 的
 *      `batch_no + run_ids[]` 需 L3 定义；本层只保证 runs 按 createdAt 升序
 *      的稳定锚（批次切分可依此派生）；
 *   2. 审批人（approver）——approval_requests 无 approver 列，audit_events
 *      的 actorId/资源关联规则未定；本层原样给出两个来源，不做推断；
 *   3. 草稿（drafts[]）——40 条草稿在 runs.outputPayload/content 内，本层
 *      原样保留 payload，抽取/校验状态归 L3。
 */
import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";

import {
  approvalRequests,
  artifacts,
  auditEvents,
  memoryRecords,
  runs,
  workItems,
  type Database
} from "@neuroclaw/db";

/** 档案期格式：YYYY-MM（严格校验，fail-closed）。 */
export const ARCHIVE_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertArchivePeriod(period: string): string {
  if (!ARCHIVE_PERIOD_PATTERN.test(period)) {
    throw new Error(`Invalid archive period (expected YYYY-MM): ${period}`);
  }
  return period;
}

/** 业务月界默认时区偏移（分钟）：+08:00（Asia/Shanghai），GM 2026-09-27 裁决（A4）。 */
export const DEFAULT_TZ_OFFSET_MINUTES = 480;

/** 现实时区范围 UTC-12:00..UTC+14:00（分钟，东为正）。 */
const TZ_OFFSET_MINUTES_MIN = -720;
const TZ_OFFSET_MINUTES_MAX = 840;

function assertTzOffsetMinutes(offsetMinutes: number): number {
  if (
    !Number.isInteger(offsetMinutes) ||
    offsetMinutes < TZ_OFFSET_MINUTES_MIN ||
    offsetMinutes > TZ_OFFSET_MINUTES_MAX
  ) {
    throw new Error(
      `Invalid tz offset minutes (expected integer ${TZ_OFFSET_MINUTES_MIN}..${TZ_OFFSET_MINUTES_MAX}): ${offsetMinutes}`
    );
  }
  return offsetMinutes;
}

/** 增长链四段记录的最小读投影（Q2 降级口径）。 */
export interface MonthlyArchiveRun {
  runId: string;
  templateType: string;
  status: string;
  approvalStatus: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  failureReason?: string;
  currentStep?: string;
  /** 四段·输入：runs.input（已解析；解析失败保留原始字符串）。 */
  input: unknown;
  /** 四段·生成：runs.outputPayload（已解析；解析失败保留原始字符串）。 */
  outputPayload: unknown;
  /** 降级标注来源：stepResults 中 status = "degraded" 的步骤摘要（D-5）。 */
  degraded: boolean;
  degradationSummaries: string[];
  tokensUsed?: number;
  costUsd?: number;
}

/** runs → work_items 兼容绑定（legacy_run_id 唯一索引；options §3 L2 桥）。 */
export interface MonthlyArchiveWorkItemBinding {
  legacyRunId: string;
  workItemId: string;
  projectId: string;
  initiativeId: string;
  packId: string;
  packVersion: string;
  workflowRef: string;
  workflowVersion: string;
  adapterRef: string;
  adapterVersion: string;
  /** L1（未做）落地前的增长链 receipt 回退位：receipt_json 原文是否在。 */
  hasReceipt: boolean;
  /** work_items.receipt_json 解析值（无则 null）。 */
  receipt: unknown;
}

/** 四段·审批：approval_requests（approver 归属见文件头歧义 #2）。 */
export interface MonthlyArchiveApproval {
  approvalId: string;
  runId: string;
  actionType: string;
  status: string;
  reason: string;
  requestedAt: string;
  resolvedAt?: string;
  resolution?: string;
}

/** 四段·产物（与生成段可同源分列）：artifacts。 */
export interface MonthlyArchiveArtifact {
  artifactId: string;
  runId: string;
  agentType: string;
  kind: string;
  title: string;
  summary?: string;
  createdAt: string;
  /** artifacts.content_json 解析值（解析失败保留原始字符串）。 */
  content: unknown;
}

/** memory 汇总（sourceRunId 回指本批 run）。 */
export interface MonthlyArchiveMemory {
  memoryId: string;
  sourceRunId: string;
  type: string;
  summary: string;
  isPinned: boolean;
  isSuppressed: boolean;
  visibility: string;
  createdAt: string;
}

/** audit 汇总（期间 + workspace 全量；关联规则未定，不做 runId 推断）。 */
export interface MonthlyArchiveAuditEvent {
  auditEventId: string;
  actorId?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  metadata: unknown;
  createdAt: string;
}

/** 单个 run 的四段可出示来源 + 绑定。 */
export interface MonthlyArchiveRunBundle {
  run: MonthlyArchiveRun;
  workItem: MonthlyArchiveWorkItemBinding | null;
  approvals: MonthlyArchiveApproval[];
  artifacts: MonthlyArchiveArtifact[];
  memory: MonthlyArchiveMemory[];
}

export interface MonthlyArchiveAggregate {
  workspaceId: string;
  period: string;
  generatedAt: string;
  /** 按 createdAt 升序（后接 id 升序）的稳定批次锚。 */
  runs: MonthlyArchiveRunBundle[];
  /** 期间内 workspace 的 audit 事件（不限于本批 run；见文件头歧义 #2）。 */
  auditEvents: MonthlyArchiveAuditEvent[];
  totals: {
    runs: number;
    degradedRuns: number;
    workItems: number;
    approvals: number;
    artifacts: number;
    memoryRecords: number;
    auditEvents: number;
  };
}

/**
 * 业务月界（左闭右开）：period 的本地 1 日 00:00（含）→ 次月 1 日 00:00（不含），
 * 按 `tzOffsetMinutes`（相对 UTC 的分钟偏移，东为正）换算为 ISO-8601 UTC 边界。
 *
 * 默认 +08（Asia/Shanghai，480 分钟；GM 2026-09-27 裁决 A4），可显式覆盖（0 = UTC）。
 * 例：period=2026-08 / offset=480 → [2026-07-31T16:00:00Z, 2026-08-31T16:00:00Z)。
 *
 * 注：物理列 created_at 为 TIMESTAMPTZ（migrations.ts BASELINE；schema.ts 自
 * I-043 方案 A 起同样声明 timestamp({ withTimezone: true, mode: "string" })）。
 * 历史踩点：`like` 前缀过滤在 PG 上无 `timestamptz ~~ text` 算子（42883），
 * 故此处采用边界比较。比较算子（>=/<）以 ISO 字符串传参可被 PG 解析为
 * timestamptz，既有先例见 index.ts `processDueSchedules` 的
 * `lte(schedules.nextRunAt, now)`。
 */
function periodBounds(
  period: string,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES
): { start: string; end: string } {
  assertTzOffsetMinutes(tzOffsetMinutes);
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const offsetMs = tzOffsetMinutes * 60_000;
  return {
    start: new Date(Date.UTC(year, month - 1, 1) - offsetMs).toISOString(),
    end: new Date(Date.UTC(year, month, 1) - offsetMs).toISOString()
  };
}

function parseJsonSafe(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * TIMESTAMPTZ 读回归一化为 ISO-8601 UTC 字符串。
 *
 * 读契约（packages/db/src/index.ts:87-94）：物理列 TIMESTAMPTZ，应用层始终为
 * ISO 字符串。node-postgres 由全局 parser 归一；PGlite 不做——按会话时区输出
 * PG 文本（实测 `2026-08-05 18:00:00+08`）。既有读取边界先例见
 * packages/db/src/checkpoints.ts:77（`new Date(...).toISOString()`）。
 */
function normalizeTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function compareByTimestampThenId<T>(
  a: T,
  b: T,
  timestampOf: (value: T) => string,
  idOf: (value: T) => string
): number {
  const aTime = timestampOf(a);
  const bTime = timestampOf(b);
  if (aTime !== bTime) return aTime < bTime ? -1 : 1;
  const aId = idOf(a);
  const bId = idOf(b);
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

/**
 * 聚合 workspace + period 的档案中间模型（纯读，无写入、无副作用）。
 *
 * 选择规则：
 *   - runs / audit_events：workspace_id = workspaceId 且 createdAt ∈
 *     业务月界（左闭右开；见 periodBounds，默认 +08、参数化可覆盖）；
 *   - approvals / artifacts / memory：以本批 runId 集合为界（inArray）；
 *   - 无 run 命中时仍返回期间 audit 汇总，其余为空数组（不报错）。
 *
 * `tzOffsetMinutes` 缺省 +08（480 分钟；GM 2026-09-27 裁决 A4），东为正。
 */
export async function buildMonthlyArchive(
  db: Database,
  workspaceId: string,
  period: string,
  tzOffsetMinutes: number = DEFAULT_TZ_OFFSET_MINUTES
): Promise<MonthlyArchiveAggregate> {
  assertArchivePeriod(period);
  const { start: periodStart, end: periodEnd } = periodBounds(period, tzOffsetMinutes);

  const runRows = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.workspaceId, workspaceId),
        gte(runs.createdAt, periodStart),
        lt(runs.createdAt, periodEnd)
      )
    )
    .orderBy(asc(runs.createdAt), asc(runs.id));

  const runIds = runRows.map((row) => row.id);

  const [workItemRows, approvalRows, artifactRows, memoryRows, auditRows] = await Promise.all([
    runIds.length > 0
      ? db.select().from(workItems).where(inArray(workItems.legacyRunId, runIds))
      : Promise.resolve([] as (typeof workItems.$inferSelect)[]),
    runIds.length > 0
      ? db.select().from(approvalRequests).where(inArray(approvalRequests.runId, runIds))
      : Promise.resolve([] as (typeof approvalRequests.$inferSelect)[]),
    runIds.length > 0
      ? db.select().from(artifacts).where(inArray(artifacts.runId, runIds))
      : Promise.resolve([] as (typeof artifacts.$inferSelect)[]),
    runIds.length > 0
      ? db.select().from(memoryRecords).where(inArray(memoryRecords.sourceRunId, runIds))
      : Promise.resolve([] as (typeof memoryRecords.$inferSelect)[]),
    db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.workspaceId, workspaceId),
          gte(auditEvents.createdAt, periodStart),
          lt(auditEvents.createdAt, periodEnd)
        )
      )
      .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id))
  ]);

  const workItemByRunId = new Map(workItemRows.map((row) => [row.legacyRunId, row]));
  const approvalsByRunId = new Map<string, MonthlyArchiveApproval[]>();
  for (const row of approvalRows) {
    const list = approvalsByRunId.get(row.runId) ?? [];
    list.push({
      approvalId: row.id,
      runId: row.runId,
      actionType: row.actionType,
      status: row.status,
      reason: row.reason,
      requestedAt: normalizeTimestamp(row.requestedAt),
      ...(row.resolvedAt ? { resolvedAt: normalizeTimestamp(row.resolvedAt) } : {}),
      ...(row.resolution ? { resolution: row.resolution } : {})
    });
    approvalsByRunId.set(row.runId, list);
  }
  const artifactsByRunId = new Map<string, MonthlyArchiveArtifact[]>();
  for (const row of artifactRows) {
    const list = artifactsByRunId.get(row.runId) ?? [];
    list.push({
      artifactId: row.id,
      runId: row.runId,
      agentType: row.agentType,
      kind: row.kind,
      title: row.title,
      ...(row.summary ? { summary: row.summary } : {}),
      createdAt: normalizeTimestamp(row.createdAt),
      content: parseJsonSafe(row.contentJson)
    });
    artifactsByRunId.set(row.runId, list);
  }
  const memoryByRunId = new Map<string, MonthlyArchiveMemory[]>();
  for (const row of memoryRows) {
    const list = memoryByRunId.get(row.sourceRunId) ?? [];
    list.push({
      memoryId: row.id,
      sourceRunId: row.sourceRunId,
      type: row.type,
      summary: row.summary,
      isPinned: row.isPinned,
      isSuppressed: row.isSuppressed,
      visibility: row.visibility,
      createdAt: normalizeTimestamp(row.createdAt)
    });
    memoryByRunId.set(row.sourceRunId, list);
  }

  const bundles: MonthlyArchiveRunBundle[] = runRows.map((row) => {
    const stepResults = parseJsonSafe(row.stepResults);
    const steps = Array.isArray(stepResults)
      ? (stepResults as Array<{ status?: string; summary?: string }>)
      : [];
    const degradationSummaries = steps
      .filter((step) => step.status === "degraded")
      .map((step) => step.summary ?? "");
    const workItemRow = workItemByRunId.get(row.id);
    return {
      run: {
        runId: row.id,
        templateType: row.templateType,
        status: row.status,
        approvalStatus: row.approvalStatus,
        createdAt: normalizeTimestamp(row.createdAt),
        updatedAt: normalizeTimestamp(row.updatedAt),
        ...(row.startedAt ? { startedAt: normalizeTimestamp(row.startedAt) } : {}),
        ...(row.completedAt ? { completedAt: normalizeTimestamp(row.completedAt) } : {}),
        ...(row.failureReason ? { failureReason: row.failureReason } : {}),
        ...(row.currentStep ? { currentStep: row.currentStep } : {}),
        input: parseJsonSafe(row.input),
        outputPayload: parseJsonSafe(row.outputPayload),
        degraded: degradationSummaries.length > 0,
        degradationSummaries,
        ...(row.tokensUsed !== null ? { tokensUsed: row.tokensUsed } : {}),
        ...(row.costUsd !== null ? { costUsd: row.costUsd } : {})
      },
      workItem: workItemRow
        ? {
            legacyRunId: workItemRow.legacyRunId,
            workItemId: workItemRow.id,
            projectId: workItemRow.projectId,
            initiativeId: workItemRow.initiativeId,
            packId: workItemRow.packId,
            packVersion: workItemRow.packVersion,
            workflowRef: workItemRow.workflowRef,
            workflowVersion: workItemRow.workflowVersion,
            adapterRef: workItemRow.adapterRef,
            adapterVersion: workItemRow.adapterVersion,
            hasReceipt: workItemRow.receiptJson !== null,
            receipt:
              workItemRow.receiptJson !== null ? parseJsonSafe(workItemRow.receiptJson) : null
          }
        : null,
      approvals: (approvalsByRunId.get(row.id) ?? []).sort((a, b) =>
        compareByTimestampThenId(a, b, (value) => value.requestedAt, (value) => value.approvalId)
      ),
      artifacts: (artifactsByRunId.get(row.id) ?? []).sort((a, b) =>
        compareByTimestampThenId(a, b, (value) => value.createdAt, (value) => value.artifactId)
      ),
      memory: (memoryByRunId.get(row.id) ?? []).sort((a, b) =>
        compareByTimestampThenId(a, b, (value) => value.createdAt, (value) => value.memoryId)
      )
    };
  });

  const auditList: MonthlyArchiveAuditEvent[] = auditRows.map((row) => ({
    auditEventId: row.id,
    ...(row.actorId ? { actorId: row.actorId } : {}),
    action: row.action,
    resourceType: row.resourceType,
    ...(row.resourceId ? { resourceId: row.resourceId } : {}),
    metadata: parseJsonSafe(row.metadata),
    createdAt: normalizeTimestamp(row.createdAt)
  }));

  return {
    workspaceId,
    period,
    generatedAt: new Date().toISOString(),
    runs: bundles,
    auditEvents: auditList,
    totals: {
      runs: bundles.length,
      degradedRuns: bundles.filter((bundle) => bundle.run.degraded).length,
      workItems: bundles.filter((bundle) => bundle.workItem !== null).length,
      approvals: approvalRows.length,
      artifacts: artifactRows.length,
      memoryRecords: memoryRows.length,
      auditEvents: auditList.length
    }
  };
}
