import { z } from "zod";

import type { Run } from "./index.js";
import { runSchema } from "./index.js";
import {
  rebuildRunFromEvents,
  runEventPayloadSchema,
  type RunEventRecord
} from "./run-events.js";

/**
 * `run.events.v1` — the incident replay fixture: format, exporter, and replay.
 *
 * 梁一闭环的前三件（B1 §6, `B1:206-214`）：**事故 → 夹具 → 重放**。本文件只放
 * 纯函数，刻意与 control-plane / DB 解耦，以便在裸 vitest 进程里直接 import
 * （`B1:210`：`rebuildRunFromEvents` 及其配套必须是纯函数且从 `packages/shared`
 * 导出）。`replay-gate` CI job 本身**未授权**（停止线外），本地切片只交付它未来
 * 要调用的那几个函数。
 *
 * - 导出源唯一：`SELECT * FROM run_events WHERE run_id=$1 ORDER BY sequence`
 *   （`B1:209`）。导出器把 `run_events` 行投影成夹具；`sequence` 连续无洞、事件只增
 *   是 W1 的保证，导出器在此复核并 fail-closed。
 * - 夹具格式（`B1:208`）：**输入 + 期望 step 序列 + 期望副作用集合 + 期望终态**。
 * - 副作用字段 `transport / recipientHash / contentDigest / deliveryOutcome`
 *   由 W2 的 outbox 事件携带；W1 日志里没有，所以 `deriveRunSideEffects` 今天
 *   恒返回 `[]`，但 schema 与比对口径现在就钉死，W2 落地后无需改夹具格式。
 *
 * Module-evaluation note: like `run-events.ts`, this file is reached from the
 * `./index.js` barrel, so it only pulls `zod` primitives at module scope and
 * touches the shared Run helpers inside function bodies. The `run` expectation
 * is `z.lazy`, so even it resolves `runSchema` at parse time, not module-eval
 * time — a direct `run: runSchema` here would read the barrel's `const` before
 * its initialization (`Invalid element at key "run"`). That keeps the import
 * cycle inert.
 */

export const INCIDENT_REPLAY_FIXTURE_VERSION = "1.0";

/** One `run_events` row as the exporter accepts it (DB row or history entry). */
export type RunEventExportInput = RunEventRecord;

/** The `run_events` projection columns a fixture preserves, payload parsed. */
export const runEventRecordSchema = z.object({
  eventId: z.string().min(1),
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  eventType: z.string().min(1),
  occurredAt: z.string().min(1),
  emittedAt: z.string().min(1),
  payload: z
    .unknown()
    .refine((value) => runEventPayloadSchema.safeParse(value).success, {
      message: "event payload does not satisfy runEventPayloadSchema"
    })
});

/**
 * The four side-effect fields B1 pins for W2's delivery events (`B1:208`).
 * Required whenever a side effect is *claimed*: an expectation the log cannot
 * evidence is a mismatch, not a silent pass.
 */
export const replaySideEffectSchema = z.object({
  eventId: z.string().min(1),
  stepId: z.string().min(1).optional(),
  transport: z.string().min(1),
  recipientHash: z.string().min(1),
  contentDigest: z.string().min(1),
  deliveryOutcome: z.string().min(1)
});
export type ReplaySideEffect = z.infer<typeof replaySideEffectSchema>;

/** 期望输入 + 期望 step 序列 + 期望副作用集合 + 期望终态 (`B1:208`). */
export const incidentReplayExpectationSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  steps: z.array(z.string().min(1)),
  sideEffects: z.array(replaySideEffectSchema),
  // Lazy on purpose: see the module-evaluation note above.
  run: z.lazy(() => runSchema)
});
export type IncidentReplayExpectation = z.infer<typeof incidentReplayExpectationSchema>;

export const incidentReplayFixtureSchema = z.object({
  fixtureVersion: z.literal(INCIDENT_REPLAY_FIXTURE_VERSION),
  name: z.string().min(1),
  description: z.string().optional(),
  source: z.object({
    runId: z.string().min(1),
    table: z.literal("run_events"),
    eventCount: z.number().int().positive()
  }),
  events: z.array(runEventRecordSchema).min(1),
  expected: incidentReplayExpectationSchema
});
export type IncidentReplayFixture = z.infer<typeof incidentReplayFixtureSchema>;

