import { randomUUID } from "node:crypto";
import { and, asc, eq, lte, or } from "drizzle-orm";

import { outboxDeliveryAttempts, outboxEvents, type Database } from "@neuroclaw/db";
import {
  canonicalJson,
  outboxDeliveryPayloadSchema,
  sha256Hex,
  type OutboxDeliveryEnvelope,
  type OutboxDeliveryTransportKind,
  type OutboxTransport
} from "@neuroclaw/shared";

/**
 * W2 delivery dispatcher (B1 §2) — core of the real delivery path, shipped
 * **default-off**.
 *
 * Boundaries (GM 2026-09-27): this slice implements the store (claim /
 * eligibility / attempt journal), the dispatcher, the idempotency key and the
 * injectable transport seam. It never opens a real network connection: the only
 * transports that exist are injected fakes; registering a real webhook/SMTP
 * transport throws (`registerRealOutboxTransport`). Enabling the dispatcher
 * requires the explicit `NEUROCLAW_OUTBOX_DISPATCH_ENABLED=1` switch.
 *
 * Design notes:
 *   * The Outbox keeps its frozen 5-state contract; retry scheduling lives in
 *     `outbox_delivery_attempts` (migration 0012). A failed attempt with
 *     attempts left keeps the event PROCESSING and relies on the 60s
 *     single-writer lease + `next_attempt_at` backoff for reclaim (mirrors
 *     `recoverStaleJobs`, no SKIP LOCKED dependency).
 *   * Idempotency: before delivering, the dispatcher refuses a key that already
 *     has a succeeded attempt (DB partial unique backs this up); replay never
 *     resurrects a FAILED row — it appends a new event with a `:replay:` key.
 */

type OutboxEventRow = typeof outboxEvents.$inferSelect;
type OutboxDeliveryAttemptRow = typeof outboxDeliveryAttempts.$inferSelect;

export const OUTBOX_DISPATCH_ENABLED_ENV = "NEUROCLAW_OUTBOX_DISPATCH_ENABLED";
export const OUTBOX_MAX_ATTEMPTS_ENV = "NEUROCLAW_OUTBOX_MAX_ATTEMPTS";
export const OUTBOX_MAX_ATTEMPTS_DEFAULT = 5;
export const OUTBOX_DISPATCH_LEASE_MS_DEFAULT = 60_000;
export const OUTBOX_DISPATCH_BATCH_SIZE_DEFAULT = 20;
export const OUTBOX_RETRY_BASE_MS = 30_000;
export const OUTBOX_RETRY_MAX_MS = 30 * 60_000;
/** W2 §2.4 driver cadence (injectable; tests override it). */
export const OUTBOX_DISPATCH_INTERVAL_MS_DEFAULT = 5_000;

export interface OutboxDispatchConfig {
  /** Kill switch: only the literal `"1"` enables dispatch. Default: off. */
  enabled: boolean;
  maxAttempts: number;
}

export function resolveOutboxDispatchConfig(
  env: Record<string, string | undefined> = process.env
): OutboxDispatchConfig {
  const parsed = Number.parseInt(env[OUTBOX_MAX_ATTEMPTS_ENV] ?? "", 10);
  const maxAttempts = Number.isInteger(parsed) && parsed > 0 ? parsed : OUTBOX_MAX_ATTEMPTS_DEFAULT;
  return { enabled: env[OUTBOX_DISPATCH_ENABLED_ENV] === "1", maxAttempts };
}

/** Normalizes ISO strings / Date values coming back from PGlite or node-postgres. */
function toEpochMs(value: unknown): number | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * F1 fix: mirror the replayed event key into its persisted delivery intent.
 *
 * The dispatcher refuses to deliver when `deliveryIntent.idempotencyKey` does
 * not equal `outbox_events.idempotency_key` (anti-tamper, `processOne`). A
 * replay suffixes the event key, so the payload must be rewritten with the
 * *same* suffixed key or the replayed event can never be delivered. Non
 * delivery payloads (no parseable `deliveryIntent`) are copied untouched; all
 * other intent fields, including the original base key lineage, are preserved.
 */
function recomputeReplayPayload(payloadText: string, idempotencyKey: string): string {
  const parsed = outboxDeliveryPayloadSchema.safeParse(parseJson(payloadText));
  if (!parsed.success) return payloadText;
  return JSON.stringify({
    deliveryIntent: { ...parsed.data.deliveryIntent, idempotencyKey }
  });
}

export type OutboxDispatchReason =
  | "eligible"
  | "terminal"
  | "already-succeeded"
  | "max-attempts"
  | "lease-active"
  | "backoff";

