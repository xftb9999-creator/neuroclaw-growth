import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { closeDatabase, createInMemoryDb, outboxEvents, type Database } from "@neuroclaw/db";
import {
  OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
  buildOutboxDeliveryIntent,
  type OutboxDeliveryBody,
  type OutboxDeliveryIntent,
  type OutboxEventInput,
  type Run
} from "@neuroclaw/shared";

import { ControlPlaneService, IdempotencyConflictError } from "./index.js";

/**
 * W2c directed test — B1 §2.5 "enqueue the delivery intent inside the same
 * transaction that writes the `runs` projection", gated by the §2.7 kill
 * switch (`NEUROCLAW_OUTBOX_DISPATCH_ENABLED === "1"` only).
 *
 * Covers the checkpoint C1→C2 completion: `collectRunDeliveryIntents` +
 * `persistRunProjection` and the three real call sites (inline createRun
 * insert, durable job loop update, inline approval resume update). Zero real
 * network: `fetch` is stubbed to throw, the dispatcher is never armed, and
 * only enqueue-side behavior is asserted.
 */

const ENV_SNAPSHOT = { ...process.env };
const NOW = "2026-09-27T00:00:00Z";
const SWITCH_ENV = "NEUROCLAW_OUTBOX_DISPATCH_ENABLED";
const WEBHOOK_ENV = "NEUROCLAW_DELIVERY_WEBHOOK_URL";

const openDatabases: Database[] = [];
let sequence = 0;

beforeEach(() => {
  delete process.env[SWITCH_ENV];
  delete process.env[WEBHOOK_ENV];
});

afterEach(async () => {
  process.env = { ...ENV_SNAPSHOT };
  vi.unstubAllGlobals();
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(options: { durable?: boolean } = {}): Promise<{
  db: Database;
  service: ControlPlaneService;
}> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db, undefined, undefined, {
    durable: options.durable ?? false
  });
  return { db, service };
}

function deliveryBody(overrides: Partial<OutboxDeliveryBody> = {}): OutboxDeliveryBody {
  return {
    runId: `run_w2c_${sequence}`,
    templateType: "private_conversion",
    actionType: "notification_send_preview",
    recipientEmail: "ops@example.com",
    draft: "W2c synthetic delivery body",
    ...overrides
  };
}

/**
 * A completed run carrying one adapter-recorded intent, exactly as the
 * runtime-worker notification adapter emits it in intent mode
 * (`stepResult.payload.deliveryIntent`).
 */
function syntheticRunWithIntent(): {
  run: Run;
  intent: OutboxDeliveryIntent;
  body: OutboxDeliveryBody;
} {
  sequence += 1;
  const runId = `run_w2c_syn_${sequence}`;
  const body = deliveryBody({ runId });
  const intent = buildOutboxDeliveryIntent({ transport: "webhook", body });
  const run: Run = {
    id: runId,
    workspaceId: `ws_w2c_syn_${sequence}`,
    templateType: "private_conversion",
    status: "completed",
    input: {
      businessSummary: "W2c synthetic",
      targetCustomer: "Warm leads",
      preferredChannels: ["email"],
      offerAsset: "VIP audit"
    },
    currentStep: null,
    approvalStatus: "approved",
    createdAt: NOW,
    updatedAt: NOW,
    stepResults: [
      {
        stepId: "preview-send",
        actionType: "notification_send_preview",
        status: "completed",
        summary: "Recorded webhook delivery intent for outbox dispatch",
        payload: { approvalPreview: body.draft, deliveryIntent: intent }
      }
    ]
  };
  return { run, intent, body };
}

/** The exact webhook intent the durable private_conversion resume emits. */
function expectedResumeIntent(run: Run): OutboxDeliveryIntent {
  return buildOutboxDeliveryIntent({
    transport: "webhook",
    body: {
      runId: run.id,
      templateType: "private_conversion",
      actionType: "notification_send_preview",
      recipientEmail: "owner@example.com",
      draft: "Conversion message for VIP audit"
    }
  });
}

async function createConversionRun(
  service: ControlPlaneService,
  label: string
): Promise<Run> {
  const workspace = await service.createWorkspace({ name: label, plan: "growth" }, "op_w2c");
  return service.createRun({
    workspaceId: workspace.id,
    templateType: "private_conversion",
    input: {
      businessSummary: "W2c conversion",
      targetCustomer: "Warm inbound leads",
      preferredChannels: ["email"],
      offerAsset: "VIP audit",
      recipientEmail: "owner@example.com"
    }
  });
}