/** Parse a row's payload that may still be the raw text column. */
function rawPayload(value: unknown): Record<string, unknown> {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Run event payload is not an object");
  }
  return parsed as Record<string, unknown>;
}

function stringValue(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `sequence` order, fail-closed on a row/payload sequence disagreement. */
function ordered(rows: readonly RunEventExportInput[]): RunEventExportInput[] {
  return rows
    .map((row) => {
      const payload = rawPayload(row.payload);
      const payloadSequence = payload.sequence;
      if (typeof payloadSequence === "number" && payloadSequence !== row.sequence) {
        throw new Error(
          `Run event '${row.eventId}' disagrees with its payload: row sequence ${row.sequence}, payload sequence ${payloadSequence}`
        );
      }
      return { row, payload };
    })
    .sort((left, right) => left.row.sequence - right.row.sequence)
    .map(({ row, payload }) => ({
      eventId: row.eventId,
      runId: row.runId,
      sequence: row.sequence,
      eventType: row.eventType,
      occurredAt: row.occurredAt,
      emittedAt: row.emittedAt,
      payload
    }));
}

/** The append-only invariants the exporter re-checks before freezing a fixture. */
function assertExportable(rows: readonly RunEventExportInput[]): void {
  if (rows.length === 0) {
    throw new Error("Cannot export a fixture from an empty run_events read");
  }
  const runIds = new Set(rows.map((row) => row.runId));
  if (runIds.size !== 1) {
    throw new Error(
      `A fixture must hold exactly one run's log; found ${runIds.size} run ids`
    );
  }
  const eventIds = new Set(rows.map((row) => row.eventId));
  if (eventIds.size !== rows.length) {
    throw new Error("Run event log contains duplicate event ids");
  }
  const orderedRows = ordered(rows);
  orderedRows.forEach((row, index) => {
    const expected = index + 1;
    if (row.sequence !== expected) {
      throw new Error(
        `Run event log is not contiguous: expected sequence ${expected}, found ${row.sequence}`
      );
    }
  });
}

/** 期望 step 序列: first appearance, in `sequence` order. */
export function deriveRunSteps(records: readonly RunEventExportInput[]): string[] {
  const steps: string[] = [];
  for (const record of ordered(records)) {
    const stepId = stringValue(rawPayload(record.payload), "stepId");
    if (stepId && !steps.includes(stepId)) steps.push(stepId);
  }
  return steps;
}

/**
 * 期望副作用集合, rebuilt from the log itself.
 *
 * Today every W1 payload lacks the four W2 delivery fields, so this returns
 * `[]` — which is the honest expectation for a W1-only incident: no delivery
 * was attempted. Once W2 writes `side_effect_delivered`, the same reader picks
 * `transport / recipientHash / contentDigest / deliveryOutcome` out of either a
 * nested `sideEffect` carrier or the payload itself.
 */
export function deriveRunSideEffects(
  records: readonly RunEventExportInput[]
): ReplaySideEffect[] {
  const sideEffects: ReplaySideEffect[] = [];
  for (const record of ordered(records)) {
    const payload = rawPayload(record.payload);
    const carrier =
      payload.sideEffect && typeof payload.sideEffect === "object" && !Array.isArray(payload.sideEffect)
        ? (payload.sideEffect as Record<string, unknown>)
        : payload;
    const transport = stringValue(carrier, "transport");
    const recipientHash = stringValue(carrier, "recipientHash");
    const contentDigest = stringValue(carrier, "contentDigest");
    const deliveryOutcome = stringValue(carrier, "deliveryOutcome");
    if (!transport || !recipientHash || !contentDigest || !deliveryOutcome) continue;
    const stepId = stringValue(carrier, "stepId") ?? stringValue(payload, "stepId");
    sideEffects.push({
      eventId: record.eventId,
      ...(stepId ? { stepId } : {}),
      transport,
      recipientHash,
      contentDigest,
      deliveryOutcome
    });
  }
  return sideEffects;
}

export interface ExportRunEventReplayOptions {
  /** Fixture id / file stem; defaults to `incident-<runId>`. */
  name?: string;
  description?: string;
}

/**
 * `run_events` 行 → 夹具 JSON 对象 (`B1:209` 的导出器).
 *
 * The read shape is `SELECT * FROM run_events ORDER BY sequence`; the fixture
 * keeps the projection columns (`RunEventRecord`) with `payload` parsed so the
 * committed JSON stays readable. The expectation is frozen at export time —
 * that frozen copy is what `replay-gate` compares against later runs.
 */
export function exportRunEventReplay(
  runEvents: readonly RunEventExportInput[],
  options: ExportRunEventReplayOptions = {}
): IncidentReplayFixture {
  assertExportable(runEvents);
  const events = ordered(runEvents);
  const runId = events[0]!.runId;

  // The projection must be able to rebuild the row, otherwise the fixture would
  // freeze an expectation nobody can ever reproduce.
  const run = rebuildRunFromEvents(events);

  return {
    fixtureVersion: INCIDENT_REPLAY_FIXTURE_VERSION,
    name: options.name ?? `incident-${runId}`,
    ...(options.description ? { description: options.description } : {}),
    source: { runId, table: "run_events", eventCount: events.length },
    events,
    expected: {
      input: run.input,
      steps: deriveRunSteps(events),
      sideEffects: deriveRunSideEffects(events),
      run
    }
  };
}

/** Deterministic JSON for comparisons: object keys sorted, array order kept. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export interface IncidentReplayOutcome {
  run: Run;
  steps: string[];
  sideEffects: ReplaySideEffect[];
  eventCount: number;
}

/**
 * Re-run one fixture: validate it, then project its log back to a `runs` row.
 * Fail-closed — a fixture that no longer satisfies the schema, holds more than
 * one run, or disagrees with its own `source` rejects instead of degrading.
 */
export function replayIncidentFixture(
  fixture: IncidentReplayFixture
): IncidentReplayOutcome {
  const parsed = incidentReplayFixtureSchema.parse(fixture);
  const events = parsed.events.map((event) => ({ ...event }));
  assertExportable(events);
  if (parsed.source.runId !== events[0]!.runId) {
    throw new Error(
      `Fixture source run '${parsed.source.runId}' does not match its events '${events[0]!.runId}'`
    );
  }
  if (parsed.source.eventCount !== events.length) {
    throw new Error(
      `Fixture source claims ${parsed.source.eventCount} events but carries ${events.length}`
    );
  }
  return {
    run: rebuildRunFromEvents(events),
    steps: deriveRunSteps(events),
    sideEffects: deriveRunSideEffects(events),
    eventCount: events.length
  };
}

export interface IncidentReplayReport {
  ok: boolean;
  mismatches: string[];
}

/**
 * The `replay-gate` assertion body (the CI job itself is still unauthorized).
 * Every expectation the fixture declares — input, step sequence, side-effect
 * set, terminal run — must be reproducible from the stored log alone.
 */
export function verifyIncidentReplay(fixture: IncidentReplayFixture): IncidentReplayReport {
  const parsed = incidentReplayFixtureSchema.safeParse(fixture);
  if (!parsed.success) {
    return {
      ok: false,
      mismatches: parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`
      )
    };
  }

  let outcome: IncidentReplayOutcome;
  try {
    outcome = replayIncidentFixture(parsed.data);
  } catch (error) {
    return { ok: false, mismatches: [`replay rejected: ${(error as Error).message}`] };
  }

  const expected = parsed.data.expected;
  const mismatches: string[] = [];
  if (stableStringify(outcome.run.input) !== stableStringify(expected.input)) {
    mismatches.push("input: replayed run input differs from the fixture's expectation");
  }
  if (stableStringify(outcome.steps) !== stableStringify(expected.steps)) {
    mismatches.push(
      `steps: replayed ${JSON.stringify(outcome.steps)} != expected ${JSON.stringify(expected.steps)}`
    );
  }
  if (stableStringify(outcome.sideEffects) !== stableStringify(expected.sideEffects)) {
    mismatches.push(
      `sideEffects: log evidences ${JSON.stringify(outcome.sideEffects)} != expected ${JSON.stringify(expected.sideEffects)}`
    );
  }
  if (stableStringify(outcome.run) !== stableStringify(runSchema.parse(expected.run))) {
    mismatches.push("run: replayed terminal state differs from the expected run");
  }
  return { ok: mismatches.length === 0, mismatches };
}

/** Fixture object → the JSON text written to `__fixtures__/incidents/`. */
export function serializeIncidentReplayFixture(fixture: IncidentReplayFixture): string {
  return `${JSON.stringify(fixture, null, 2)}\n`;
}
