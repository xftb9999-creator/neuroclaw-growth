import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  jobs,
  loadCheckpoints,
  persistCheckpoint,
  rollbackMigration,
  runMigrations,
  type Database
} from "@neuroclaw/db";
import { getTraceLog } from "@neuroclaw/observability";
import { DurableJobQueue } from "@neuroclaw/temporal-worker";
import type { Run } from "@neuroclaw/shared";

import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

/**
 * I-042 D2 (GM ruling 2026-09-27): explicit checkpoint resume —
 * `resume_from_checkpoint` / `resumeRunFromCheckpoint` over the 0014 schema
 * (checkpoints.seq + jobs.idempotency_key), the admin-only `run:resume` route
 * wiring, and the migration chain sync (0013 rollback requires 0014 first).
 *
 *  ① origin = newest checkpoint by write order (seq): created_at ties and
 *    random ids no longer decide;
 *  ② repeated calls are idempotent (same jobId, exactly one resume job);
 *    concurrent duplicates collapse too: one racer reports `enqueued`, the
 *    loser reports `already_enqueued` (unique-index re-read path);
 *  ③ no origin → fail-closed `resume_unavailable` (no job, trace, no silent
 *    full replay); stage no-ops are not rejections;
 *  ④ resume never consumes/mutates the original job's attempts budget;
 *  ⑤ recoverStaleJobs keeps redelivery semantics (pending + nextAttemptAt)
 *    and gains the `job_recovered` trace, never touching checkpoint rows;
 *  ⑥ 0014 is latest-only reversible and re-applies cleanly.
 *
 * GM ruling ②: no RunStatus is introduced — fail-closed surfaces as the error
 * code `resume_unavailable` (service result / route 409), never as a status.
 */

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setupDb(): Promise<Database> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return db;
}

function queuedRun(id: string): Run {
  const now = new Date("2026-09-27T00:00:00.000Z").toISOString();
  return {
    id,
    workspaceId: "ws_i042d2",
    templateType: "growth_ops",
    status: "queued",
    input: {},
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: now,
    updatedAt: now
  };
}

async function jobRows(db: Database, runId: string) {
  return db.select().from(jobs).where(eq(jobs.runId, runId));
}

describe("① resume origin — newest by write order (seq)", () => {
  it("(created_at, id) can no longer decide: the last write wins", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_origin");
    await queue.enqueue(run);

    // A row stamped LATER is written first; a row stamped EARLIER is written
    // last. D1's (created_at, id) read order would pick the later stamp; the
    // authoritative write order (seq) must pick the last write.
    const laterStamp = await persistCheckpoint(db, {
      runId: run.id,
      stage: "runtime",
      createdAt: "2026-09-27T10:00:00.000Z"
    });
    const earlierStamp = await persistCheckpoint(db, {
      runId: run.id,
      stage: "failed",
      createdAt: "2026-09-27T09:00:00.000Z"
    });
    expect(laterStamp.seq).toBeLessThan(earlierStamp.seq);

    const loaded = await loadCheckpoints(db, run.id);
    expect(loaded).toHaveLength(3);
    expect(loaded[1].id).toBe(laterStamp.id);
    expect(loaded[2].id).toBe(earlierStamp.id);

    const result = await queue.resumeRunFromCheckpoint(run);
    expect(result.status).toBe("enqueued");
    expect(result.checkpointId).toBe(earlierStamp.id);
    expect(result.stage).toBe("failed");

    const resumeJob = (await db.select().from(jobs).where(eq(jobs.id, result.jobId!)))[0];
    expect(JSON.parse(resumeJob.payload!)).toEqual({ resumeFromCheckpointId: earlierStamp.id });
  });

  it("equal created_at rows stay deterministic (causal seq, not random id)", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_tie");
    await queue.enqueue(run);

    const sameStamp = "2026-09-27T11:00:00.000Z";
    const firstTie = await persistCheckpoint(db, {
      runId: run.id,
      stage: "runtime",
      createdAt: sameStamp
    });
    const secondTie = await persistCheckpoint(db, {
      runId: run.id,
      stage: "runtime",
      createdAt: sameStamp
    });
    expect(secondTie.seq).toBe(firstTie.seq + 1);

    const result = await queue.resumeRunFromCheckpoint(run);
    expect(result.status).toBe("enqueued");
    expect(result.checkpointId).toBe(secondTie.id);
  });
});

