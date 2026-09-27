import { createHash, randomUUID } from "node:crypto";

import { getTraceLog, type TraceLog } from "@neuroclaw/observability";
import { RuntimeWorker, type RuntimeExecutionResult } from "@neuroclaw/runtime-worker";
import {
  type AdapterActionType,
  type Run,
  transitionRun
} from "@neuroclaw/shared";
import { eq, and, lte, asc, sql } from "drizzle-orm";

import {
  type Database,
  type LifecycleCheckpoint,
  type LifecycleCheckpointStage,
  type PersistedLifecycleCheckpoint,
  jobs,
  jobAttempts,
  knowledgeEntries,
  loadCheckpoints,
  persistCheckpoint
} from "@neuroclaw/db";
import { embedText } from "@neuroclaw/agent-core";
import type { AiUsageSample } from "@neuroclaw/agent-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobType =
  | "execute_run"
  | "resume_approved_run"
  | "resume_from_checkpoint"
  | "embed_knowledge";

/** Optional JSON payload carried by a job (Round O/V/U, I-042 D2). */
export interface JobPayload {
  approvedActions?: AdapterActionType[];
  knowledgeId?: string;
  text?: string;
  /** Relay instance id (Round V): lets the worker mirror relay state. */
  relayId?: string;
  /** I-042 D2: checkpoint the resume job was derived from (audit/digest). */
  resumeFromCheckpointId?: string;
}
export type JobStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "retry_scheduled";

/**
 * I-042 D1: the checkpoint projection is now owned by @neuroclaw/db (its
 * durable home is `run_lifecycle_checkpoints`, migration 0013); the worker
 * keeps the same public type surface for existing consumers.
 *
 * I-042 D2: `LifecycleCheckpoint` is the input/in-memory shape while
 * `PersistedLifecycleCheckpoint` adds the DB-assigned identity (id) and the
 * authoritative append order (seq).
 */
export type { LifecycleCheckpoint, PersistedLifecycleCheckpoint };

export interface EnqueueOptions {
  maxAttempts?: number;
  payload?: JobPayload;
  /**
   * I-042 D2: database-enforced dedup key (unique index on
   * `jobs.idempotency_key`). When set, a repeated enqueue returns the
   * existing jobId instead of inserting a second job.
   */
  idempotencyKey?: string;
}

/**
 * I-042 D2: outcome of an explicit checkpoint-resume request.
 *   * `enqueued` — a fresh resume job was created (idempotency key proves it);
 *   * `already_enqueued` — a matching/live resume job already existed, reused;
 *   * `noop` — the origin stage is terminal or waits for approval; no job;
 *   * `rejected` — fail-closed (no causally defined origin), no job.
 */
export interface ResumeFromCheckpointResult {
  status: "enqueued" | "already_enqueued" | "noop" | "rejected";
  runId: string;
  jobId?: string;
  checkpointId?: string;
  stage?: LifecycleCheckpointStage;
  reason?: string;
}

/**
 * I-042 D2: audit digest for a resume action — sha256(origin checkpoint id +
 * serialized payload). Recorded in traces so a resume can be re-identified
 * without replaying the job row.
 */
function resumeDigest(checkpointId: string, payload: JobPayload): string {
  return createHash("sha256")
    .update(`${checkpointId}|${JSON.stringify(payload)}`)
    .digest("hex");
}

export interface ProcessResult {
  jobId: string;
  runId: string;
  status: JobStatus;
  result?: RuntimeExecutionResult;
  error?: string;
  /** LLM token usage metered during this job execution (Round J). */
  usage?: AiUsageSample;
}