describe("W2c: transactional delivery-intent enqueue on the runs projection", () => {
  it("① kill switch: every non-\"1\" form leaves the outbox empty", async () => {
    const { db, service } = await setup();
    const nonEnabledForms: Array<string | undefined> = [
      undefined,
      "",
      "0",
      "true",
      "TRUE",
      "yes",
      "01",
      "1 ",
      " 1",
      "on"
    ];

    for (const value of nonEnabledForms) {
      if (value === undefined) delete process.env[SWITCH_ENV];
      else process.env[SWITCH_ENV] = value;

      const { run } = syntheticRunWithIntent();
      await service.persistRunProjection(run, "insert");

      // The projection write itself is unaffected by the switch.
      expect((await service.getRun(run.id)).status).toBe("completed");
    }

    expect(await db.select().from(outboxEvents)).toHaveLength(0);
  });

  it("② switch \"1\": exactly one outbox row, key and payload equal to buildOutboxDeliveryIntent", async () => {
    const { db, service } = await setup();
    process.env[SWITCH_ENV] = "1";
    const { run, intent, body } = syntheticRunWithIntent();

    await service.persistRunProjection(run, "insert");

    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.idempotencyScope).toBe(OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE);
    expect(row.idempotencyKey).toBe(intent.idempotencyKey);
    // "byte-for-byte": the persisted key is the builder's key, not a re-derived copy.
    expect(row.idempotencyKey).toBe(
      buildOutboxDeliveryIntent({ transport: "webhook", body }).idempotencyKey
    );
    expect(row.eventType).toBe("growth.outbox.delivery_intent_recorded");
    expect(row.subjectRef).toBe(run.id);
    expect(row.correlationId).toBe(run.id);
    expect(row.status).toBe("PENDING");
    expect(JSON.parse(row.scope)).toEqual({ workspaceId: run.workspaceId });
    expect(JSON.parse(row.payload)).toEqual({ deliveryIntent: intent });

    // The runs projection committed in the same transaction.
    const persisted = await service.getRun(run.id);
    expect(persisted.stepResults).toEqual(run.stepResults);
  });

  it("③ re-processing the same intent is idempotent — still exactly one row", async () => {
    const { db, service } = await setup();
    process.env[SWITCH_ENV] = "1";
    const { run, intent } = syntheticRunWithIntent();

    await service.persistRunProjection(run, "insert");
    expect(await db.select().from(outboxEvents)).toHaveLength(1);

    // A retried/resumed job re-emitting the same outcome updates the run but
    // must not append a second outbox event.
    await service.persistRunProjection(
      { ...run, updatedAt: "2026-09-27T01:00:00.000Z" },
      "update"
    );
    expect(await db.select().from(outboxEvents)).toHaveLength(1);

    // Even two identical intents inside one scan dedupe to a single row.
    const duplicated: Run = {
      ...run,
      stepResults: [run.stepResults![0], run.stepResults![0]]
    };
    await service.persistRunProjection(duplicated, "update");

    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyKey).toBe(intent.idempotencyKey);
  });

  it("④ same key bound to a different intent → processNextJob rejects and rolls the enqueue back", async () => {
    const { db, service } = await setup({ durable: true });
    process.env[SWITCH_ENV] = "1";
    process.env[WEBHOOK_ENV] = "http://127.0.0.1:9/never-called";
    const fetchSpy = vi.fn(() => {
      throw new Error("zero-network violation");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const run = await createConversionRun(service, "W2c Conflict Lab");
    while (await service.processNextJob()) {
      // drain to waiting_approval
    }
    expect((await service.getRun(run.id)).status).toBe("waiting_approval");

    // Pre-bind the resume's exact key to a *different* intent.
    const expectedIntent = expectedResumeIntent(run);
    const conflictInput: OutboxEventInput = {
      eventId: "evt_w2c_conflict",
      schemaVersion: "1.0",
      eventType: "growth.outbox.delivery_intent_recorded",
      occurredAt: NOW,
      emittedAt: NOW,
      scope: { workspaceId: run.workspaceId },
      actorRef: "w2c-test",
      subjectRef: run.id,
      correlationId: run.id,
      idempotencyKey: expectedIntent.idempotencyKey,
      idempotencyScope: OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE,
      traceId: "trace_w2c_conflict",
      dataClass: "OPERATIONAL",
      payload: {
        deliveryIntent: {
          ...expectedIntent,
          body: { ...expectedIntent.body, draft: "tampered draft" }
        }
      },
      status: "PENDING"
    };
    await service.enqueueOutboxEvent(conflictInput);

    await service.updateApproval(run.id, { approved: true, reviewerId: "op_w2c" });

    await expect(service.processNextJob()).rejects.toBeInstanceOf(IdempotencyConflictError);

    // Rollback: the resume projection did not commit — the row stays at the
    // approval-decision state and carries no resumed delivery intent.
    const after = await service.getRun(run.id);
    expect(after.status).toBe("running");
    expect(after.approvalStatus).toBe("approved");
    expect(
      after.stepResults?.some((step) => step.payload?.deliveryIntent !== undefined)
    ).toBe(false);

    // No residue: the pre-existing row is untouched (no overwrite, no second row).
    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(
      (JSON.parse(rows[0].payload) as { deliveryIntent: { body: { draft: string } } })
        .deliveryIntent.body.draft
    ).toBe("tampered draft");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("⑤ durable private_conversion approval resume persists the webhook intent (zero network)", async () => {
    const { db, service } = await setup({ durable: true });
    process.env[SWITCH_ENV] = "1";
    process.env[WEBHOOK_ENV] = "http://127.0.0.1:9/never-called";
    const fetchSpy = vi.fn(() => {
      throw new Error("zero-network violation");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const run = await createConversionRun(service, "W2c Resume Lab");
    while (await service.processNextJob()) {
      // drain to waiting_approval
    }
    expect((await service.getRun(run.id)).status).toBe("waiting_approval");
    expect(await db.select().from(outboxEvents)).toHaveLength(0);

    await service.updateApproval(run.id, { approved: true, reviewerId: "op_w2c" });
    let processed = 0;
    while (await service.processNextJob()) processed += 1;
    expect(processed).toBeGreaterThan(0);

    const finished = await service.getRun(run.id);
    expect(finished.status).toBe("completed");

    const expectedIntent = expectedResumeIntent(run);
    const rows = await db.select().from(outboxEvents);
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyScope).toBe(OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE);
    expect(rows[0].idempotencyKey).toBe(expectedIntent.idempotencyKey);
    expect(rows[0].status).toBe("PENDING");
    expect(JSON.parse(rows[0].scope)).toEqual({ workspaceId: run.workspaceId });
    expect(JSON.parse(rows[0].payload)).toEqual({ deliveryIntent: expectedIntent });

    // The adapter recorded the intent instead of sending: fetch never ran.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
