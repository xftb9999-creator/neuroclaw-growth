import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createInMemoryDb,
  outboxEvents,
  productEvents,
  runMigrations,
  rollbackMigration,
  type Database
} from "@neuroclaw/db";
import {
  assertOutboxEventTransition,
  outboxEventSchema,
  type OutboxEvent
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

const timestamp = "2026-09-08T00:00:00Z";
const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    await closeDatabase(openDatabases.pop()!);
  }
});

function baseEvent(overrides: Partial<OutboxEvent> = {}): OutboxEvent {
  return {
    eventId: "evt_ac1_demo",
    schemaVersion: "1.0",
    eventType: "growth.run.created",
    occurredAt: timestamp,
    emittedAt: timestamp,
    scope: { projectId: "project_demo" },
    actorRef: "actor_demo",
    subjectRef: "run_demo",
    correlationId: "correlation_demo",
    idempotencyKey: "run-created-1",
    idempotencyScope: "project:project_demo",
    traceId: "trace_demo",
    dataClass: "OPERATIONAL",
    payload: { runId: "run_demo" },
    status: "PENDING",
    ...overrides
  };
}

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

describe("AC-1-1 local Outbox", () => {
  it("enqueues a valid Event Envelope in the real local database", async () => {
    const { db, service } = await setup();

    const result = await service.enqueueOutboxEvent(baseEvent());
    const rows = await db.select().from(outboxEvents);

    expect(result.inserted).toBe(true);
    expect(result.event).toMatchObject({ eventId: "evt_ac1_demo", status: "PENDING" });
    expect(rows).toHaveLength(1);
    expect(rows[0].idempotencyScope).toBe("project:project_demo");
    expect(JSON.parse(rows[0].payload)).toEqual({ runId: "run_demo" });
  });

  it("does not enqueue twice or create a second effect for one scope and key", async () => {
    const { db, service } = await setup();

    const first = await service.enqueueOutboxEvent(baseEvent());
    const second = await service.enqueueOutboxEvent(baseEvent());

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.event).toMatchObject({ eventId: first.event.eventId, status: "PENDING" });
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
    await expect(
      service.enqueueOutboxEvent(
        baseEvent({ eventId: "evt_ac1_other", payload: { runId: "different" } })
      )
    ).rejects.toThrow(/already bound to a different event/);
  });

  it("allows the same key in independent idempotency scopes", async () => {
    const { db, service } = await setup();

    await service.enqueueOutboxEvent(baseEvent());
    await service.enqueueOutboxEvent(
      baseEvent({
        eventId: "evt_ac1_workspace_scope",
        idempotencyScope: "workspace:workspace_demo"
      })
    );

    expect(await db.select().from(outboxEvents)).toHaveLength(2);
  });

  it("rejects invalid envelopes and illegal or terminal status transitions", async () => {
    const { service } = await setup();

    await expect(
      service.enqueueOutboxEvent(
        baseEvent({ eventType: "", occurredAt: "not-a-timestamp" } as Partial<OutboxEvent>)
      )
    ).rejects.toThrow();
    await expect(
      service.enqueueOutboxEvent(baseEvent({ status: "COMPLETED" }))
    ).rejects.toThrow(/start in PENDING/);

    const pending = outboxEventSchema.parse(baseEvent());
    expect(() => assertOutboxEventTransition(pending, { ...pending, status: "COMPLETED" })).toThrow(
      /Cannot transition/
    );
    const processing = { ...pending, status: "PROCESSING" as const };
    expect(() => assertOutboxEventTransition(pending, processing)).not.toThrow();
    const completed = { ...processing, status: "COMPLETED" as const };
    expect(() => assertOutboxEventTransition(processing, completed)).not.toThrow();
    expect(() => assertOutboxEventTransition(completed, { ...completed, status: "FAILED" })).toThrow(
      /terminal/
    );
  });

  it("persists status transitions and preserves existing product event behavior", async () => {
    const { db, service } = await setup();

    await service.enqueueOutboxEvent(baseEvent());
    const processing = await service.transitionOutboxEvent("evt_ac1_demo", "PROCESSING");
    const completed = await service.transitionOutboxEvent("evt_ac1_demo", "COMPLETED");
    expect(processing.status).toBe("PROCESSING");
    expect(completed.status).toBe("COMPLETED");
    await expect(service.transitionOutboxEvent("evt_ac1_demo", "FAILED")).rejects.toThrow(/terminal/);

    await service.recordProductEvent("workspace_demo", "user_demo", "run.created", { runId: "run_demo" });
    const analyticsRows = await db.select().from(productEvents);
    expect(analyticsRows).toHaveLength(1);
    expect(analyticsRows[0].eventType).toBe("run.created");
    expect(JSON.parse(analyticsRows[0].payload!)).toEqual({ runId: "run_demo" });
    expect(await db.select().from(outboxEvents)).toHaveLength(1);
  });

  it("keeps the Outbox migration repeatable and locally reversible", async () => {
    const { db } = await setup();

    expect(await runMigrations(db)).toEqual([]);
    await expect(rollbackMigration(db, "0005_outbox_events")).rejects.toThrow(/later migration/i);
    for (const migrationId of [
      "0013_run_lifecycle_checkpoints",
      "0012_outbox_delivery_attempts",
      "0011_run_events",
      "0010_ac6_attempt_replay_audit",
      "0009_growth_work_items",
      "0008_project_pack_adapter_registry",
      "0007_workflow_definitions",
      "0006_evidence_receipt_metrics"
    ]) {
      expect(await rollbackMigration(db, migrationId)).toBe(true);
    }
    expect(await rollbackMigration(db, "0005_outbox_events")).toBe(true);
    expect(await runMigrations(db)).toEqual([
      "0005_outbox_events",
      "0006_evidence_receipt_metrics",
      "0007_workflow_definitions",
      "0008_project_pack_adapter_registry",
      "0009_growth_work_items",
      "0010_ac6_attempt_replay_audit",
      "0011_run_events",
      "0012_outbox_delivery_attempts",
      "0013_run_lifecycle_checkpoints"
    ]);
    expect(await runMigrations(db)).toEqual([]);
  });
});
