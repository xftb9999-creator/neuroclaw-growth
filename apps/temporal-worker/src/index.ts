import { randomUUID } from "node:crypto";
import { eq, and, lte, asc, sql } from "drizzle-orm";

import { getTraceLog, type TraceLog } from "@neuroclaw/observability";
import { RuntimeWorker, type RuntimeExecutionResult } from "@neuroclaw/runtime-worker";
import {
  type AdapterActionType,
  type Run,
  transitionRun
} from "@neuroclaw/shared";
import { type Database, jobs, jobAttempts } from "@neuroclaw/db";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobType = "execute_run" | "resume_approved_run";
export type JobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "retry_scheduled";

export interface LifecycleCheckpoint {
  runId: string;
  stage: "queued" | "runtime" | "waiting_approval" | "completed" | "failed";
  createdAt: string;
}

export interface EnqueueOptions {
  maxAttempts?: number;
  payload?: { approvedActions?: AdapterActionType[] };
}

export interface ProcessResult {
  jobId: string;
  runId: string;
  status: JobStatus;
  result?: RuntimeExecutionResult;
  error?: string;
}

// ---------------------------------------------------------------------------
// DurableJobQueue — database-backed job queue with claim/process/retry
// ---------------------------------------------------------------------------

export class DurableJobQueue {
  private readonly checkpoints: LifecycleCheckpoint[] = [];
  private readonly traceLog: TraceLog;

  constructor(
    private readonly db: Database,
    private readonly runtimeWorker = new RuntimeWorker(),
    traceLog?: TraceLog
  ) {
    this.traceLog = traceLog ?? getTraceLog();
  }

  async enqueue(run: Run, type: JobType = "execute_run", options: EnqueueOptions = {}): Promise<string> {
    const span = this.traceLog.startSpan("durable-job-queue", "enqueue", {
      runId: run.id,
      type
    });
    try {
      const jobId = `job_${randomUUID()}`;
      const now = new Date().toISOString();

      await this.db.insert(jobs).values({
        id: jobId,
        runId: run.id,
        type,
        status: "pending",
        payload: options.payload ? JSON.stringify(options.payload) : null,
        maxAttempts: options.maxAttempts ?? 3,
        attemptCount: 0,
        nextAttemptAt: now,
        createdAt: now,
        updatedAt: now
      });

      this.recordCheckpoint(run.id, "queued");
      this.traceLog.record({
        scope: "durable-job-queue",
        action: "enqueue",
        metadata: { jobId, runId: run.id, type }
      });

      span.setAttribute("jobId", jobId);
      return jobId;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  async claimNext(): Promise<{ jobId: string; runId: string; type: JobType; payload?: { approvedActions?: AdapterActionType[] } } | null> {
    const now = new Date().toISOString();

    // Atomically claim the next available job
    const candidates = await this.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.status, "pending"),
          lte(jobs.nextAttemptAt, now)
        )
      )
      .orderBy(asc(jobs.createdAt))
      .limit(1);

    if (candidates.length === 0) return null;

    const candidate = candidates[0];

    // Atomic claim: update status to 'claimed' only if still 'pending'
    const updated = await this.db
      .update(jobs)
      .set({
        status: "claimed",
        claimedAt: now,
        updatedAt: now
      })
      .where(
        and(
          eq(jobs.id, candidate.id),
          eq(jobs.status, "pending")
        )
      )
      .returning();

    if (updated.length === 0) {
      // Another worker claimed it first
      return null;
    }

    const job = updated[0];
    let payload: { approvedActions?: AdapterActionType[] } | undefined;
    if (job.payload) {
      try {
        payload = JSON.parse(job.payload);
      } catch {
        // invalid payload, ignore
      }
    }