export interface OutboxDispatchEligibility {
  dispatch: boolean;
  reason: OutboxDispatchReason;
}

/**
 * Pure claim predicate. An event is dispatchable when it is PENDING, or
 * PROCESSING whose lease expired; it is not already succeeded, has attempts
 * left, and is past its latest backoff (`next_attempt_at`).
 */
export function shouldDispatchOutboxEvent(
  event: Pick<OutboxEventRow, "status" | "updatedAt">,
  state: {
    attempts: readonly Pick<OutboxDeliveryAttemptRow, "status" | "nextAttemptAt">[];
    maxAttempts: number;
    now: Date;
    leaseMs: number;
  }
): OutboxDispatchEligibility {
  if (event.status !== "PENDING" && event.status !== "PROCESSING") {
    return { dispatch: false, reason: "terminal" };
  }
  if (state.attempts.some((attempt) => attempt.status === "succeeded")) {
    return { dispatch: false, reason: "already-succeeded" };
  }
  if (state.attempts.length >= state.maxAttempts) {
    return { dispatch: false, reason: "max-attempts" };
  }
  if (event.status === "PROCESSING") {
    const leaseAcquiredAt = toEpochMs(event.updatedAt);
    if (leaseAcquiredAt !== null && leaseAcquiredAt > state.now.getTime() - state.leaseMs) {
      return { dispatch: false, reason: "lease-active" };
    }
  }
  const latest = state.attempts[state.attempts.length - 1];
  const nextAttemptAt = toEpochMs(latest?.nextAttemptAt);
  if (nextAttemptAt !== null && nextAttemptAt > state.now.getTime()) {
    return { dispatch: false, reason: "backoff" };
  }
  return { dispatch: true, reason: "eligible" };
}

/** B1 §2.6: `min(30s * 2^(N-1), 30min)` with ±20% jitter (injectable for tests). */
export function computeOutboxRetryDelayMs(
  attemptNumber: number,
  jitter?: (delayMs: number) => number
): number {
  const base = Math.min(
    OUTBOX_RETRY_BASE_MS * 2 ** Math.max(attemptNumber - 1, 0),
    OUTBOX_RETRY_MAX_MS
  );
  const jittered = jitter ? jitter(base) : base * (0.8 + Math.random() * 0.4);
  return Math.max(1, Math.round(jittered));
}

/** DB-facing half of the dispatcher: claim, attempt journal, terminal marks, replay. */
export class OutboxDeliveryStore {
  constructor(private readonly db: Database) {}

  /** Attempt rows for one event, ordered by `attempt_number`. */
  async listAttempts(eventId: string): Promise<OutboxDeliveryAttemptRow[]> {
    return this.db
      .select()
      .from(outboxDeliveryAttempts)
      .where(eq(outboxDeliveryAttempts.eventId, eventId))
      .orderBy(asc(outboxDeliveryAttempts.attemptNumber));
  }

