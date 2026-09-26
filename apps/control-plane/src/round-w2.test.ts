import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  outboxDeliveryAttempts,
  outboxEvents,
  type Database
} from "@neuroclaw/db";
import {
  InMemoryTransport,
  OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
  RealOutboxTransportNotAuthorizedError,
  buildOutboxDeliveryIntent,
  registerRealOutboxTransport,
  type OutboxDeliveryBody,
  type OutboxEventInput
} from "@neuroclaw/shared";

import { ControlPlaneService, IdempotencyConflictError } from "./index.js";
import {
  OUTBOX_DISPATCH_ENABLED_ENV,
  OUTBOX_MAX_ATTEMPTS_DEFAULT,
  OUTBOX_MAX_ATTEMPTS_ENV,
  OutboxDeliveryStore,
  OutboxDispatcher,
  resolveOutboxDispatchConfig
} from "./outbox-dispatcher.js";

/**
 * W2 directed test — transactional Outbox dispatcher with idempotency.
 *
 * Pins the B1 §2 acceptance assertions (L93 ①–⑥) against the real PGlite
 * database with an injected in-memory transport. No real network/SMTP/webhook
 * is ever contacted: the only transports in this file are fakes, and the real
 * registration seam is asserted to throw.
 */

const T0_MS = Date.parse("2026-09-27T00:00:00Z");
let clockMs = T0_MS;
function resetClock(): void {
  clockMs = T0_MS;
}
function clock(): Date {
  return new Date(clockMs);
}
function advance(ms: number): void {
  clockMs += ms;
}

const openDatabases: Database[] = [];
afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

let sequence = 0;

function deliveryBody(overrides: Partial<OutboxDeliveryBody> = {}): OutboxDeliveryBody {
  return {
    runId: "run_w2_demo",
    templateType: "content_acquisition",
    actionType: "notify_lead",
    recipientEmail: "ops@example.com",
    draft: "W2 delivery body",
    ...overrides
  };
}

function intentFor(body: OutboxDeliveryBody) {
  return buildOutboxDeliveryIntent({ transport: "preview", body });
}

function outboxInput(
  deliveryIntent = intentFor(deliveryBody()),
  overrides: Partial<OutboxEventInput> = {}
): OutboxEventInput {
  sequence += 1;
  return {
    eventId: `evt_w2_${sequence}`,
    schemaVersion: "1.0",
    eventType: "growth.outbox.delivery_intent_recorded",
    occurredAt: "2026-09-27T00:00:00Z",
    emittedAt: "2026-09-27T00:00:00Z",
    scope: { projectId: "project_w2" },
    actorRef: "actor_w2",
    subjectRef: "run_w2_demo",
    correlationId: "corr_w2",
    idempotencyKey: deliveryIntent.idempotencyKey,
    idempotencyScope: OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
    traceId: "trace_w2",
    dataClass: "OPERATIONAL",
    payload: { deliveryIntent },
    status: "PENDING",
    ...overrides
  };
}

async function setup(): Promise<{
  db: Database;
  service: ControlPlaneService;
  store: OutboxDeliveryStore;
}> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db);
  return { db, service, store: new OutboxDeliveryStore(db) };
}

async function countPending(db: Database): Promise<number> {
  const rows = await db
    .select({ eventId: outboxEvents.eventId })
    .from(outboxEvents)
    .where(eq(outboxEvents.status, "PENDING"));
  return rows.length;
}

const identityJitter = (delayMs: number): number => delayMs;

