import { z } from "zod";

import type { Run, RunStatus, RunStepResult, RuntimeEvent } from "./index.js";
import {
  appendRunStepResult,
  canTransitionRunStatus,
  runSchema,
  runStepResultSchema,
  runtimeEventSchema,
  transitionRun
} from "./index.js";

/**
 * `run.events.v1` — the append-only Run event log and its deterministic
 * projection.
 *
 * `run_events` (migration 0011) is the authoritative, append-only record of a
 * Growth Run's step-level execution: rows are only ever inserted, `sequence` is
 * gapless per run, and a run's full log is the single export source for replay
 * fixtures (`SELECT ... WHERE run_id = $1 ORDER BY sequence`).
 *
 * W1b: the log is also the authoritative **read source** — the live SSE route
 * tails `run_events` (`sequence > cursor`) and projects frames through
 * `rebuildRunFromEvents` instead of diffing the mutable `runs` row; audit,
 * replay, and incident export all read the same log.
 *
 * `rebuildRunFromEvents` is the pure projection from that log back to the
 * `runs` row. It must reproduce the row field for field — that equality is what
 * makes the log, rather than the mutable row, the source of truth.
 *
 * Module-evaluation note: this file is reached from `./index.js`'s barrel, so it
 * deliberately defines every schema from `z` primitives only and touches the
 * shared Run helpers inside function bodies. That keeps the import cycle inert
 * and lets the function be imported in a bare vitest process with no database
 * and no control plane.
 */

export const RUN_EVENT_SCHEMA_VERSION = "1.0";

/**
 * Identity baseline of a Run, recorded on the first event a persistence call
 * appends. These are the projection fields the event vocabulary cannot express
 * (workspace, template, input, timestamps); everything else is derived from the
 * events themselves.
 */
export const runEventRunBaseSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  templateType: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  completedAt: z.string().min(1).optional()
});
export type RunEventRunBase = z.infer<typeof runEventRunBaseSchema>;

/**
 * The persisted shape of one `run_events.payload`. The first five fields are
 * the event itself; the rest is the enrichment that makes the log sufficient to
 * rebuild the row (the W1b pre-requisite, pulled forward into W1a).
 */
export const runEventPayloadSchema = z.object({
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.string().min(1),
  stepId: z.string().nullable().optional(),
  details: z.string(),
  runBase: runEventRunBaseSchema.optional(),
  stepResult: z.record(z.string(), z.unknown()).optional(),
  outputPayload: z.record(z.string(), z.unknown()).optional(),
  failureReason: z.string().optional(),
  /** W1b approval parity: the decision an `approval_decided` event carries. */
  approvalDecision: z.object({ approved: z.boolean() }).optional()
});
export type RunEventPayload = z.infer<typeof runEventPayloadSchema>;

/** The subset of a `run_events` row the projection needs. */
export interface RunEventRecord {
  eventId: string;
  runId: string;
  sequence: number;
  eventType: string;
  occurredAt: string;
  emittedAt: string;
  payload: unknown;
}

/** Parse a persisted payload, accepting either the raw text column or an object. */
export function parseRunEventPayload(value: unknown): RunEventPayload {
  const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
  return runEventPayloadSchema.parse(raw);
}

/**
 * Project one persisted payload back to the worker-facing `RuntimeEvent`.
 * A payload that no longer satisfies the shared contract rejects instead of
 * silently producing a partial stream.
 */
export function runEventPayloadToRuntimeEvent(value: unknown): RuntimeEvent {
  const payload = parseRunEventPayload(value);
  return runtimeEventSchema.parse({
    type: payload.type,
    runId: payload.runId,
    ...(typeof payload.stepId === "string" ? { stepId: payload.stepId } : {}),
    details: payload.details,
    ...(payload.approvalDecision ? { approvalDecision: payload.approvalDecision } : {})
  });
}

/**
 * A transition that is legal from the current status goes through the shared
 * `transitionRun` (so projection semantics cannot drift). The log may begin
 * mid-execution — a preflight denial emits only `run_failed` — in which case the
 * documented terminal state is applied directly rather than rejecting the
 * rebuild.
 */
function advanceRun(run: Run, next: RunStatus): Run {
  return canTransitionRunStatus(run.status, next)
    ? transitionRun(run, next)
    : { ...run, status: next };
}