  /** Single event by id (replay route: 404/409 mapping + targeted dispatch). */
  async getEvent(eventId: string): Promise<OutboxEventRow | null> {
    const rows = await this.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventId, eventId))
      .limit(1);
    return rows[0] ?? null;
  }

  async hasSucceededAttemptForKey(idempotencyKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: outboxDeliveryAttempts.id })
      .from(outboxDeliveryAttempts)
      .where(
        and(
          eq(outboxDeliveryAttempts.idempotencyKey, idempotencyKey),
          eq(outboxDeliveryAttempts.status, "succeeded")
        )
      )
      .limit(1);
    return rows.length > 0;
  }

  /** PENDING events plus PROCESSING events whose single-writer lease expired. */
  async listCandidates(now: Date, leaseMs: number, limit: number): Promise<OutboxEventRow[]> {
    const leaseCutoff = new Date(now.getTime() - leaseMs).toISOString();
    return this.db
      .select()
      .from(outboxEvents)
      .where(
        or(
          eq(outboxEvents.status, "PENDING"),
          and(eq(outboxEvents.status, "PROCESSING"), lte(outboxEvents.updatedAt, leaseCutoff))
        )
      )
      .orderBy(asc(outboxEvents.createdAt))
      .limit(limit);
  }

  /** PENDING → PROCESSING, or lease renewal for a stale PROCESSING event. */
  async claim(eventId: string, nowIso: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: "PROCESSING", updatedAt: nowIso })
      .where(
        and(
          eq(outboxEvents.eventId, eventId),
          or(eq(outboxEvents.status, "PENDING"), eq(outboxEvents.status, "PROCESSING"))
        )
      );
  }

  async recordAttemptStarted(input: {
    eventId: string;
    idempotencyKey: string;
    attemptNumber: number;
    transport: OutboxDeliveryTransportKind;
    requestHash: string;
    startedAt: string;
  }): Promise<string> {
    const id = `outbox_attempt_${randomUUID()}`;
    await this.db.insert(outboxDeliveryAttempts).values({ ...input, id, status: "started" });
    return id;
  }

  async recordAttemptFinished(
    attemptId: string,
    patch: {
      status: "succeeded" | "failed";
      httpStatus?: number;
      error?: string;
      endedAt: string;
      nextAttemptAt?: string;
    }
  ): Promise<void> {
    await this.db
      .update(outboxDeliveryAttempts)
      .set({
        status: patch.status,
        httpStatus: patch.httpStatus ?? null,
        error: patch.error ?? null,
        endedAt: patch.endedAt,
        nextAttemptAt: patch.nextAttemptAt ?? null
      })
      .where(eq(outboxDeliveryAttempts.id, attemptId));
  }

  async markCompleted(eventId: string, nowIso: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: "COMPLETED", updatedAt: nowIso })
      .where(eq(outboxEvents.eventId, eventId));
  }

  async markDeadLettered(eventId: string, nowIso: string): Promise<void> {
    await this.db
      .update(outboxEvents)
      .set({ status: "FAILED", updatedAt: nowIso })
      .where(eq(outboxEvents.eventId, eventId));
  }

  /**
   * Dead-letter replay (B1 §2.3): FAILED is terminal, so replay appends a new
   * event — new `eventId`, `idempotencyKey` suffixed with `:replay:{nonce}`,
   * `causationId` = old eventId — and never touches the old row.
   *
   * F1 fix (2026-09-27): the replayed event key must also be mirrored into the
   * persisted `deliveryIntent.idempotencyKey` (see `recomputeReplayPayload`).
   * The dispatcher rejects any intent whose key differs from the outbox key as
   * tampered; without the mirror, every replay dead-lettered on its first
   * dispatch pass (`transportCalls=0`).
   */
  async replay(eventId: string, now: Date = new Date()): Promise<OutboxEventRow> {
    const previous = await this.getEvent(eventId);
    if (!previous) throw new Error(`Outbox event not found: ${eventId}`);
    if (previous.status !== "FAILED") {
      throw new Error(
        `Only FAILED outbox events can be replayed; '${eventId}' is ${previous.status}`
      );
    }
    const nowIso = now.toISOString();
    const idempotencyKey = `${previous.idempotencyKey}:replay:${randomUUID()}`;
    const replayed: OutboxEventRow = {
      ...previous,
      eventId: `outbox_${randomUUID()}`,
      idempotencyKey,
      payload: recomputeReplayPayload(previous.payload, idempotencyKey),
      causationId: previous.eventId,
      status: "PENDING",
      createdAt: nowIso,
      updatedAt: nowIso
    };
    await this.db.insert(outboxEvents).values(replayed);
    return replayed;
  }
}

export interface OutboxDispatcherOptions {
  db: Database;
  transport: OutboxTransport;
  /** Default false — the kill switch. Only an explicit true enables dispatch. */
  enabled?: boolean;
  maxAttempts?: number;
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
  /** Deterministic backoff for tests; production default applies ±20% jitter. */
  jitter?: (delayMs: number) => number;
}

export interface OutboxDispatchBatchResult {
  disabled: boolean;
  scanned: number;
  delivered: number;
  retried: number;
  failed: number;
  skipped: number;
  /** Payload/key contract violations observed this batch (never delivered). */
  errors: string[];
}

export class OutboxDispatcher {
  readonly store: OutboxDeliveryStore;
  private readonly transport: OutboxTransport;
  private readonly enabled: boolean;
  private readonly maxAttempts: number;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly jitter?: (delayMs: number) => number;

