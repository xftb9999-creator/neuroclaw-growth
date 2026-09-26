import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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
  type OutboxEventInput,
  type OutboxTransport
} from "@neuroclaw/shared";

import { ControlPlaneService, IdempotencyConflictError } from "./index.js";
import { createApp, type App } from "./app.js";
import {
  OUTBOX_DISPATCH_ENABLED_ENV,
  OUTBOX_MAX_ATTEMPTS_DEFAULT,
  OUTBOX_MAX_ATTEMPTS_ENV,
  OutboxDeliveryStore,
  OutboxDispatcher,
  resolveOutboxDispatchConfig,
  startOutboxDispatchDriver
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

  it("⑤b F1 fix: a replayed event is deliverable — key mirrored into the payload intent", async () => {
    // P-E (acceptance probe) at unit level: replay → dispatch must reach
    // COMPLETED with exactly one transport call under the *new* key.
    const { db, service, store } = await setup();
    resetClock();
    const input = outboxInput();
    await service.enqueueOutboxEvent(input);

    const failing = new InMemoryTransport(() => {
      throw new Error("permanent transport failure");
    });
    const d1 = new OutboxDispatcher({
      db,
      transport: failing,
      enabled: true,
      maxAttempts: 1,
      now: clock,
      jitter: identityJitter
    });
    expect((await d1.processBatch()).failed).toBe(1);

    const replayed = await store.replay(input.eventId, clock());
    expect(replayed.idempotencyKey.startsWith(`${input.idempotencyKey}:replay:`)).toBe(true);

    const ok = new InMemoryTransport();
    const d2 = new OutboxDispatcher({ db, transport: ok, enabled: true, now: clock, jitter: identityJitter });
    const batch = await d2.processBatch();
    expect(batch).toMatchObject({ scanned: 1, delivered: 1, failed: 0, errors: [] });
    expect(ok.deliveries).toHaveLength(1);
    expect(ok.deliveries[0].eventId).toBe(replayed.eventId);
    expect(ok.deliveries[0].idempotencyKey).toBe(replayed.idempotencyKey);

    const replayedRow = await store.getEvent(replayed.eventId);
    expect(replayedRow?.status).toBe("COMPLETED");
    const storedPayload = JSON.parse(replayedRow!.payload) as {
      deliveryIntent: { idempotencyKey: string; body: OutboxDeliveryBody };
    };
    expect(storedPayload.deliveryIntent.idempotencyKey).toBe(replayed.idempotencyKey);
    expect(storedPayload.deliveryIntent.body).toEqual(deliveryBody());

    // The old FAILED row stays untouched (append-only).
    expect((await store.getEvent(input.eventId))?.status).toBe("FAILED");
  });

  it("⑤c dispatchEvent targets exactly one event; unknown ids return null", async () => {
    const { db, service, store } = await setup();
    resetClock();
    const transport = new InMemoryTransport();
    const dispatcher = new OutboxDispatcher({ db, transport, enabled: true, now: clock });

    expect(await dispatcher.dispatchEvent("evt_w2_missing")).toBeNull();
    expect(transport.deliveries).toHaveLength(0);

    const first = outboxInput();
    const second = outboxInput(intentFor(deliveryBody({ draft: "targeted second event" })));
    await service.enqueueOutboxEvent(first);
    await service.enqueueOutboxEvent(second);

    const result = await dispatcher.dispatchEvent(second.eventId);
    expect(result).toMatchObject({ scanned: 1, delivered: 1 });
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0].eventId).toBe(second.eventId);
    expect((await store.getEvent(first.eventId))?.status).toBe("PENDING");
    expect((await store.getEvent(second.eventId))?.status).toBe("COMPLETED");

    // A disabled dispatcher is inert even for a targeted dispatch.
    const off = new OutboxDispatcher({ db, transport, now: clock });
    expect(await off.dispatchEvent(first.eventId)).toMatchObject({ disabled: true, scanned: 0 });
    expect(transport.deliveries).toHaveLength(1);
  });

  it("F2: undefined / omitted / empty recipientEmail normalize to one key", () => {
    const base = deliveryBody();
    const { recipientEmail: _omitted, ...withoutRecipient } = base;
    const explicitUndefined = buildOutboxDeliveryIntent({
      transport: "preview",
      body: { ...base, recipientEmail: undefined }
    });
    const emptyString = buildOutboxDeliveryIntent({
      transport: "preview",
      body: { ...base, recipientEmail: "" }
    });
    const omitted = buildOutboxDeliveryIntent({ transport: "preview", body: withoutRecipient });

    expect(explicitUndefined.idempotencyKey).toBe(omitted.idempotencyKey);
    expect(emptyString.idempotencyKey).toBe(omitted.idempotencyKey);
    // The normalized body drops the recipient segment entirely — producers and
    // dispatcher hand the same object to the transport.
    expect(explicitUndefined.body).toEqual(omitted.body);
    expect(emptyString.body).toEqual(omitted.body);
    // Normalization is not overreach: a real recipient still changes the key.
    const other = buildOutboxDeliveryIntent({
      transport: "preview",
      body: { ...base, recipientEmail: "other@example.com" }
    });
    expect(other.idempotencyKey).not.toBe(omitted.idempotencyKey);
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

  it("⑥b driver: default-off never arms; stop() disarms; manual tick obeys the switch", async () => {
    const { db, service } = await setup();
    resetClock();
    await service.enqueueOutboxEvent(outboxInput());
    const transport = new InMemoryTransport();

    const off = startOutboxDispatchDriver({ db, transport, now: clock });
    expect(off.isRunning).toBe(false);
    expect(await off.tick()).toMatchObject({ disabled: true, scanned: 0, delivered: 0 });
    expect(transport.deliveries).toHaveLength(0);
    off.stop();
    expect(off.isRunning).toBe(false);

    const on = startOutboxDispatchDriver({
      db,
      transport,
      enabled: true,
      intervalMs: 60_000, // long cadence: the wall-clock timer never fires in-test
      now: clock,
      jitter: identityJitter
    });
    expect(on.isRunning).toBe(true);
    expect(await on.tick()).toMatchObject({ delivered: 1 });
    expect(transport.deliveries).toHaveLength(1);
    expect(await on.tick()).toMatchObject({ scanned: 0 });

    on.stop();
    expect(on.isRunning).toBe(false);
    on.stop(); // idempotent
    expect(on.isRunning).toBe(false);
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

// ---------------------------------------------------------------------------
// W2 §2.3 replay route (GM routing ruling 2026-09-27): admin-only
// `outbox:replay`; kill switch off → 503; unknown → 404; non-FAILED → 409;
// success → 200 with the replayed identity + immediate dispatch result.
// ---------------------------------------------------------------------------

const originalApiKeys = process.env.NEUROCLAW_API_KEYS;
const originalDispatchEnabled = process.env[OUTBOX_DISPATCH_ENABLED_ENV];

function setDispatchEnabled(enabled: boolean): void {
  if (enabled) process.env[OUTBOX_DISPATCH_ENABLED_ENV] = "1";
  else delete process.env[OUTBOX_DISPATCH_ENABLED_ENV];
}

async function setupReplayApp(transport?: OutboxTransport): Promise<{
  app: App;
  service: ControlPlaneService;
  store: OutboxDeliveryStore;
  db: Database;
}> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db);
  const app = createApp(service, undefined, {}, { transport, now: clock });
  return { app, service, store: new OutboxDeliveryStore(db), db };
}

/** Enqueue one delivery event and dead-letter it (maxAttempts=1). */
async function seedFailedEvent(
  service: ControlPlaneService,
  db: Database
): Promise<OutboxEventInput> {
  const input = outboxInput();
  await service.enqueueOutboxEvent(input);
  const dispatcher = new OutboxDispatcher({
    db,
    transport: new InMemoryTransport(() => {
      throw new Error("seed: permanent failure");
    }),
    enabled: true,
    maxAttempts: 1,
    now: clock,
    jitter: identityJitter
  });
  expect((await dispatcher.processBatch()).failed).toBe(1);
  return input;
}

describe("W2 replay route · POST /api/outbox/:eventId/replay", () => {
  beforeAll(() => {
    process.env.NEUROCLAW_API_KEYS =
      "w2-admin-key:admin_w2:admin,w2-operator-key:operator_w2:operator,w2-viewer-key:viewer_w2:viewer";
  });

  afterAll(() => {
    if (originalApiKeys === undefined) delete process.env.NEUROCLAW_API_KEYS;
    else process.env.NEUROCLAW_API_KEYS = originalApiKeys;
    if (originalDispatchEnabled === undefined) delete process.env[OUTBOX_DISPATCH_ENABLED_ENV];
    else process.env[OUTBOX_DISPATCH_ENABLED_ENV] = originalDispatchEnabled;
  });

  const replayRequest = (app: App, eventId: string, key: string) =>
    app.request(`/api/outbox/${eventId}/replay`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` }
    });

  it("403: operator and viewer lack outbox:replay (admin-only)", async () => {
    setDispatchEnabled(true);
    const { app } = await setupReplayApp(new InMemoryTransport());
    for (const key of ["w2-operator-key", "w2-viewer-key"]) {
      const res = await replayRequest(app, "evt_w2_any", key);
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code: string }).code).toBe("AUTH_FORBIDDEN");
    }
  });

  it("503: kill switch off → fail-closed refusal before touching the store", async () => {
    setDispatchEnabled(false);
    const { app, service, store, db } = await setupReplayApp(new InMemoryTransport());
    const input = await seedFailedEvent(service, db);

    const res = await replayRequest(app, input.eventId, "w2-admin-key");
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("OUTBOX_DISPATCH_DISABLED");
    // No replay row was appended, no dispatch attempted.
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
    expect((await store.getEvent(input.eventId))?.status).toBe("FAILED");
  });

  it("404: unknown event id", async () => {
    setDispatchEnabled(true);
    const { app } = await setupReplayApp(new InMemoryTransport());
    const res = await replayRequest(app, "evt_w2_unknown", "w2-admin-key");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("OUTBOX_EVENT_NOT_FOUND");
  });

  it("409: only FAILED events are replayable (no resurrection of live rows)", async () => {
    setDispatchEnabled(true);
    const { app, service, store, db } = await setupReplayApp(new InMemoryTransport());
    const input = outboxInput();
    await service.enqueueOutboxEvent(input); // PENDING

    const res = await replayRequest(app, input.eventId, "w2-admin-key");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe("OUTBOX_REPLAY_CONFLICT");
    expect((await store.getEvent(input.eventId))?.status).toBe("PENDING");
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("200: FAILED event is replayed and delivered immediately exactly once", async () => {
    setDispatchEnabled(true);
    resetClock();
    const transport = new InMemoryTransport();
    const { app, service, store, db } = await setupReplayApp(transport);
    const input = await seedFailedEvent(service, db);

    const res = await replayRequest(app, input.eventId, "w2-admin-key");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      replayed: { eventId: string; idempotencyKey: string; causationId: string; status: string };
      dispatch: { scanned: number; delivered: number; failed: number; errors: string[] } | null;
    };
    expect(body.replayed.eventId).not.toBe(input.eventId);
    expect(body.replayed.causationId).toBe(input.eventId);
    expect(body.replayed.idempotencyKey.startsWith(`${input.idempotencyKey}:replay:`)).toBe(true);
    expect(body.replayed.status).toBe("COMPLETED");
    expect(body.dispatch).toMatchObject({ scanned: 1, delivered: 1, failed: 0, errors: [] });
    expect(transport.deliveries).toHaveLength(1);
    expect(transport.deliveries[0].eventId).toBe(body.replayed.eventId);
    expect(transport.deliveries[0].idempotencyKey).toBe(body.replayed.idempotencyKey);

    // Old row untouched; exactly one append.
    expect((await store.getEvent(input.eventId))?.status).toBe("FAILED");
    expect(await db.select().from(outboxEvents)).toHaveLength(2);
  });

  it("200: without an injected transport the replay is recorded but dispatch is null (no fake send)", async () => {
    setDispatchEnabled(true);
    resetClock();
    const { app, service, db } = await setupReplayApp();
    const input = await seedFailedEvent(service, db);

    const res = await replayRequest(app, input.eventId, "w2-admin-key");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replayed: { status: string }; dispatch: null };
    expect(body.replayed.status).toBe("PENDING");
    expect(body.dispatch).toBeNull();
  });
});