describe("② idempotent repeated resume", () => {
  it("returns the existing jobId and keeps exactly one resume job", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_idem");
    await queue.enqueue(run);

    const first = await queue.resumeRunFromCheckpoint(run);
    const second = await queue.resumeRunFromCheckpoint(run);
    expect(first.status).toBe("enqueued");
    expect(first.checkpointId).toBeTruthy();
    expect(second.status).toBe("already_enqueued");
    expect(second.jobId).toBe(first.jobId);

    const resumeJobs = (await jobRows(db, run.id)).filter(
      (row) => row.type === "resume_from_checkpoint"
    );
    expect(resumeJobs).toHaveLength(1);
    expect(resumeJobs[0].idempotencyKey).toBe(`resume:${run.id}:${first.checkpointId}`);

    // Database-side guard: the same key can never mint a second job row.
    const replayed = await queue.enqueue(run, "resume_from_checkpoint", {
      payload: { resumeFromCheckpointId: first.checkpointId! },
      idempotencyKey: `resume:${run.id}:${first.checkpointId}`
    });
    expect(replayed).toBe(first.jobId);
    expect(
      (await jobRows(db, run.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(1);

    // D2 polish: concurrent duplicates on a fresh run. Exactly one racer wins
    // the insert and reports `enqueued`; the loser — whether it short-circuits
    // on the pre-check or trips the unique index and re-reads the winner —
    // must report `already_enqueued` with the same jobId, never a phantom
    // second enqueue.
    const raceRun = queuedRun("run_i042d2_idem_race");
    await queue.enqueue(raceRun);
    const [a, b] = await Promise.all([
      queue.resumeRunFromCheckpoint(raceRun),
      queue.resumeRunFromCheckpoint(raceRun)
    ]);
    expect(a.jobId).toBeTruthy();
    expect(b.jobId).toBe(a.jobId);
    expect([a.status, b.status].sort()).toEqual(["already_enqueued", "enqueued"]);
    expect(
      (await jobRows(db, raceRun.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(1);
  });
});

describe("③ fail-closed origin (resume_unavailable)", () => {
  it("no checkpoint: rejected, no job, trace, no silent full replay", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_none");

    const result = await queue.resumeRunFromCheckpoint(run);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("resume_unavailable");
    expect(result.jobId).toBeUndefined();
    expect(await jobRows(db, run.id)).toHaveLength(0);
    expect(await loadCheckpoints(db, run.id)).toEqual([]);

    const traces = getTraceLog()
      .list()
      .filter(
        (event) =>
          event.scope === "durable-job-queue" &&
          event.action === "resume_unavailable" &&
          event.metadata?.runId === run.id
      );
    expect(traces).toHaveLength(1);
    expect(traces[0].metadata?.reason).toBe("no_checkpoint");
  });

  it("waiting_approval origin is a no-op, not a rejection", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_noop");
    await queue.enqueue(run);
    await persistCheckpoint(db, {
      runId: run.id,
      stage: "waiting_approval",
      createdAt: "2026-09-27T12:00:00.000Z"
    });

    const result = await queue.resumeRunFromCheckpoint(run);
    expect(result.status).toBe("noop");
    expect(result.reason).toBe("waiting_approval");
    expect(result.jobId).toBeUndefined();
    expect(
      (await jobRows(db, run.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(0);
  });
});

describe("④ resume budget independence", () => {
  it("does not touch the original job's attempts budget even when exhausted", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_budget");
    const originalJobId = await queue.enqueue(run, "execute_run", { maxAttempts: 1 });

    // Exhaust the original job (permanent failure, budget spent).
    await db
      .update(jobs)
      .set({ status: "failed", attemptCount: 1, lastError: "budget spent" })
      .where(eq(jobs.id, originalJobId));
    const before = (await db.select().from(jobs).where(eq(jobs.id, originalJobId)))[0];

    const result = await queue.resumeRunFromCheckpoint(run);
    expect(result.status).toBe("enqueued");

    const after = (await db.select().from(jobs).where(eq(jobs.id, originalJobId)))[0];
    expect(after).toEqual(before); // byte-for-byte untouched
    expect(after.attemptCount).toBe(1);
    expect(after.maxAttempts).toBe(1);

    const resumeJob = (await db.select().from(jobs).where(eq(jobs.id, result.jobId!)))[0];
    expect(resumeJob.id).not.toBe(originalJobId);
    expect(resumeJob.attemptCount).toBe(0); // independent budget
    expect(resumeJob.maxAttempts).toBeGreaterThanOrEqual(1);
  });
});

describe("⑤ recoverStaleJobs", () => {
  it("keeps redelivery semantics and records job_recovered", async () => {
    const db = await setupDb();
    const queue = new DurableJobQueue(db);
    const run = queuedRun("run_i042d2_stale");
    const jobId = await queue.enqueue(run);

    const claimed = await queue.claimNext();
    expect(claimed?.jobId).toBe(jobId);
    const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await db.update(jobs).set({ status: "running", claimedAt: staleAt }).where(eq(jobs.id, jobId));
    const checkpointsBefore = await loadCheckpoints(db, run.id);

    const recovered = await queue.recoverStaleJobs();
    expect(recovered).toBe(1);

    const row = (await db.select().from(jobs).where(eq(jobs.id, jobId)))[0];
    expect(row.status).toBe("pending"); // redelivery, not checkpoint resume
    expect(Date.parse(row.nextAttemptAt!)).toBeGreaterThan(Date.now() - 10_000);
    expect(row.claimedAt).toBeTruthy();
    // Claim history is preserved (DB may re-serialize TIMESTAMPTZ to local TZ).
    expect(new Date(row.claimedAt!).getTime()).toBe(new Date(staleAt).getTime());
    expect(await loadCheckpoints(db, run.id)).toEqual(checkpointsBefore); // never touches checkpoints

    const traces = getTraceLog()
      .list()
      .filter((event) => event.action === "job_recovered" && event.metadata?.jobId === jobId);
    expect(traces).toHaveLength(1);
    expect(traces[0].scope).toBe("durable-job-queue");
    expect(traces[0].metadata?.runId).toBe(run.id);
  });
});

describe("⑥ migration 0014 rollback + rerun", () => {
  it("is latest-only reversible; 0013 needs 0014 rolled back first", async () => {
    const db = await setupDb();
    expect(await runMigrations(db)).toEqual([]);

    // 0013 is no longer the latest applied migration: 0014 must go first.
    await expect(rollbackMigration(db, "0013_run_lifecycle_checkpoints")).rejects.toThrow(
      /later migration/i
    );
    expect(await rollbackMigration(db, "0014_checkpoint_seq_and_job_idempotency")).toBe(true);

    // seq (and the seq-returning read/write path) is gone until 0014 returns.
    await expect(loadCheckpoints(db, "run_i042d2_rb")).rejects.toThrow();

    expect(await runMigrations(db)).toEqual(["0014_checkpoint_seq_and_job_idempotency"]);
    const checkpoint = await persistCheckpoint(db, {
      runId: "run_i042d2_rb",
      stage: "runtime",
      createdAt: "2026-09-27T13:00:00.000Z"
    });
    expect(checkpoint.seq).toBeGreaterThan(0);
    const loaded = await loadCheckpoints(db, checkpoint.runId);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(checkpoint.id);
  });
});

// ---------------------------------------------------------------------------
// Route wiring — POST /api/runs/:runId/resume · admin-only `run:resume`
// (GM ruling ①). 403 without the permission; 404 unknown run; 409 + code
// `resume_unavailable` fail-closed (GM ruling ②); 200 with the outcome
// otherwise (`enqueued` / `already_enqueued` / `noop`). The run row is never
// rewritten — no RunStatus is introduced.
// ---------------------------------------------------------------------------

const ADMIN_KEY = "i042d2-admin-key";
const originalApiKeys = process.env.NEUROCLAW_API_KEYS;

interface RouteHarness {
  db: Database;
  service: ControlPlaneService;
  app: ReturnType<typeof createApp>;
}

async function setupRoute(): Promise<RouteHarness> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
    durable: true
  });
  return { db, service, app: createApp(service) };
}

async function seedQueuedRun(service: ControlPlaneService): Promise<Run> {
  const workspace = await service.createWorkspace(
    { name: "I-042 D2 Resume Lab", plan: "team" },
    "admin_i042d2"
  );
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "content_acquisition",
    input: {
      businessSummary: "I-042 D2 resume",
      targetCustomer: "operators",
      preferredChannels: ["email"],
      contentGoal: "hooks"
    }
  });
}

