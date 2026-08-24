import { randomUUID } from "node:crypto";
import { eq, and, sql, lte } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  workspaces,
  runs,
  approvalRequests,
  agents,
  artifacts,
  knowledgeEntries,
  schedules,
  teamRuns,
  type Database
} from "@neuroclaw/db";
import {
  DrizzleMemoryStore,
  type MemoryRecord,
  type MemoryRecordType,
  type MemoryStore,
  type UpdateMemoryRecordInput
} from "@neuroclaw/memory";
import { getTraceLog, type TraceLog } from "@neuroclaw/observability";
import {
  applyApprovalDecision,
  assertRunInput,
  assertTemplateType,
  type ApprovalDecision,
  type ApprovalRequest,
  type Run,
  type RunStepResult,
  type Template,
  type TemplateInputPayload,
  type TemplateOutputPayload,
  type Workspace,
  type WorkspacePlan,
  type CreateAgentInput,
  type UpdateAgentInput,
  type SavePlaybookInput
} from "@neuroclaw/shared";
import {
  builtinRegistry,
  globalRegistry,
  listTemplates as listBuiltinTemplates
} from "@neuroclaw/templates";
import { TemporalWorkerSkeleton } from "@neuroclaw/temporal-worker";
import { generateStructuredForAgent } from "@neuroclaw/agent-core";
import { playbooks as playbooksTable } from "@neuroclaw/db";

export interface CreateWorkspaceInput {
  name: string;
  plan: WorkspacePlan;
}

export interface CreateRunInput {
  workspaceId: string;
  templateType: string;
  input: Record<string, unknown>;
}