  constructor(options: OutboxDispatcherOptions) {
    this.store = new OutboxDeliveryStore(options.db);
    this.transport = options.transport;
    this.enabled = options.enabled ?? false;
    this.maxAttempts = options.maxAttempts ?? OUTBOX_MAX_ATTEMPTS_DEFAULT;
    this.leaseMs = options.leaseMs ?? OUTBOX_DISPATCH_LEASE_MS_DEFAULT;
    this.batchSize = options.batchSize ?? OUTBOX_DISPATCH_BATCH_SIZE_DEFAULT;
    this.now = options.now ?? (() => new Date());
    this.jitter = options.jitter;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private newBatchResult(): OutboxDispatchBatchResult {
    return {
      disabled: !this.enabled,
      scanned: 0,
      delivered: 0,
      retried: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };
  }

  /**
   * One drain pass. Disabled dispatcher is a strict no-op: no claim, no
   * transport call, no status change.
   */
  async processBatch(): Promise<OutboxDispatchBatchResult> {
    const result = this.newBatchResult();
    if (!this.enabled) return result;

    const now = this.now();
    const candidates = await this.store.listCandidates(now, this.leaseMs, this.batchSize);
    result.scanned = candidates.length;
    for (const event of candidates) {
      await this.processOne(event, now, result);
    }
    return result;
  }

  /**
   * Deliver one specific event now — the manual replay path's immediate
   * attempt. Same eligibility/claim/journal/terminal semantics as
   * `processBatch`, scoped to `eventId`; `null` when the event no longer
   * exists (the replay route maps that to 404 before calling this).
   */
  async dispatchEvent(eventId: string): Promise<OutboxDispatchBatchResult | null> {
    const result = this.newBatchResult();
    if (!this.enabled) return result;

    const event = await this.store.getEvent(eventId);
    if (!event) return null;
    result.scanned = 1;
    await this.processOne(event, this.now(), result);
    return result;
  }

  private async processOne(
    event: OutboxEventRow,
    now: Date,
    result: OutboxDispatchBatchResult
  ): Promise<void> {
    const nowIso = now.toISOString();
    const attempts = await this.store.listAttempts(event.eventId);
    const eligibility = shouldDispatchOutboxEvent(event, {
      attempts,
      maxAttempts: this.maxAttempts,
      now,
      leaseMs: this.leaseMs
    });
    if (!eligibility.dispatch) {
      if (eligibility.reason === "max-attempts" && event.status === "PROCESSING") {
        // Attempts exhausted while the event never got a terminal mark (crash
        // window): enforce the dead-letter here.
        await this.store.markDeadLettered(event.eventId, nowIso);
        result.failed += 1;
      } else {
        result.skipped += 1;
      }
      return;
    }

    await this.store.claim(event.eventId, nowIso);
    const attemptNumber = attempts.length + 1;

    const payload = outboxDeliveryPayloadSchema.safeParse(parseJson(event.payload));
    if (!payload.success) {
      // No transport was ever invoked, so no attempt row exists; retrying an
      // unparseable payload can never succeed — dead-letter it and surface the
      // reason in the batch result.
      await this.store.markDeadLettered(event.eventId, nowIso);
      result.failed += 1;
      result.errors.push(`Invalid delivery payload for '${event.eventId}'`);
      return;
    }
    const intent = payload.data.deliveryIntent;
    if (intent.idempotencyKey !== event.idempotencyKey) {
      await this.store.markDeadLettered(event.eventId, nowIso);
      result.failed += 1;
      result.errors.push(
        `Delivery intent key '${intent.idempotencyKey}' does not match outbox key '${event.idempotencyKey}' (event '${event.eventId}')`
      );
      return;
    }

    // Cross-event guard: the same content key must never be delivered twice.
    if (await this.store.hasSucceededAttemptForKey(intent.idempotencyKey)) {
      await this.store.markCompleted(event.eventId, nowIso);
      result.skipped += 1;
      return;
    }

    const envelope: OutboxDeliveryEnvelope = {
      eventId: event.eventId,
      idempotencyScope: event.idempotencyScope,
      idempotencyKey: intent.idempotencyKey,
      transport: intent.transport,
      attemptNumber,
      body: intent.body
    };
    const attemptId = await this.store.recordAttemptStarted({
      eventId: event.eventId,
      idempotencyKey: intent.idempotencyKey,
      attemptNumber,
      transport: intent.transport,
      requestHash: sha256Hex(canonicalJson(intent.body)),
      startedAt: nowIso
    });

    let receipt;
    try {
      receipt = await this.transport.deliver(envelope);
    } catch (error) {
      const outcome = await this.recordFailure(
        event,
        attemptId,
        attemptNumber,
        error,
        now,
        undefined
      );
      result[outcome] += 1;
      return;
    }

    if (receipt.ok) {
      try {
        await this.store.recordAttemptFinished(attemptId, {
          status: "succeeded",
          httpStatus: receipt.httpStatus,
          endedAt: this.now().toISOString()
        });
      } catch (error) {
        // Database-level key guard: a successful delivery for this key already
        // exists (concurrent dispatcher). The delivery is already done — mark
        // the event COMPLETED and record it as skipped, never retry.
        if (await this.store.hasSucceededAttemptForKey(intent.idempotencyKey)) {
          await this.store.markCompleted(event.eventId, this.now().toISOString());
          result.skipped += 1;
          return;
        }
        throw error;
      }
      await this.store.markCompleted(event.eventId, this.now().toISOString());
      result.delivered += 1;
      return;
    }

    const rejection = new Error(
      `Transport rejected delivery${receipt.detail ? `: ${receipt.detail}` : ""}`
    );
    const outcome = await this.recordFailure(
      event,
      attemptId,
      attemptNumber,
      rejection,
      now,
      receipt.httpStatus
    );
    result[outcome] += 1;
  }

  /**
   * Journal the finished attempt and decide retry vs dead-letter. On retry the
   * event stays PROCESSING: the lease + `next_attempt_at` make it reclaimable
   * by the next pass (PROCESSING → PENDING is not in the frozen contract).
   */
  private async recordFailure(
    event: OutboxEventRow,
    attemptId: string,
    attemptNumber: number,
    error: unknown,
    now: Date,
    httpStatus: number | undefined
  ): Promise<"retried" | "failed"> {
    const endedAt = this.now().toISOString();
    const exhausted = attemptNumber >= this.maxAttempts;
    await this.store.recordAttemptFinished(attemptId, {
      status: "failed",
      httpStatus,
      error: error instanceof Error ? error.message : String(error),
      endedAt,
      ...(exhausted
        ? {}
        : {
            nextAttemptAt: new Date(
              now.getTime() + computeOutboxRetryDelayMs(attemptNumber, this.jitter)
            ).toISOString()
          })
    });
    if (exhausted) {
      await this.store.markDeadLettered(event.eventId, endedAt);
      return "failed";
    }
    return "retried";
  }
}

export interface OutboxDispatchDriverOptions {
  db: Database;
  transport: OutboxTransport;
  /** Kill switch: only an explicit `true` arms the interval (default false). */
  enabled?: boolean;
  /** Timer cadence; defaults to `OUTBOX_DISPATCH_INTERVAL_MS_DEFAULT`. */
  intervalMs?: number;
  maxAttempts?: number;
  leaseMs?: number;
  batchSize?: number;
  /** Injectable clock (retry/lease math); defaults to wall clock. */
  now?: () => Date;
  jitter?: (delayMs: number) => number;
  onBatch?: (result: OutboxDispatchBatchResult) => void;
  onError?: (error: unknown) => void;
}

export interface OutboxDispatchDriver {
  readonly dispatcher: OutboxDispatcher;
  /** True while the interval timer is armed (false == default-off / stopped). */
  readonly isRunning: boolean;
  /**
   * Run one batch immediately (ops/test seam, independent of the timer).
   * Returns `null` when a previous tick is still in flight.
   */
  tick(): Promise<OutboxDispatchBatchResult | null>;
  /** Idempotent: clears the interval; in-flight ticks are left to finish. */
  stop(): void;
}

/**
 * W2 §2.4 periodic driver: the `setInterval` loop the control-plane server
 * runs alongside the job loop, wired in `server.ts`. Default-off — the timer
 * only arms on an explicit `enabled: true`, which the server derives from the
 * `NEUROCLAW_OUTBOX_DISPATCH_ENABLED === "1"` kill switch. `now` and
 * `intervalMs` are injectable so tests can drive dispatches deterministically
 * without wall-clock waits.
 */
export function startOutboxDispatchDriver(
  options: OutboxDispatchDriverOptions
): OutboxDispatchDriver {
  const dispatcher = new OutboxDispatcher({
    db: options.db,
    transport: options.transport,
    enabled: options.enabled ?? false,
    maxAttempts: options.maxAttempts,
    leaseMs: options.leaseMs,
    batchSize: options.batchSize,
    now: options.now,
    jitter: options.jitter
  });
  const intervalMs = options.intervalMs ?? OUTBOX_DISPATCH_INTERVAL_MS_DEFAULT;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  const tick = async (): Promise<OutboxDispatchBatchResult | null> => {
    if (ticking) return null;
    ticking = true;
    try {
      const result = await dispatcher.processBatch();
      options.onBatch?.(result);
      return result;
    } catch (error) {
      options.onError?.(error);
      return null;
    } finally {
      ticking = false;
    }
  };

  if (options.enabled === true) {
    timer = setInterval(() => {
      void tick();
    }, intervalMs);
    timer.unref?.();
  }

  return {
    dispatcher,
    get isRunning() {
      return timer !== null;
    },
    tick,
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}