function resumeRequest(app: RouteHarness["app"], runId: string, key: string) {
  return app.request(`/api/runs/${runId}/resume`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` }
  });
}

describe("route wiring · POST /api/runs/:runId/resume", () => {
  beforeAll(() => {
    process.env.NEUROCLAW_API_KEYS =
      `${ADMIN_KEY}:admin_i042d2:admin,` +
      "i042d2-operator-key:operator_i042d2:operator," +
      "i042d2-viewer-key:viewer_i042d2:viewer";
  });

  afterAll(() => {
    if (originalApiKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
    else process.env.NEUROCLAW_API_KEYS = originalApiKeys;
  });

  it("403: operator and viewer lack run:resume (admin-only)", async () => {
    const { app, service } = await setupRoute();
    const run = await seedQueuedRun(service);
    for (const key of ["i042d2-operator-key", "i042d2-viewer-key"]) {
      const res = await resumeRequest(app, run.id, key);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("AUTH_FORBIDDEN");
    }
  });

  it("404: unknown run", async () => {
    const { app } = await setupRoute();
    const res = await resumeRequest(app, "run_i042d2_missing", ADMIN_KEY);
    expect(res.status).toBe(404);
  });

  it("409 + resume_unavailable: fail-closed when no checkpoint exists", async () => {
    const { app, db, service } = await setupRoute();
    const run = await seedQueuedRun(service);
    // createRun appends a `queued` checkpoint; strip the stream to model a
    // run whose checkpoint rows are missing (best-effort persist, D1-F4).
    await db.execute(sql`DELETE FROM run_lifecycle_checkpoints WHERE run_id = ${run.id}`);

    const res = await resumeRequest(app, run.id, ADMIN_KEY);
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      result: { status: string; reason?: string; jobId?: string };
    };
    expect(body.code).toBe("resume_unavailable");
    expect(body.result.status).toBe("rejected");
    expect(body.result.reason).toBe("resume_unavailable");
    expect(body.result.jobId).toBeUndefined();
    expect(
      (await jobRows(db, run.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(0);
  });

  it("200: admin resumes; a repeat returns the same jobId", async () => {
    const { app, db, service } = await setupRoute();
    const run = await seedQueuedRun(service);

    const first = await resumeRequest(app, run.id, ADMIN_KEY);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      result: { status: string; jobId?: string };
    };
    expect(firstBody.result.status).toBe("enqueued");
    expect(firstBody.result.jobId).toBeTruthy();

    const second = await resumeRequest(app, run.id, ADMIN_KEY);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      result: { status: string; jobId?: string };
    };
    expect(secondBody.result.status).toBe("already_enqueued");
    expect(secondBody.result.jobId).toBe(firstBody.result.jobId);
    expect(
      (await jobRows(db, run.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(1);
  });

  it("200 noop: waiting_approval origin creates no job", async () => {
    const { app, db, service } = await setupRoute();
    const run = await seedQueuedRun(service);
    await persistCheckpoint(db, {
      runId: run.id,
      stage: "waiting_approval",
      createdAt: new Date().toISOString()
    });

    const res = await resumeRequest(app, run.id, ADMIN_KEY);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { status: string; reason?: string } };
    expect(body.result.status).toBe("noop");
    expect(body.result.reason).toBe("waiting_approval");
    expect(
      (await jobRows(db, run.id)).filter((row) => row.type === "resume_from_checkpoint")
    ).toHaveLength(0);
  });
});