// ---------------------------------------------------------------------------
// DurableJobQueue �?database-backed job queue with claim/process/retry
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
    const { jobId } = await this.enqueueInternal(run, type, options);
    return jobId;
  }

  /**
   * I-042 D2 polish: internal `enqueue` variant that additionally reports
   * whether this call actually created the job (`created: true`) or reused an
   * existing row through the idempotency key (`created: false` — pre-check hit
   * or unique-index race loss). The public `enqueue` contract is unchanged.
   */
  private async enqueueInternal(
    run: Run,
    type: JobType,
    options: EnqueueOptions
  ): Promise<{ jobId: string; created: boolean }> {
    const span = this.traceLog.startSpan("durable-job-queue", "enqueue", {
      runId: run.id,
      type
    });
    try {
      // I-042 D2: idempotent enqueue. With an explicit key the first caller
      // wins; every later caller gets the existing jobId back — including
      // under a race, where the losing INSERT trips the unique index on
      // `jobs.idempotency_key` and we re-read the winner.
      if (options.idempotencyKey) {
        const existing = await this.findJobByIdempotencyKey(options.idempotencyKey);
        if (existing) return { jobId: existing.id, created: false };
      }

      const jobId = `job_${randomUUID()}`;
      const now = new Date().toISOString();

      try {
        await this.db.insert(jobs).values({
          id: jobId,
          runId: run.id,
          type,
          status: "pending",
          payload: options.payload ? JSON.stringify(options.payload) : null,
          idempotencyKey: options.idempotencyKey ?? null,
          maxAttempts: options.maxAttempts ?? 3,
          attemptCount: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now
        });
      } catch (insertError) {
        if (options.idempotencyKey) {
          const raced = await this.findJobByIdempotencyKey(options.idempotencyKey);
          if (raced) return { jobId: raced.id, created: false };
        }
        throw insertError;
      }

      await this.recordCheckpoint(run.id, "queued");
      this.traceLog.record({
        scope: "durable-job-queue",
        action: "enqueue",
        metadata: { jobId, runId: run.id, type }
      });

      span.setAttribute("jobId", jobId);
      return { jobId, created: true };
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  async claimNext(): Promise<{ jobId: string; runId: string; type: JobType; payload?: JobPayload } | null> {
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
    let payload: JobPayload | undefined;
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
    claimed: { jobId: string; runId: string; type: JobType; payload?: JobPayload },
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
    claimed: { jobId: string; runId: string; type: JobType; payload?: JobPayload },
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
      if (claimed.type === "embed_knowledge") {
        return await this.processEmbedKnowledge(claimed, run, attemptId);
      }

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

      await this.recordCheckpoint(
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

      // I-042 D2: a completed resume carries its origin + digest for audit and
      // short-circuit checks. Execution itself reuses the existing pipeline
      // (partial continuation is a deferred runtime-worker item).
      if (claimed.type === "resume_from_checkpoint") {
        const checkpointId = claimed.payload?.resumeFromCheckpointId ?? "";
        this.traceLog.record({
          scope: "durable-job-queue",
          action: "job_resumed_from_checkpoint",
          metadata: {
            jobId: claimed.jobId,
            runId: claimed.runId,
            resumeFromCheckpointId: checkpointId,
            digest: resumeDigest(checkpointId, claimed.payload ?? {})
          }
        });
      }

      return {
        jobId: claimed.jobId,
        runId: claimed.runId,
        status: "completed",
        result,
        usage: this.runtimeWorker.consumeRunUsage(claimed.runId)
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

      // Max retries exceeded �?mark as permanently failed
      await this.db
        .update(jobs)
        .set({
          status: "failed",
          lastError: errorMessage,
          updatedAt: failedAt
        })
        .where(eq(jobs.id, claimed.jobId));

      await this.recordCheckpoint(claimed.runId, "failed");

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
   * R2-A3: embed a knowledge entry via the embeddings provider and persist
   * the vector. Missing provider/key degrades to a completed no-op so the
   * queue never accumulates junk; failures route through the retry path.
   */
  private async processEmbedKnowledge(
    claimed: { jobId: string; runId: string; type: JobType; payload?: JobPayload },
    run: Run,
    attemptId: string
  ): Promise<ProcessResult> {
    const knowledgeId = typeof claimed.payload?.knowledgeId === "string" ? claimed.payload.knowledgeId : null;
    const text = typeof claimed.payload?.text === "string" ? claimed.payload.text : "";

    const vector = await embedText(text);
    const completedAt = new Date().toISOString();

    await this.db
      .update(jobAttempts)
      .set({ status: "completed", completedAt })
      .where(eq(jobAttempts.id, attemptId));

    await this.db
      .update(jobs)
      .set({ status: "completed", updatedAt: completedAt, completedAt })
      .where(eq(jobs.id, claimed.jobId));

    let embedded = false;
    if (vector && knowledgeId) {
      await this.db.execute(
        sql`UPDATE knowledge_entries SET embedding = ${`[${vector.join(",")}]`}::vector WHERE id = ${knowledgeId}`
      );
      embedded = true;
    }

    await this.recordCheckpoint(run.id, embedded ? "completed" : "runtime");

    this.traceLog.record({
      scope: "durable-job-queue",
      action: embedded ? "job_completed" : "job_embed_skipped",
      metadata: { jobId: claimed.jobId, knowledgeId: knowledgeId ?? "", embedded: String(embedded) }
    });

    return {
      jobId: claimed.jobId,
      runId: claimed.runId,
      status: "completed",
      result: { run, templateId: "embed_knowledge", events: [] }
    };
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

    // I-042 D2 (GM decision): recovery keeps its redelivery semantics — the
    // job goes back to `pending` and will be claimed into a full replay. It
    // never resumes from a checkpoint and never touches checkpoint rows; it
    // only gains this observability marker.
    for (const job of recovered) {
      this.traceLog.record({
        scope: "durable-job-queue",
        action: "job_recovered",
        metadata: { jobId: job.id, runId: job.runId }
      });
    }

    return recovered.length;
  }

  listCheckpoints(): LifecycleCheckpoint[] {
    return [...this.checkpoints];
  }

  /**
   * I-042 D1: read the durable checkpoint stream for a run. Unlike
   * `listCheckpoints`, this survives a fresh store instance over the same
   * database — the read path the D2 resume semantics build on.
   */
  async listPersistedCheckpoints(runId: string): Promise<PersistedLifecycleCheckpoint[]> {
    return loadCheckpoints(this.db, runId);
  }

  /**
   * I-042 D2: explicit checkpoint-resume entry point (human/API trigger only;
   * `recoverStaleJobs` deliberately keeps its redelivery+replay semantics and
   * never calls this).
   *
   * Origin = newest persisted checkpoint by database write order (seq), i.e.
   * the only causally correct choice. Fail-closed: with no checkpoint there is
   * no defined origin, so the request is rejected (`resume_unavailable`) and
   * never silently degrades into a full replay.
   *
   * Stage mapping (design §5): queued / runtime / failed enqueue a resume job;
   * waiting_approval and completed are no-ops. The dedup object is the resume
   * action, not checkpoint rows: idempotency key = (runId, origin checkpoint
   * id), enforced by the unique index on `jobs.idempotency_key`, so repeated
   * calls return the existing jobId. Resume never mutates the original job
   * row: its attempts budget is independent (`maxAttempts` on the resume job
   * only).
   */
  async resumeRunFromCheckpoint(run: Run): Promise<ResumeFromCheckpointResult> {
    const span = this.traceLog.startSpan("durable-job-queue", "resumeRunFromCheckpoint", {
      runId: run.id
    });
    try {
      const checkpoints = await this.listPersistedCheckpoints(run.id);
      const origin = checkpoints.at(-1);
      if (!origin) {
        this.traceLog.record({
          scope: "durable-job-queue",
          action: "resume_unavailable",
          metadata: { runId: run.id, reason: "no_checkpoint" }
        });
        return { status: "rejected", runId: run.id, reason: "resume_unavailable" };
      }

      // In-flight guard: a live resume job for this run is returned as-is.
      // (Enqueueing grew the checkpoint stream a `queued` row, so computing
      // the key from the newest checkpoint alone would no longer match it.)
      const active = await this.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.runId, run.id),
            eq(jobs.type, "resume_from_checkpoint"),
            sql`${jobs.status} IN ('pending', 'claimed', 'running', 'retry_scheduled')`
          )
        )
        .limit(1);
      if (active[0]) {
        return {
          status: "already_enqueued",
          runId: run.id,
          jobId: active[0].id,
          checkpointId: origin.id,
          stage: origin.stage
        };
      }

      if (origin.stage === "waiting_approval" || origin.stage === "completed") {
        return {
          status: "noop",
          runId: run.id,
          checkpointId: origin.id,
          stage: origin.stage,
          reason: origin.stage
        };
      }

      if (origin.stage !== "queued" && origin.stage !== "runtime" && origin.stage !== "failed") {
        // Defensive: an unrecognized origin stage can never be resumed blindly.
        this.traceLog.record({
          scope: "durable-job-queue",
          action: "resume_unavailable",
          metadata: { runId: run.id, reason: "unknown_origin_stage" }
        });
        return { status: "rejected", runId: run.id, reason: "resume_unavailable" };
      }

      // Idempotency: (runId, origin checkpoint id). Same-origin duplicates
      // (e.g. two operators racing on the same newest checkpoint) collapse to
      // one job; the unique index is the database-side guard.
      const idempotencyKey = `resume:${run.id}:${origin.id}`;
      const existing = await this.findJobByIdempotencyKey(idempotencyKey);
      if (existing) {
        return {
          status: "already_enqueued",
          runId: run.id,
          jobId: existing.id,
          checkpointId: origin.id,
          stage: origin.stage
        };
      }

      const payload: JobPayload = { resumeFromCheckpointId: origin.id };
      const digest = resumeDigest(origin.id, payload);
      const { jobId, created } = await this.enqueueInternal(run, "resume_from_checkpoint", {
        payload,
        idempotencyKey
      });

      if (!created) {
        // Lost a concurrent dedup race (unique-index re-read): collapse to the
        // same idempotent outcome as the sequential path — never report a
        // fresh enqueue for a reused job.
        return {
          status: "already_enqueued",
          runId: run.id,
          jobId,
          checkpointId: origin.id,
          stage: origin.stage
        };
      }

      this.traceLog.record({
        scope: "durable-job-queue",
        action: "resume_enqueued",
        metadata: {
          runId: run.id,
          jobId,
          resumeFromCheckpointId: origin.id,
          stage: origin.stage,
          digest
        }
      });

      span.setAttribute("jobId", jobId);
      span.setAttribute("origin.stage", origin.stage);
      return {
        status: "enqueued",
        runId: run.id,
        jobId,
        checkpointId: origin.id,
        stage: origin.stage
      };
    } catch (error) {
      span.recordError(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  private async findJobByIdempotencyKey(key: string): Promise<{ id: string } | null> {
    const rows = await this.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(eq(jobs.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
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

  /**
   * I-042 D1: record a lifecycle checkpoint in memory (unchanged contract)
   * and mirror it to `run_lifecycle_checkpoints`. Persistence is best-effort:
   * the jobs table stays the authoritative job state, so a checkpoint write
   * failure is traced, not rethrown — it must never turn a successful job
   * into a retry.
   */
  private async recordCheckpoint(
    runId: string,
    stage: LifecycleCheckpoint["stage"]
  ): Promise<void> {
    const checkpoint: LifecycleCheckpoint = {
      runId,
      stage,
      createdAt: new Date().toISOString()
    };
    this.checkpoints.push(checkpoint);

    try {
      await persistCheckpoint(this.db, checkpoint);
    } catch (error) {
      this.traceLog.record({
        scope: "durable-job-queue",
        action: "checkpoint_persist_error",
        metadata: {
          runId,
          stage,
          error: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Legacy compatibility �?wraps the new queue for existing callers
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