export class NotFoundError extends Error {
  constructor(
    message: string,
    public readonly code = "NOT_FOUND"
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// DB row ↔ domain type mappers
// ---------------------------------------------------------------------------

type RunInsert = typeof runs.$inferInsert;

function runToInsert(run: Run): RunInsert {
  return {
    id: run.id,
    workspaceId: run.workspaceId,
    templateType: run.templateType,
    status: run.status,
    input: JSON.stringify(run.input),
    outputPayload: run.outputPayload ? JSON.stringify(run.outputPayload) : null,
    failureReason: run.failureReason ?? null,
    currentStep: run.currentStep,
    approvalStatus: run.approvalStatus,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
    stepResults: run.stepResults ? JSON.stringify(run.stepResults) : null
  };
}

type RunSelect = typeof runs.$inferSelect;

function rowToRun(row: RunSelect): Run {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    templateType: row.templateType as Run["templateType"],
    status: row.status as Run["status"],
    input: JSON.parse(row.input) as TemplateInputPayload,
    outputPayload: row.outputPayload
      ? (JSON.parse(row.outputPayload) as TemplateOutputPayload)
      : undefined,
    failureReason: row.failureReason ?? undefined,
    currentStep: row.currentStep,
    approvalStatus: row.approvalStatus as Run["approvalStatus"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    startedAt: row.startedAt ?? undefined,
    completedAt: row.completedAt ?? undefined,
    stepResults: row.stepResults
      ? (JSON.parse(row.stepResults) as RunStepResult[])
      : undefined
  };
}

// ---------------------------------------------------------------------------
// ControlPlaneService
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Team playbooks — server-side relay orchestration registry (J5)
// ---------------------------------------------------------------------------

export interface TeamStep {
  templateType: string;
  roleKey: string;
  feedFrom: string[];
}

export const TEAM_PLAYBOOKS: Record<string, TeamStep[]> = {
  sprint: [
    { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
    {
      templateType: "private_conversion",
      roleKey: "conversion",
      feedFrom: ["contentAngles", "channelRecommendations"]
    },
    { templateType: "weekly_review", roleKey: "review", feedFrom: ["conversionDraft"] }
  ],
  contentReview: [
    { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
    { templateType: "weekly_review", roleKey: "review", feedFrom: ["contentAngles"] }
  ]
};

function carriedSummary(payload: Record<string, unknown>, feedFrom: string[]): string {
  return feedFrom
    .map((field) => {
      const value = payload[field];
      if (Array.isArray(value)) return value.join("; ");
      return typeof value === "string" ? value : "";
    })
    .filter(Boolean)
    .join("\n");
}

export class ControlPlaneService {
  readonly db: Database;
  private readonly memoryStore: MemoryStore;
  private readonly traceLog: TraceLog;
  private readonly temporalWorker: TemporalWorkerSkeleton;
  /** 合并注册表:内置三员工 + 数据库自定义智能体(全局单例,RuntimeWorker 共享) */
  readonly registry = globalRegistry;

  private constructor(
    temporalWorker: TemporalWorkerSkeleton,
    db: Database,
    memoryStore?: MemoryStore,
    traceLog?: TraceLog
  ) {
    this.temporalWorker = temporalWorker;
    this.db = db;
    this.memoryStore = memoryStore ?? new DrizzleMemoryStore(db);
    this.traceLog = traceLog ?? getTraceLog();
  }

  static async create(
    temporalWorker?: TemporalWorkerSkeleton,
    db?: Database,
    memoryStore?: MemoryStore,
    traceLog?: TraceLog
  ): Promise<ControlPlaneService> {
    const database = db ?? await createInMemoryDb();

    // Load custom agents into the merged registry BEFORE the worker boots.
    const service = new ControlPlaneService(
      temporalWorker ?? new TemporalWorkerSkeleton(database),
      database,
      memoryStore,
      traceLog
    );
    await service.loadCustomAgents();
    return service;
  }

  /** 从 agents 表加载自定义智能体并注册进全局合并注册表 */
  async loadCustomAgents(): Promise<number> {
    const rows = await this.db.select().from(agents);
    for (const row of rows) {
      if (row.status === "inactive") continue;
      globalRegistry.register(this.agentRowToTemplate(row));
    }
    return rows.length;
  }

  private agentRowToTemplate(row: typeof agents.$inferSelect): Template {
    const base = builtinRegistry.get(row.baseEngine);
    let focusAreas: string[] = [];
    try {
      focusAreas = row.focusAreas ? (JSON.parse(row.focusAreas) as string[]) : [];
    } catch {
      focusAreas = [];
    }
    const description = [row.description ?? "", focusAreas.length ? `Focus: ${focusAreas.join(", ")}` : ""]
      .filter(Boolean)
      .join(" · ");

    return {
      ...(base ?? listBuiltinTemplates()[0]),
      id: `agt_${row.slug}`,
      type: row.slug,
      name: row.name,
      version: "1.0.0",
      status: row.status === "inactive" ? "inactive" : "active",
      description,
      persona: row.persona,
      baseEngine: row.baseEngine
    };
  }

  async createAgent(input: CreateAgentInput): Promise<Template> {
    const existing = await this.db.select().from(agents).where(eq(agents.slug, input.slug));
    if (existing.length > 0) {
      throw new Error(`Agent slug already exists: ${input.slug}`);
    }

    const row = {
      id: `agent_${randomUUID()}`,
      slug: input.slug,
      name: input.name,
      baseEngine: input.baseEngine,
      persona: input.persona,
      description: input.description ?? null,
      focusAreas: JSON.stringify(input.focusAreas ?? []),
      outputStyle: input.outputStyle ?? "structured",
      toolNames: JSON.stringify(input.toolNames ?? []),
      status: "active" as const,
      createdAt: new Date().toISOString()
    };

    await this.db.insert(agents).values(row);

    const template = this.agentRowToTemplate(row);
    globalRegistry.register(template);

    this.traceLog.record({
      scope: "control-plane",
      action: "create_agent",
      metadata: { slug: input.slug }
    });
    return template;
  }

  async listAgents() {
    const rows = await this.db.select().from(agents).orderBy(sql`rowid DESC`);
    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      baseEngine: row.baseEngine,
      persona: row.persona,
      description: row.description ?? "",
      outputStyle: row.outputStyle,
      status: row.status,
      createdAt: row.createdAt
    }));
  }

  async updateAgentStatus(agentId: string, status: "active" | "inactive"): Promise<void> {
    await this.updateAgent(agentId, { status });
  }

  /** J7:编辑定制智能体(名称/persona/描述/专长/状态),并同步注册表 */
  async updateAgent(agentId: string, patch: UpdateAgentInput): Promise<void> {
    const rows = await this.db.select().from(agents).where(eq(agents.id, agentId));
    if (rows.length === 0) {
      throw new NotFoundError(`Agent not found: ${agentId}`);
    }
    const row = rows[0];
    const next = {
      ...row,
      name: patch.name ?? row.name,
      persona: patch.persona ?? row.persona,
      description: patch.description ?? row.description,
      focusAreas: patch.focusAreas ? JSON.stringify(patch.focusAreas) : row.focusAreas,
      status: patch.status ?? (row.status as "active" | "inactive")
    };

    await this.db
      .update(agents)
      .set({
        name: next.name,
        persona: next.persona,
        description: next.description,
        focusAreas: next.focusAreas,
        status: next.status
      })
      .where(eq(agents.id, agentId));

    if (next.status === "inactive") {
      globalRegistry.unregister(row.slug);
    } else {
      globalRegistry.register(
        this.agentRowToTemplate({ ...next, description: next.description ?? null })
      );
    }
  }

  /**
   * Release all resources held by the service: stop the temporal worker,
   * close the database connection. Safe to call multiple times.
   */
  async shutdown(): Promise<void> {
    this.traceLog.record({
      scope: "control-plane",
      action: "shutdown"
    });
    await this.temporalWorker.shutdown();
    await closeDatabase(this.db);
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<Workspace> {
    const span = this.traceLog.startSpan("control-plane", "createWorkspace", {
      plan: input.plan
    });
    try {
      if (!input.name.trim()) {
        throw new Error("Workspace name is required");
      }

      const workspace: Workspace = {
        id: `ws_${randomUUID()}`,
        name: input.name,
        plan: input.plan,
        createdAt: new Date().toISOString()
      };

      await this.db.insert(workspaces).values({
        id: workspace.id,
        name: workspace.name,
        plan: workspace.plan,
        createdAt: workspace.createdAt
      });

      this.traceLog.record({
        scope: "control-plane",
        action: "create_workspace",
        metadata: {
          workspaceId: workspace.id
        }
      });

      span.setAttribute("workspaceId", workspace.id);
      return workspace;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  listTemplates(): Template[] {
    return this.registry.list();
  }

  async createRun(input: CreateRunInput): Promise<Run> {
    const span = this.traceLog.startSpan("control-plane", "createRun", {
      workspaceId: input.workspaceId,
      templateType: input.templateType
    });
    try {
      const workspaceRows = await this.db.select().from(workspaces)
        .where(eq(workspaces.id, input.workspaceId));

      if (workspaceRows.length === 0) {
        throw new NotFoundError(
          `Workspace not found: ${input.workspaceId}`,
          "WORKSPACE_NOT_FOUND"
        );
      }

      const templateType = assertTemplateType(input.templateType);
      const runInput = assertRunInput(input.input);
      const now = new Date().toISOString();
      let run: Run = {
        id: `run_${randomUUID()}`,
        workspaceId: input.workspaceId,
        templateType,
        status: "draft",
        input: runInput,
        currentStep: null,
        approvalStatus: "not_required",
        createdAt: now,
        updatedAt: now
      };
      run = await this.attachKnowledge(run);

      const result = await this.temporalWorker.submitQueuedRun(run);
      await this.db.insert(runs).values(runToInsert(result.run));

      if (result.approvalRequest) {
        await this.db.insert(approvalRequests).values({
          id: result.approvalRequest.id,
          runId: result.approvalRequest.runId,
          actionType: result.approvalRequest.actionType,
          reason: result.approvalRequest.reason,
          status: result.approvalRequest.status,
          requestedAt: result.approvalRequest.requestedAt,
          resolvedAt: result.approvalRequest.resolvedAt ?? null,
          resolution: result.approvalRequest.resolution ?? null
        });
      } else if (result.run.status === "completed" && result.run.outputPayload) {
        await this.recordCompletedRunMemory(
          result.run,
          `Completed ${result.run.templateType} with reusable output`,
          "successful_output"
        );
        await this.saveArtifact(result.run);
        await this.advanceTeamOnCompletion(result.run);
      }

      span.setAttribute("runId", result.run.id);
      span.setAttribute("run.status", result.run.status);
      return result.run;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  async getRun(runId: string): Promise<Run> {
    const rows = await this.db.select().from(runs)
      .where(eq(runs.id, runId));

    if (rows.length === 0) {
      throw new NotFoundError(`Run not found: ${runId}`);
    }

    return rowToRun(rows[0]);
  }

  async listApprovalRequests(runId?: string): Promise<ApprovalRequest[]> {
    const rows = runId
      ? await this.db.select().from(approvalRequests)
          .where(eq(approvalRequests.runId, runId))
      : await this.db.select().from(approvalRequests);

    return rows.map((row) => ({
      id: row.id,
      runId: row.runId,
      actionType: row.actionType as ApprovalRequest["actionType"],
      reason: row.reason,
      status: row.status as ApprovalRequest["status"],
      requestedAt: row.requestedAt,
      resolvedAt: row.resolvedAt ?? undefined,
      resolution: row.resolution ?? undefined
    }));
  }

  async listRunsByWorkspace(workspaceId: string): Promise<Array<Run & { outputSummary?: string }>> {
    await this.assertWorkspaceExists(workspaceId);

    const rows = await this.db.select().from(runs)
      .where(eq(runs.workspaceId, workspaceId))
      .orderBy(sql`rowid DESC`);

    return rows.map((row) => {
      const run = rowToRun(row);
      return {
        ...run,
        outputSummary: run.outputPayload
          ? Object.keys(run.outputPayload)
              .slice(0, 2)
              .join(", ")
          : undefined
      };
    });
  }

  async cloneRun(runId: string): Promise<{
    templateType: Run["templateType"];
    input: Run["input"];
    sourceRunId: string;
  }> {
    const run = await this.getRun(runId);
    return {
      templateType: run.templateType,
      input: { ...run.input },
      sourceRunId: run.id
    };
  }

  async updateApproval(runId: string, decision: ApprovalDecision): Promise<Run> {
    const span = this.traceLog.startSpan("control-plane", "updateApproval", {
      runId,
      approved: String(decision.approved)
    });
    try {
      const run = await this.getRun(runId);
      const requests = await this.listApprovalRequests(runId);
      const activeRequest = requests.find(
        (request) => request.status === "pending"
      );

      const reviewedRun = applyApprovalDecision(run, decision);
      await this.db.update(runs).set(runToInsert(reviewedRun)).where(eq(runs.id, runId));

      if (activeRequest) {
        const resolvedRequest: ApprovalRequest = {
          ...activeRequest,
          status: decision.approved ? "approved" : "rejected",
          resolvedAt: new Date().toISOString(),
          resolution: decision.note ?? (decision.approved ? "approved" : "rejected")
        };
        await this.db.update(approvalRequests).set({
          status: resolvedRequest.status,
          resolvedAt: resolvedRequest.resolvedAt ?? null,
          resolution: resolvedRequest.resolution ?? null
        }).where(eq(approvalRequests.id, activeRequest.id));
      }

      if (!decision.approved || !activeRequest) {
        span.setAttribute("result.status", reviewedRun.status);
        return reviewedRun;
      }

      const resumed = await this.temporalWorker.resumeApprovedRun(reviewedRun, [
        activeRequest.actionType
      ]);
      await this.db.update(runs).set(runToInsert(resumed.run)).where(eq(runs.id, runId));

      if (resumed.run.status === "completed" && resumed.run.outputPayload) {
        await this.recordCompletedRunMemory(
          resumed.run,
          `Completed ${resumed.run.templateType} after approval`,
          "successful_output"
        );
        await this.saveArtifact(resumed.run);
        await this.advanceTeamOnCompletion(resumed.run);
      }

      span.setAttribute("result.status", resumed.run.status);
      return resumed.run;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  async listWorkspaceMemory(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    return this.memoryStore.listByWorkspace(workspaceId);
  }

  async updateMemoryRecord(memoryId: string, input: UpdateMemoryRecordInput): Promise<MemoryRecord> {
    try {
      return await this.memoryStore.updateRecord(memoryId, input);
    } catch (error) {
      throw new NotFoundError(error instanceof Error ? error.message : "Memory record not found");
    }
  }

  async deleteMemoryRecord(memoryId: string): Promise<void> {
    try {
      await this.memoryStore.deleteRecord(memoryId);
    } catch (error) {
      throw new NotFoundError(error instanceof Error ? error.message : "Memory record not found");
    }
  }

  private async recordCompletedRunMemory(run: Run, summary: string, type: MemoryRecordType): Promise<void> {
    await this.memoryStore.addRecord({
      id: `mem_${randomUUID()}`,
      workspaceId: run.workspaceId,
      templateType: run.templateType,
      type,
      summary,
      sourceRunId: run.id,
      isPinned: false,
      isSuppressed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }

  // -------------------------------------------------------------------------
  // Artifacts library (J3) — completed runs deposit reusable deliverables
  // -------------------------------------------------------------------------

  async saveArtifact(run: Run): Promise<string> {
    const kind =
      run.templateType === "content_acquisition"
        ? "note"
        : run.templateType === "private_conversion"
          ? "copy"
          : run.templateType === "weekly_review"
            ? "report"
            : "generic";

    const payload = run.outputPayload ?? {};
    const firstString = Object.values(payload).find((value) => typeof value === "string") as
      | string
      | undefined;
    const firstList = Object.values(payload).find((value) => Array.isArray(value)) as
      | string[]
      | undefined;

    const title = (firstString ?? (firstList?.[0] ?? `${run.templateType} output`)).slice(0, 90);
    const summary = (firstList ?? []).slice(0, 3).join(" / ").slice(0, 160) || title.slice(0, 120);

    const id = `art_${randomUUID()}`;
    await this.db.insert(artifacts).values({
      id,
      workspaceId: run.workspaceId,
      runId: run.id,
      agentType: run.templateType,
      kind,
      title,
      summary,
      contentJson: JSON.stringify(payload),
      createdAt: new Date().toISOString()
    });

    await this.autoDepositKnowledge(run);
    return id;
  }

  /** J7:系统自动沉淀 — 完成运行的产出写入知识库(source='run',可溯源 run_id) */
  private async autoDepositKnowledge(run: Run): Promise<void> {
    const existing = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.runId, run.id));
    if (existing.length > 0) return; // 幂等

    const payload = run.outputPayload ?? {};
    const parts = Object.entries(payload).map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${value.join("; ")}`;
      return `${key}: ${String(value).slice(0, 300)}`;
    });
    if (parts.length === 0) return;

    const firstList = Object.values(payload).find((value) => Array.isArray(value)) as
      | string[]
      | undefined;
    const title = (firstList?.[0] ?? `${run.templateType} 成果`).slice(0, 80);

    await this.db.insert(knowledgeEntries).values({
      id: `kn_${randomUUID()}`,
      workspaceId: run.workspaceId,
      title: `🤖 ${title}`,
      content: parts.join("\n"),
      tags: JSON.stringify([run.templateType, "auto"]),
      source: "run",
      runId: run.id,
      createdAt: new Date().toISOString()
    });
  }

  /** J7:关键词检索(人工搜索与 AI 调用共用通路) */
  async searchKnowledge(workspaceId: string, query?: string) {
    const all = await this.listKnowledgeEntries(workspaceId);
    const q = query?.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.content.toLowerCase().includes(q) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }

  /** J7:AI 提炼 — 把近期条目蒸馏为一条「品牌速览」(source='ai');无 LLM 时规则拼接 */
  async refineKnowledgeWithAI(workspaceId: string) {
    const entries = await this.listKnowledgeEntries(workspaceId);
    const recent = entries.slice(0, 8);
    if (recent.length < 2) {
      throw new Error("Need at least 2 knowledge entries to refine");
    }

    let refinedTitle = "品牌速览";
    let refinedContent = "";
    let usedLLM = false;

    try {
      const result = await generateStructuredForAgent({
        persona:
          "You are a brand-knowledge curator. Merge the given knowledge fragments into one crisp brand brief.",
        instruction:
          "Merge these fragments into a single brief. Respond with fields: title (short), content (the merged brief), tags (array).",
        fields: [
          { name: "title", type: "string", required: true },
          { name: "content", type: "string", required: true },
          { name: "tags", type: "string[]", required: true }
        ],
        input: {
          fragments: recent.map((entry) => ({
            title: entry.title,
            content: entry.content.slice(0, 500)
          }))
        }
      });
      refinedTitle = String(result.title ?? refinedTitle).slice(0, 80);
      refinedContent = String(result.content ?? "");
      const tags = Array.isArray(result.tags) ? result.tags.map(String).slice(0, 5) : ["ai"];
      refinedContent += `\n[tags:${tags.join(",")}]`;
      usedLLM = true;
      void tags;
    } catch {
      // LLM 不可用 → 规则拼接
    }

    if (!usedLLM) {
      refinedContent = recent
        .map((entry) => `• ${entry.title}: ${entry.content.slice(0, 200)}`)
        .join("\n");
    }

    const tags = usedLLM ? ["ai"] : ["ai", "merged"];
    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId,
      title: `✨ ${refinedTitle}`,
      content: refinedContent,
      tags: JSON.stringify(tags),
      source: "ai",
      createdAt: new Date().toISOString()
    });

    return { id, usedLLM };
  }

  async listArtifacts(workspaceId: string) {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.workspaceId, workspaceId))
      .orderBy(sql`rowid DESC`);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      runId: row.runId,
      agentType: row.agentType,
      kind: row.kind,
      title: row.title,
      summary: row.summary ?? "",
      payload: JSON.parse(row.contentJson) as Record<string, unknown>,
      createdAt: row.createdAt
    }));
  }

  async deleteArtifact(artifactId: string): Promise<void> {
    await this.db.delete(artifacts).where(eq(artifacts.id, artifactId));
  }

  // -------------------------------------------------------------------------
  // Knowledge base (J3) — brand facts injected into agent prompts
  // -------------------------------------------------------------------------

  async createKnowledgeEntry(input: {
    workspaceId: string;
    title: string;
    content: string;
    tags?: string[];
  }) {
    const id = `kn_${randomUUID()}`;
    await this.db.insert(knowledgeEntries).values({
      id,
      workspaceId: input.workspaceId,
      title: input.title,
      content: input.content,
      tags: JSON.stringify(input.tags ?? []),
      source: "manual",
      createdAt: new Date().toISOString()
    });
    return { id };
  }

  async listKnowledgeEntries(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(knowledgeEntries)
      .where(eq(knowledgeEntries.workspaceId, workspaceId))
      .orderBy(sql`rowid DESC`);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      title: row.title,
      content: row.content,
      tags: (() => {
        try {
          return row.tags ? (JSON.parse(row.tags) as string[]) : [];
        } catch {
          return [];
        }
      })(),
      source: row.source,
      runId: row.runId ?? undefined,
      createdAt: row.createdAt
    }));
  }

  async deleteKnowledgeEntry(entryId: string): Promise<void> {
    await this.db.delete(knowledgeEntries).where(eq(knowledgeEntries.id, entryId));
  }

  /** 运行创建时解析所选知识条目,注入 _knowledge 供 persona 提示词使用 */
  private async attachKnowledge(run: Run): Promise<Run> {
    const ids = (run.input as { _knowledgeIds?: unknown })._knowledgeIds;
    if (!Array.isArray(ids) || ids.length === 0) return run;
    const entries = await this.db.select().from(knowledgeEntries);
    const selected = entries.filter((entry) => ids.includes(entry.id));
    const input = { ...run.input };
    delete (input as { _knowledgeIds?: unknown })._knowledgeIds;
    input._knowledge = selected.map((entry) => ({ title: entry.title, content: entry.content }));
    return { ...run, input };
  }

  // -------------------------------------------------------------------------
  // Approval inbox (J4)
  // -------------------------------------------------------------------------

  async listPendingApprovals(workspaceId?: string) {
    const baseQuery = this.db
      .select({ approval: approvalRequests, run: runs })
      .from(approvalRequests)
      .innerJoin(runs, eq(approvalRequests.runId, runs.id));

    const rows = workspaceId
      ? await baseQuery
          .where(and(eq(approvalRequests.status, "pending"), eq(runs.workspaceId, workspaceId)))
          .orderBy(sql`approval_requests.rowid DESC`)
      : await baseQuery.where(eq(approvalRequests.status, "pending")).orderBy(sql`approval_requests.rowid DESC`);

    return rows.map(({ approval, run }) => ({
      approvalId: approval.id,
      actionType: approval.actionType,
      reason: approval.reason,
      requestedAt: approval.requestedAt,
      run: {
        id: run.id,
        workspaceId: run.workspaceId,
        templateType: run.templateType as Run["templateType"],
        status: run.status as Run["status"],
        businessSummary: (() => {
          try {
            const parsed = JSON.parse(run.input) as Record<string, unknown>;
            return String(parsed.businessSummary ?? "");
          } catch {
            return "";
          }
        })()
      }
    }));
  }

  // -------------------------------------------------------------------------
  // Schedules (J4) — recurring agent runs
  // -------------------------------------------------------------------------

  async createSchedule(input: {
    workspaceId: string;
    templateType: string;
    label: string;
    inputPayload: Record<string, unknown>;
    intervalMinutes: number;
  }) {
    const id = `sch_${randomUUID()}`;
    const now = Date.now();
    await this.db.insert(schedules).values({
      id,
      workspaceId: input.workspaceId,
      templateType: input.templateType,
      label: input.label,
      inputJson: JSON.stringify(input.inputPayload),
      intervalMinutes: Math.max(5, input.intervalMinutes),
      nextRunAt: new Date(now + Math.max(5, input.intervalMinutes) * 60_000).toISOString(),
      status: "active",
      createdAt: new Date(now).toISOString()
    });
    return { id };
  }

  async listSchedules(workspaceId?: string) {
    const rows = workspaceId
      ? await this.db.select().from(schedules).where(eq(schedules.workspaceId, workspaceId)).orderBy(sql`rowid DESC`)
      : await this.db.select().from(schedules).orderBy(sql`rowid DESC`);
    return rows.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      templateType: row.templateType,
      label: row.label,
      intervalMinutes: row.intervalMinutes,
      nextRunAt: row.nextRunAt,
      lastRunId: row.lastRunId ?? undefined,
      lastStatus: row.lastStatus ?? undefined,
      status: row.status
    }));
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    await this.db.delete(schedules).where(eq(schedules.id, scheduleId));
  }

  /** 由 startServer 的定时器驱动:到期调度 → 创建运行 */
  async processDueSchedules(): Promise<number> {
    const now = new Date().toISOString();
    const due = await this.db
      .select()
      .from(schedules)
      .where(and(eq(schedules.status, "active"), lte(schedules.nextRunAt, now)));

    let launched = 0;
    for (const schedule of due) {
      try {
        const run = await this.createRun({
          workspaceId: schedule.workspaceId,
          templateType: schedule.templateType,
          input: JSON.parse(schedule.inputJson) as Record<string, unknown>
        });
        launched += 1;
        await this.db
          .update(schedules)
          .set({
            lastRunId: run.id,
            lastStatus: "ok",
            nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString()
          })
          .where(eq(schedules.id, schedule.id));
      } catch (scheduleError) {
        this.traceLog.record({
          scope: "control-plane",
          action: "schedule_failed",
          metadata: {
            scheduleId: schedule.id,
            error: scheduleError instanceof Error ? scheduleError.message : String(scheduleError)
          }
        });
        await this.db
          .update(schedules)
          .set({
            lastStatus: "failed",
            nextRunAt: new Date(Date.now() + schedule.intervalMinutes * 60_000).toISOString()
          })
          .where(eq(schedules.id, schedule.id));
      }
    }
    return launched;
  }

  // -------------------------------------------------------------------------
  // Playbooks (J7) — editable workflow definitions, DB overrides over defaults
  // -------------------------------------------------------------------------

  async getPlaybooks() {
    const defaults = Object.entries(TEAM_PLAYBOOKS).map(([key, steps]) => ({
      key,
      name: key === "sprint" ? "Opening Sprint" : key === "contentReview" ? "Content Weekly Loop" : key,
      steps,
      builtin: true
    }));

    const rows = await this.db.select().from(playbooksTable);
    const overrides = new Map(rows.map((row) => [row.key, row]));

    const merged = defaults.map((preset) => {
      const override = overrides.get(preset.key);
      if (!override) return preset;
      try {
        return {
          key: preset.key,
          name: override.name,
          steps: JSON.parse(override.stepsJson) as TeamStep[],
          builtin: false
        };
      } catch {
        return preset;
      }
    });

    for (const row of rows) {
      if (overrides.has(row.key)) continue;
      if (TEAM_PLAYBOOKS[row.key]) continue; // default already merged
      try {
        merged.push({
          key: row.key,
          name: row.name,
          steps: JSON.parse(row.stepsJson) as TeamStep[],
          builtin: false
        });
      } catch {
        // corrupt row — skip
      }
    }

    return merged;
  }

  async savePlaybook(key: string, input: SavePlaybookInput): Promise<void> {
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      throw new Error("Playbook key must be lowercase snake_case");
    }
    const now = new Date().toISOString();
    const isBuiltin = Boolean(TEAM_PLAYBOOKS[key]);
    await this.db
      .insert(playbooksTable)
      .values({
        key,
        name: input.name,
        stepsJson: JSON.stringify(input.steps),
        builtin: isBuiltin,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: playbooksTable.key,
        set: { name: input.name, stepsJson: JSON.stringify(input.steps), updatedAt: now }
      });
  }

  /** launchTeam 现读取生效版(默认 + 数据库覆盖/新增) */
  private async getEffectivePlaybook(key: string): Promise<TeamStep[] | null> {
    const rows = await this.db.select().from(playbooksTable).where(eq(playbooksTable.key, key));
    if (rows.length > 0) {
      try {
        return JSON.parse(rows[0].stepsJson) as TeamStep[];
      } catch {
        // fall through to defaults
      }
    }
    return TEAM_PLAYBOOKS[key] ?? null;
  }

  // -------------------------------------------------------------------------
  // Team relay orchestration (J5) — server-side, approval-aware
  // -------------------------------------------------------------------------

  async launchTeam(input: { workspaceId: string; playbookKey: string; goal: string; audience?: string }) {
    const steps = await this.getEffectivePlaybook(input.playbookKey);
    if (!steps) {
      throw new NotFoundError(`Unknown playbook: ${input.playbookKey}`);
    }

    const now = new Date().toISOString();
    const teamId = `team_${randomUUID()}`;
    await this.db.insert(teamRuns).values({
      id: teamId,
      workspaceId: input.workspaceId,
      playbookKey: input.playbookKey,
      goal: input.goal,
      audience: input.audience ?? "",
      status: "running",
      currentStep: 0,
      stepsJson: JSON.stringify(steps),
      runIdsJson: "[]",
      createdAt: now,
      updatedAt: now
    });

    const firstRun = await this.launchTeamStep(teamId);
    return { teamRunId: teamId, run: firstRun };
  }

  /** 创建指定步骤的运行;waiting_approval 会把团队置为 paused 状态 */
  private async launchTeamStep(teamId: string): Promise<Run> {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, teamId));
    const team = rows[0];
    if (!team) throw new NotFoundError(`Team run not found: ${teamId}`);

    const steps = JSON.parse(team.stepsJson) as TeamStep[];
    const stepIndex = team.currentStep;
    const step = steps[stepIndex];

    const runIds = (() => {
      try {
        return JSON.parse(team.runIdsJson) as string[];
      } catch {
        return [];
      }
    })();

    const carried =
      runIds.length > 0 && step.feedFrom.length > 0
        ? await this.getCarriedPayload(runIds[runIds.length - 1], step.feedFrom)
        : "";

    let run: Run;
    try {
      run = await this.createRun({
        workspaceId: team.workspaceId,
        templateType: step.templateType as never,
        input: {
          businessSummary: carried
            ? `${team.goal}\n[来自上一环节的输入]\n${carried}`
            : team.goal,
          targetCustomer: team.audience || "目标客群",
          preferredChannels: ["email"],
          ...(step.templateType === "content_acquisition"
            ? { contentGoal: "团队接力产出" }
            : step.templateType === "private_conversion"
              ? { offerAsset: "团队接力 offer" }
              : { metricsWindowDays: 7 })
        }
      });
    } catch (error) {
      await this.db
        .update(teamRuns)
        .set({ status: "failed", updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, teamId));
      throw error;
    }

    // createRun 已把完成态写入(含 artifact/记忆);若该步直接完成则继续推进
    if (run.status === "completed") {
      runIds.push(run.id);
      await this.advanceTeam(teamId, steps, runIds);
    } else {
      runIds.push(run.id);
      const status = run.status === "waiting_approval" ? "waiting_approval" : team.status;
      await this.db
        .update(teamRuns)
        .set({ runIdsJson: JSON.stringify(runIds), status, updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, teamId));
    }

    return run;
  }

  /** 完成钩子:命中最末位 run 的活跃团队自动推进下一棒 */
  async advanceTeamOnCompletion(completedRun: Run): Promise<void> {
    const activeTeams = await this.db
      .select()
      .from(teamRuns)
      .where(and(eq(teamRuns.workspaceId, completedRun.workspaceId), eq(teamRuns.status, "running")));

    for (const team of activeTeams) {
      let runIds: string[] = [];
      try {
        runIds = JSON.parse(team.runIdsJson) as string[];
      } catch {
        continue;
      }
      const last = runIds[runIds.length - 1];
      if (!last || last !== completedRun.id) continue;

      const steps = JSON.parse(team.stepsJson) as TeamStep[];
      await this.advanceTeam(team.id, steps, runIds);
    }
  }

  private async advanceTeam(
    teamId: string,
    steps: TeamStep[],
    runIds: string[]
  ): Promise<void> {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, teamId));
    const team = rows[0];
    if (!team || team.status === "failed") return;

    const nextIndex = team.currentStep + 1;

    if (nextIndex >= steps.length) {
      await this.db
        .update(teamRuns)
        .set({ status: "completed", currentStep: steps.length - 1, runIdsJson: JSON.stringify(runIds), updatedAt: new Date().toISOString() })
        .where(eq(teamRuns.id, teamId));
      return;
    }

    await this.db
      .update(teamRuns)
      .set({ currentStep: nextIndex, runIdsJson: JSON.stringify(runIds), updatedAt: new Date().toISOString() })
      .where(eq(teamRuns.id, teamId));

    await this.launchTeamStep(teamId);
  }

  private async getCarriedPayload(
    runId: string,
    feedFrom: string[]
  ): Promise<string> {
    const run = await this.getRun(runId);
    const payload = run.outputPayload ?? {};
    return carriedSummary(payload, feedFrom);
  }

  async getTeam(teamId: string) {
    const rows = await this.db.select().from(teamRuns).where(eq(teamRuns.id, teamId));
    const team = rows[0];
    if (!team) throw new NotFoundError(`Team run not found: ${teamId}`);

    let steps: TeamStep[] = [];
    let runIds: string[] = [];
    try {
      steps = JSON.parse(team.stepsJson) as TeamStep[];
    } catch {}
    try {
      runIds = JSON.parse(team.runIdsJson) as string[];
    } catch {}

    const runsById = new Map<string, Run>();
    for (const runId of runIds) {
      try {
        runsById.set(runId, await this.getRun(runId));
      } catch {
        // run row may be missing — skip
      }
    }

    return {
      id: team.id,
      workspaceId: team.workspaceId,
      playbookKey: team.playbookKey,
      goal: team.goal,
      audience: team.audience,
      status: team.status,
      currentStep: team.currentStep,
      steps: steps.map((step, index) => ({
        ...step,
        state:
          index < team.currentStep
            ? "done"
            : index === team.currentStep
              ? team.status === "completed"
                ? "done"
                : team.status
              : "pending",
        runId: runIds[index],
        outputSummary: (() => {
          const run = runIds[index] ? runsById.get(runIds[index]) : undefined;
          if (!run?.outputPayload) return undefined;
          const values = Object.values(run.outputPayload);
          const firstList = values.find((value) => Array.isArray(value)) as string[] | undefined;
          const firstString = values.find((value) => typeof value === "string") as string | undefined;
          return (firstList?.join(" / ") ?? firstString ?? "").slice(0, 120);
        })()
      }))
    };
  }

  async listTeams(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(teamRuns)
      .where(eq(teamRuns.workspaceId, workspaceId))
      .orderBy(sql`rowid DESC`);
    return rows.map((row) => ({
      id: row.id,
      playbookKey: row.playbookKey,
      goal: row.goal,
      status: row.status,
      currentStep: row.currentStep,
      createdAt: row.createdAt
    }));
  }

  // -------------------------------------------------------------------------
  // Run analytics (J6) — trends / success rate / per-agent breakdown
  // -------------------------------------------------------------------------

  async getAnalyticsOverview(workspaceId: string, days = 14) {
    await this.assertWorkspaceExists(workspaceId);
    const rows = await this.db
      .select()
      .from(runs)
      .where(eq(runs.workspaceId, workspaceId));

    const dayBuckets = new Map<string, { total: number; completed: number; failed: number }>();
    const today = new Date();
    const labels: Array<{ key: string; label: string }> = [];
    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const day = new Date(today.getTime() - offset * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      labels.push({ key, label: `${day.getMonth() + 1}/${day.getDate()}` });
      dayBuckets.set(key, { total: 0, completed: 0, failed: 0 });
    }

    let completedCount = 0;
    let failedCount = 0;
    let waitingCount = 0;
    let durationTotalMs = 0;
    let durationSamples = 0;
    const byAgent = new Map<string, number>();

    for (const row of rows) {
      const run = rowToRun(row);
      const dayKey = (run.createdAt ?? "").slice(0, 10);
      const bucket = dayBuckets.get(dayKey);

      if (bucket) {
        bucket.total += 1;
        if (run.status === "completed") bucket.completed += 1;
        if (run.status === "failed") bucket.failed += 1;
      }

      byAgent.set(run.templateType, (byAgent.get(run.templateType) ?? 0) + 1);

      if (run.status === "completed") {
        completedCount += 1;
        if (run.startedAt && run.completedAt) {
          const started = Date.parse(run.startedAt);
          const endedAt = Date.parse(run.completedAt);
          if (!Number.isNaN(started) && !Number.isNaN(endedAt) && endedAt >= started) {
            durationTotalMs += endedAt - started;
            durationSamples += 1;
          }
        }
      } else if (run.status === "failed") {
        failedCount += 1;
      } else if (run.status === "waiting_approval") {
        waitingCount += 1;
      }
    }

    const finished = completedCount + failedCount;
    const successRate = finished > 0 ? Math.round((completedCount / finished) * 100) : null;

    return {
      windowDays: days,
      series: labels.map(({ key, label }) => ({
        label,
        ...(dayBuckets.get(key) ?? { total: 0, completed: 0, failed: 0 })
      })),
      totals: {
        all: rows.length,
        completed: completedCount,
        failed: failedCount,
        waiting: waitingCount
      },
      successRate,
      avgDurationSec: durationSamples > 0 ? Math.round(durationTotalMs / durationSamples / 1000) : null,
      byAgent: [...byAgent.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
    };
  }

  private async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const rows = await this.db.select().from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    if (rows.length === 0) {
      throw new NotFoundError(
        `Workspace not found: ${workspaceId}`,
        "WORKSPACE_NOT_FOUND"
      );
    }
  }
}