    return {
      jobId: job.id,
      runId: job.runId,
      type: job.type as JobType,
      payload
    };
  }

  async processClaimed(
    claimed: { jobId: string; runId: string; type: JobType; payload?: { approvedActions?: AdapterActionType[] } },
    run: Run
  ): Promise<ProcessResult> {
    const span = this.traceLog.startSpan("durable-job-queue", "processClaimed", {
      jobId: claimed.jobId,
      runId: claimed.runId,
      type: claimed.type
    });
    try {
      const result = await this.processClaimedInner(claimed, run);
      span.setAttribute("result.status", result.status);
      return result;
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async processClaimedInner(
    claimed: { jobId: string; runId: string; type: JobType; payload?: { approvedActions?: AdapterActionType[] } },
    run: Run
  ): Promise<ProcessResult> {
    const now = new Date().toISOString();
    const attemptNumber = await this.incrementAttemptCount(claimed.jobId, now);

    // Record attempt start
    const attemptId = `att_${randomUUID()}`;
    await this.db.insert(jobAttempts).values({
      id: attemptId,
      jobId: claimed.jobId,
      attemptNumber,
      status: "started",
      startedAt: now
    });

    // Mark job as running
    await this.db
      .update(jobs)
      .set({ status: "running", updatedAt: now })
      .where(eq(jobs.id, claimed.jobId));

    try {
      const result =
        claimed.type === "resume_approved_run" && claimed.payload?.approvedActions
          ? await this.runtimeWorker.resumeApprovedRun(run, claimed.payload.approvedActions)
          : await this.runtimeWorker.acceptRun(run);

      const completedAt = new Date().toISOString();

      // Record successful attempt
      await this.db
        .update(jobAttempts)
        .set({ status: "completed", completedAt })
        .where(eq(jobAttempts.id, attemptId));

      // Mark job as completed
      await this.db
        .update(jobs)
        .set({
          status: "completed",
          updatedAt: completedAt,
          completedAt
        })
        .where(eq(jobs.id, claimed.jobId));

      this.recordCheckpoint(
        result.run.id,
        result.run.status === "waiting_approval"
          ? "waiting_approval"
          : result.run.status === "completed"
            ? "completed"
            : result.run.status === "failed"
              ? "failed"
              : "runtime"
      );

      this.traceLog.record({
        scope: "durable-job-queue",
        action: "job_completed",
        metadata: { jobId: claimed.jobId, runId: claimed.runId, status: result.run.status }
      });

      return {
        jobId: claimed.jobId,
        runId: claimed.runId,
        status: "completed",
        result
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failedAt = new Date().toISOString();

      // Record failed attempt
      await this.db
        .update(jobAttempts)
        .set({ status: "failed", error: errorMessage, completedAt: failedAt })
        .where(eq(jobAttempts.id, attemptId));

      // Check if we should retry
      const jobRow = await this.db
        .select()
        .from(jobs)
        .where(eq(jobs.id, claimed.jobId))
        .limit(1);

      const job = jobRow[0];
      if (!job) {
        return { jobId: claimed.jobId, runId: claimed.runId, status: "failed", error: errorMessage };
      }

      if (job.attemptCount < job.maxAttempts) {
        // Schedule retry with exponential backoff
        const backoffMs = Math.min(1000 * Math.pow(2, job.attemptCount), 60_000);
        const nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();

        await this.db
          .update(jobs)
          .set({
            status: "retry_scheduled",
            lastError: errorMessage,
            nextAttemptAt,
            updatedAt: failedAt
          })
          .where(eq(jobs.id, claimed.jobId));

        this.traceLog.record({
          scope: "durable-job-queue",
          action: "job_retry_scheduled",
          metadata: {
            jobId: claimed.jobId,
            runId: claimed.runId,
            attempt: String(job.attemptCount),
            nextAttemptAt
          }
        });

        return {
          jobId: claimed.jobId,
          runId: claimed.runId,
          status: "retry_scheduled",
          error: errorMessage
        };
      }

      // Max retries exceeded — mark as permanently failed
      await this.db
        .update(jobs)
        .set({
          status: "failed",
          lastError: errorMessage,
          updatedAt: failedAt
        })
        .where(eq(jobs.id, claimed.jobId));

      this.recordCheckpoint(claimed.runId, "failed");

      this.traceLog.record({
        scope: "durable-job-queue",
        action: "job_failed",
        metadata: { jobId: claimed.jobId, runId: claimed.runId, error: errorMessage }
      });

      return {
        jobId: claimed.jobId,
        runId: claimed.runId,
        status: "failed",
        error: errorMessage
      };
    }
  }

  /**
   * Release resources held by the queue. Safe to call multiple times.
   * Currently a no-op since processing is synchronous; reserved for
   * future polling-loop teardown.
   */
  async shutdown(): Promise<void> {
    this.traceLog.record({
      scope: "durable-job-queue",
      action: "shutdown"
    });
  }

  async getJobStatus(jobId: string): Promise<JobStatus | null> {
    const rows = await this.db
      .select({ status: jobs.status })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);
    return rows[0]?.status as JobStatus ?? null;
  }

  async getPendingCount(): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)` })
      .from(jobs)
      .where(
        sql`${jobs.status} IN ('pending', 'retry_scheduled')`
      );
    return rows[0]?.count ?? 0;
  }

  async getRecoveryCandidates(): Promise<Array<{ jobId: string; runId: string; status: string; attemptCount: number; lastError: string | null }>> {
    const rows = await this.db
      .select({
        jobId: jobs.id,
        runId: jobs.runId,
        status: jobs.status,
        attemptCount: jobs.attemptCount,
        lastError: jobs.lastError
      })
      .from(jobs)
      .where(
        sql`${jobs.status} IN ('claimed', 'running', 'retry_scheduled')`
      );
    return rows;
  }

  async recoverStaleJobs(olderThanMs = 5 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs).toISOString();
    const now = new Date().toISOString();

    const recovered = await this.db
      .update(jobs)
      .set({
        status: "pending",
        nextAttemptAt: now,
        updatedAt: now
      })
      .where(
        and(
          sql`${jobs.status} IN ('claimed', 'running')`,
          lte(jobs.claimedAt, cutoff)
        )
      )
      .returning();

    return recovered.length;
  }

  listCheckpoints(): LifecycleCheckpoint[] {
    return [...this.checkpoints];
  }

  private async incrementAttemptCount(jobId: string, now: string): Promise<number> {
    const current = await this.db
      .select({ attemptCount: jobs.attemptCount })
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1);

    const newCount = (current[0]?.attemptCount ?? 0) + 1;

    await this.db
      .update(jobs)
      .set({ attemptCount: newCount, updatedAt: now })
      .where(eq(jobs.id, jobId));

    return newCount;
  }

  private recordCheckpoint(runId: string, stage: LifecycleCheckpoint["stage"]): void {
    this.checkpoints.push({
      runId,
      stage,
      createdAt: new Date().toISOString()
    });
  }
}

// ---------------------------------------------------------------------------
// Legacy compatibility — wraps the new queue for existing callers
// ---------------------------------------------------------------------------

export class TemporalWorkerSkeleton extends DurableJobQueue {
  async submitQueuedRun(run: Run): Promise<RuntimeExecutionResult> {
    const queued = transitionRun(run, "queued");
    const jobId = await this.enqueue(queued, "execute_run");

    const claimed = await this.claimNext();
    if (!claimed) {
      throw new Error("Failed to claim freshly enqueued job");
    }

    const result = await this.processClaimed(claimed, queued);
    if (result.result) return result.result;
    throw new Error(result.error ?? "Job processing failed");
  }

  async resumeApprovedRun(
    run: Run,
    approvedActions: AdapterActionType[]
  ): Promise<RuntimeExecutionResult> {
    const jobId = await this.enqueue(run, "resume_approved_run", {
      payload: { approvedActions }
    });

    const claimed = await this.claimNext();
    if (!claimed) {
      throw new Error("Failed to claim freshly enqueued job");
    }

    const result = await this.processClaimed(claimed, run);
    if (result.result) return result.result;
    throw new Error(result.error ?? "Job processing failed");
  }
}