describe("W2 outbox delivery dispatcher (B1 §2)", () => {
  it("① same idempotency key with a different payload throws IdempotencyConflictError", async () => {
    const { db, service } = await setup();
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);

    const conflicting = outboxInput(
      intentFor(deliveryBody({ draft: "changed content, same key" })),
      { eventId: "evt_w2_conflict", idempotencyKey: input.idempotencyKey }
    );
    await expect(service.enqueueOutboxEvent(conflicting)).rejects.toBeInstanceOf(
      IdempotencyConflictError
    );
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("② identical deliveryBody across repeated enqueues/batches → transport.deliver runs once", async () => {
    const { db, service } = await setup();
    resetClock();
    const payload = deliveryBody();
    const input = outboxInput(intentFor(payload));

    const first = await service.enqueueOutboxEvent(input);
    const duplicate = await service.enqueueOutboxEvent(input);
    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);
    expect(await db.select().from(outboxEvents)).toHaveLength(1);

    const transport = new InMemoryTransport();
    const dispatcher = new OutboxDispatcher({
      db,
      transport,
      enabled: true,
      now: clock,
      jitter: identityJitter
    });

    const r1 = await dispatcher.processBatch();
    const r2 = await dispatcher.processBatch();
    const r3 = await dispatcher.processBatch();
    expect(r1.delivered).toBe(1);
    expect(r2.scanned).toBe(0);
    expect(r3.scanned).toBe(0);
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0].idempotencyKey).toBe(input.idempotencyKey);
    expect(transport.deliveries[0].body).toEqual(payload);
    expect(transport.deliveries[0].attemptNumber).toBe(1);
    expect(transport.deliveries[0].idempotencyScope).toBe(OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE);
    expect((await db.select().from(outboxEvents))[0].status).toBe("COMPLETED");
  });

  it("③ first transport throw then success → COMPLETED, attempts = [failed, succeeded]", async () => {
    const { db, service, store } = await setup();
    resetClock();
    const transport = new InMemoryTransport((envelope) => {
      if (envelope.attemptNumber === 1) throw new Error("transport down");
      return { ok: true };
    });
    const dispatcher = new OutboxDispatcher({
      db,
      transport,
      enabled: true,
      maxAttempts: 3,
      leaseMs: 60_000,
      now: clock,
      jitter: identityJitter
    });
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);

    const first = await dispatcher.processBatch();
    expect(first.retried).toBe(1);
    expect((await db.select().from(outboxEvents))[0].status).toBe("PROCESSING");

    advance(61_000); // past the 60s lease and the 30s backoff
    const second = await dispatcher.processBatch();
    expect(second.delivered).toBe(1);

    const row = (await db.select().from(outboxEvents))[0];
    expect(row.status).toBe("COMPLETED");
    const attempts = await store.listAttempts(input.eventId);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNumber: 1, status: "failed" });
    expect(attempts[0].error).toContain("transport down");
    expect(attempts[0].nextAttemptAt).toBeTruthy();
    expect(attempts[1]).toMatchObject({ attemptNumber: 2, status: "succeeded" });
    expect(attempts.every((attempt) => attempt.transport === "preview")).toBe(true);
    expect(attempts.every((attempt) => /^[0-9a-f]{64}$/.test(attempt.requestHash))).toBe(true);
    expect(attempts[1].endedAt).toBeTruthy();
    expect(transport.deliveries.map((envelope) => envelope.attemptNumber)).toEqual([1, 2]);
  });

  it("④ maxAttempts reached → outbox FAILED and never claimed again", async () => {
    const { db, service, store } = await setup();
    resetClock();
    const transport = new InMemoryTransport(() => {
      throw new Error("smtp 550 permanent");
    });
    const dispatcher = new OutboxDispatcher({
      db,
      transport,
      enabled: true,
      maxAttempts: 2,
      leaseMs: 60_000,
      now: clock,
      jitter: identityJitter
    });
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);

    const first = await dispatcher.processBatch();
    expect(first.retried).toBe(1);
    advance(61_000);
    const second = await dispatcher.processBatch();
    expect(second.failed).toBe(1);
    expect((await db.select().from(outboxEvents))[0].status).toBe("FAILED");

    const attempts = await store.listAttempts(input.eventId);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.status)).toEqual(["failed", "failed"]);

    advance(61_000);
    const third = await dispatcher.processBatch();
    expect(third.scanned).toBe(0);
    expect(transport.deliveries).toHaveLength(2); // no third transport call
    expect((await db.select().from(outboxEvents))[0].status).toBe("FAILED");
  });

  it("⑤ replay appends a new eventId and leaves the FAILED row untouched", async () => {
    const { db, service, store } = await setup();
    resetClock();
    const dispatcher = new OutboxDispatcher({
      db,
      transport: new InMemoryTransport(() => {
        throw new Error("permanent transport failure");
      }),
      enabled: true,
      maxAttempts: 1,
      now: clock,
      jitter: identityJitter
    });
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);
    expect((await dispatcher.processBatch()).failed).toBe(1);

    const replayed = await store.replay(input.eventId);
    expect(replayed.eventId).not.toBe(input.eventId);
    expect(replayed.idempotencyKey.startsWith(`${input.idempotencyKey}:replay:`)).toBe(true);
    expect(replayed.causationId).toBe(input.eventId);
    expect(replayed.status).toBe("PENDING");

    const oldRow = (
      await db.select().from(outboxEvents).where(eq(outboxEvents.eventId, input.eventId))
    )[0];
    expect(oldRow.status).toBe("FAILED");

    // append-only and repeatable: a second replay yields another fresh identity
    const replayedAgain = await store.replay(input.eventId);
    expect(replayedAgain.eventId).not.toBe(replayed.eventId);
    expect(replayedAgain.idempotencyKey).not.toBe(replayed.idempotencyKey);
    // non-FAILED rows cannot be replayed (no resurrection)
    await expect(store.replay(replayed.eventId)).rejects.toThrow(/FAILED/);
  });

  it("⑥ default-off dispatcher is a strict no-op (kill switch)", async () => {
    const { db, service } = await setup();
    resetClock();
    await service.enqueueOutboxEvent(outboxInput());

    const transport = new InMemoryTransport();
    const dispatcher = new OutboxDispatcher({ db, transport, now: clock }); // enabled omitted
    expect(dispatcher.isEnabled).toBe(false);

    const before = await countPending(db);
    const result = await dispatcher.processBatch();
    expect(result.disabled).toBe(true);
    expect(result.scanned).toBe(0);
    expect(result.delivered).toBe(0);
    expect(transport.deliveries).toHaveLength(0);
    expect(await countPending(db)).toBe(before);

    // env switch semantics are pinned: only the literal "1" enables
    expect(resolveOutboxDispatchConfig({})).toEqual({
      enabled: false,
      maxAttempts: OUTBOX_MAX_ATTEMPTS_DEFAULT
    });
    expect(resolveOutboxDispatchConfig({ [OUTBOX_DISPATCH_ENABLED_ENV]: "1" }).enabled).toBe(true);
    expect(resolveOutboxDispatchConfig({ [OUTBOX_DISPATCH_ENABLED_ENV]: "true" }).enabled).toBe(
      false
    );
    expect(resolveOutboxDispatchConfig({ [OUTBOX_MAX_ATTEMPTS_ENV]: "2" }).maxAttempts).toBe(2);
    expect(resolveOutboxDispatchConfig({ [OUTBOX_MAX_ATTEMPTS_ENV]: "0" }).maxAttempts).toBe(
      OUTBOX_MAX_ATTEMPTS_DEFAULT
    );
  });

  it("malformed payload dead-letters without invoking the transport", async () => {
    const { db, service } = await setup();
    resetClock();
    const input = outboxInput();
    await service.enqueueOutboxEvent({ ...input, payload: { notAnIntent: true } });

    const transport = new InMemoryTransport();
    const dispatcher = new OutboxDispatcher({ db, transport, enabled: true, now: clock });
    const result = await dispatcher.processBatch();

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("Invalid delivery payload");
    expect(transport.deliveries).toHaveLength(0);
    expect((await db.select().from(outboxEvents))[0].status).toBe("FAILED");
    expect(await db.select().from(outboxDeliveryAttempts)).toHaveLength(0);
  });

  it("mutated intent key is rejected before the transport call", async () => {
    const { db, service } = await setup();
    resetClock();
    const baseIntent = intentFor(deliveryBody());
    const input = outboxInput(baseIntent);
    await service.enqueueOutboxEvent({
      ...input,
      payload: { deliveryIntent: { ...baseIntent, idempotencyKey: "run:tampered" } }
    });

    const transport = new InMemoryTransport();
    const dispatcher = new OutboxDispatcher({ db, transport, enabled: true, now: clock });
    const result = await dispatcher.processBatch();

    expect(result.failed).toBe(1);
    expect(result.errors[0]).toContain("does not match outbox key");
    expect(transport.deliveries).toHaveLength(0);
    expect((await db.select().from(outboxEvents))[0].status).toBe("FAILED");
  });

  it("database-level guards: one attempt per (key, attempt) and one succeeded per key", async () => {
    const { db, service, store } = await setup();
    resetClock();
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);
    const base = {
      eventId: input.eventId,
      idempotencyKey: input.idempotencyKey,
      transport: "preview" as const,
      requestHash: "0".repeat(64),
      startedAt: "2026-09-27T00:00:00Z"
    };

    const firstId = await store.recordAttemptStarted({ ...base, attemptNumber: 1 });
    await store.recordAttemptFinished(firstId, {
      status: "succeeded",
      endedAt: "2026-09-27T00:00:00Z"
    });

    // (idempotency_key, attempt_number) unique: no duplicate attempt row
    await expect(store.recordAttemptStarted({ ...base, attemptNumber: 1 })).rejects.toThrow();

    // partial unique on succeeded: a second success for the same key is rejected
    const secondId = await store.recordAttemptStarted({ ...base, attemptNumber: 2 });
    await expect(
      store.recordAttemptFinished(secondId, {
        status: "succeeded",
        endedAt: "2026-09-27T00:00:01Z"
      })
    ).rejects.toThrow();
    expect(await store.hasSucceededAttemptForKey(input.idempotencyKey)).toBe(true);
  });

  it("real transport registration is unauthorized and throws an explicit error", () => {
    expect(() => registerRealOutboxTransport("webhook", new InMemoryTransport())).toThrow(
      RealOutboxTransportNotAuthorizedError
    );
    expect(() => registerRealOutboxTransport("smtp", new InMemoryTransport())).toThrow(
      /未授权真实投递/
    );
  });
});