/**
 * Record a step outcome. A step is identified by `stepId`, and its result is
 * attached to every event of that step's span, so the same step is upserted
 * rather than appended twice.
 */
function upsertRunStepResult(run: Run, result: RunStepResult): Run {
  const existing = run.stepResults ?? [];
  const index = existing.findIndex((entry) => entry.stepId === result.stepId);
  if (index === -1) return appendRunStepResult(run, result);
  return {
    ...run,
    currentStep: result.stepId,
    stepResults: existing.map((entry, at) => (at === index ? result : entry))
  };
}

/**
 * Rebuild the `runs` row from a Run's full event log.
 *
 * Requires the complete, gapless stream for one run (the fixture-export read
 * shape). A delta stream, a gap, or a stream missing its identity baseline
 * rejects — a best-effort partial Run would be worse than no answer.
 */
export function rebuildRunFromEvents(records: readonly RunEventRecord[]): Run {
  if (records.length === 0) {
    throw new Error("Cannot rebuild a Run from an empty event stream");
  }

  const ordered = records
    .map((record) => ({ record, payload: parseRunEventPayload(record.payload) }))
    .sort((left, right) => left.payload.sequence - right.payload.sequence);

  ordered.forEach((entry, index) => {
    const expected = index + 1;
    if (entry.payload.sequence !== expected) {
      throw new Error(
        `Run event stream is not contiguous: expected sequence ${expected}, found ${entry.payload.sequence}`
      );
    }
  });

  // The latest baseline wins: a resumed execution appends a fresher projection
  // snapshot, and the newest one carries the run's terminal timestamps.
  const bases = ordered
    .map((entry) => entry.payload.runBase)
    .filter((base): base is RunEventRunBase => Boolean(base));
  const base = bases[bases.length - 1];
  if (!base) {
    throw new Error(
      "Run event stream does not carry a Run identity baseline (runBase)"
    );
  }

  let run: Run = runSchema.parse({
    id: base.id,
    workspaceId: base.workspaceId,
    templateType: base.templateType,
    status: "queued",
    input: base.input,
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: base.createdAt,
    updatedAt: base.updatedAt,
    ...(base.startedAt ? { startedAt: base.startedAt } : {})
  });

  for (const { payload } of ordered) {
    switch (payload.type) {
      case "run_accepted":
        run = advanceRun(run, "running");
        break;
      case "approval_requested":
        run = { ...advanceRun(run, "waiting_approval"), approvalStatus: "pending" };
        break;
      case "approval_decided": {
        // W1b approval parity: the row's post-decision state is only reachable
        // from the log if the decision itself is an event. A payload without
        // the decision fails closed rather than guessing an approvalStatus.
        const approved = payload.approvalDecision?.approved;
        if (approved === undefined) {
          throw new Error(
            "Run event 'approval_decided' does not carry its decision (approvalDecision)"
          );
        }
        run = approved
          ? { ...advanceRun(run, "running"), approvalStatus: "approved" }
          : { ...advanceRun(run, "cancelled"), approvalStatus: "rejected" };
        break;
      }
      case "run_completed":
        run = {
          ...advanceRun(run, "completed"),
          currentStep: null,
          ...(payload.outputPayload ? { outputPayload: payload.outputPayload } : {})
        };
        break;
      case "run_failed":
        run = {
          ...advanceRun(run, "failed"),
          currentStep: null,
          ...(payload.failureReason ? { failureReason: payload.failureReason } : {})
        };
        break;
      default:
        break;
    }
    if (payload.stepResult) {
      run = upsertRunStepResult(run, runStepResultSchema.parse(payload.stepResult));
    }
  }

  // The baseline timestamps are the projection's authoritative clock; the log's
  // own `occurredAt` marks when an event was appended, not when the row changed.
  const rebuilt: Run = { ...run, updatedAt: base.updatedAt };
  if (base.startedAt) {
    rebuilt.startedAt = base.startedAt;
  } else {
    delete rebuilt.startedAt;
  }
  if (base.completedAt) {
    rebuilt.completedAt = base.completedAt;
  } else {
    delete rebuilt.completedAt;
  }
  return runSchema.parse(rebuilt);
}
