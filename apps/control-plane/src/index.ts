import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  workspaces,
  runs,
  approvalRequests,
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
  type WorkspacePlan
} from "@neuroclaw/shared";
import { listTemplates } from "@neuroclaw/templates";
import { TemporalWorkerSkeleton } from "@neuroclaw/temporal-worker";

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

export class ControlPlaneService {
  readonly db: Database;
  private readonly memoryStore: MemoryStore;
  private readonly traceLog: TraceLog;
  private readonly temporalWorker: TemporalWorkerSkeleton;

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
    const worker = temporalWorker ?? new TemporalWorkerSkeleton(database);
    return new ControlPlaneService(worker, database, memoryStore, traceLog);
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
    return listTemplates();
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
      const run: Run = {
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
