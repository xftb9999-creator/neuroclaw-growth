import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  evidenceRecords,
  metricDefinitions,
  metricObservations,
  receipts,
  rollbackMigration,
  runMigrations,
  type Database
} from "@neuroclaw/db";
import {
  INSUFFICIENT_DATA_SENTINEL,
  metricObservationSchema,
  pilotEvidenceRecords,
  pilotMetricDefinitions,
  pilotMetricObservations,
  pilotReceipts,
  pilotValidations,
  type MetricObservation
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

const projectKey = "uaos" as const;
const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    await closeDatabase(openDatabases.pop()!);
  }
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

function validChain() {
  const evidence = pilotEvidenceRecords[projectKey];
  const definition = pilotMetricDefinitions[projectKey];
  const observation = pilotMetricObservations[projectKey];
  const receipt = {
    ...pilotReceipts[projectKey],
    metricObservationRefs: [observation.id]
  };
  return {
    evidences: [evidence],
    metricDefinitions: [definition],
    metricObservations: [observation],
    validations: [pilotValidations[projectKey]],
    receipt
  };
}

describe("AC-1-2 local Evidence / Receipt / Metric foundation", () => {
  it("persists and reads a scoped Evidence, Receipt, and RATE observation", async () => {
    const { db, service } = await setup();
    const chain = validChain();

    await service.persistEvidenceReceiptMetrics(chain);

    expect(await service.readEvidence(chain.evidences[0].id, chain.evidences[0].scope)).toEqual(
      chain.evidences[0]
    );
    expect(await service.readMetricDefinition(chain.metricDefinitions[0].id, chain.metricDefinitions[0].scope)).toEqual(
      chain.metricDefinitions[0]
    );
    expect(
      await service.readMetricObservation(chain.metricObservations[0].id, chain.metricObservations[0].scope)
    ).toEqual(chain.metricObservations[0]);
    expect(await service.readReceipt(chain.receipt.id, chain.receipt.scope)).toEqual(chain.receipt);

    expect(await db.select().from(evidenceRecords)).toHaveLength(1);
    expect(await db.select().from(receipts)).toHaveLength(1);
    expect(await db.select().from(metricDefinitions)).toHaveLength(1);
    expect(await db.select().from(metricObservations)).toHaveLength(1);
    expect(JSON.parse((await db.select().from(evidenceRecords))[0].rawJson)).toMatchObject({
      sourceRefs: chain.evidences[0].sourceRefs
    });
  });

  it("fails closed for missing sourceRefs, identity/version mismatch, and cross-scope chains", async () => {
    const { service } = await setup();
    const chain = validChain();

    await expect(
      service.persistEvidence({ ...chain.evidences[0], sourceRefs: [] })
    ).rejects.toThrow();
    await expect(
      service.persistEvidenceReceiptMetrics({
        ...chain,
        metricObservations: [
          { ...chain.metricObservations[0], definitionVersion: "9.9.9" }
        ]
      })
    ).rejects.toThrow(/version|definition/i);
    await expect(
      service.persistEvidenceReceiptMetrics({
        ...chain,
        evidences: [{ ...chain.evidences[0], scope: { projectId: "prj_other" } }]
      })
    ).rejects.toThrow(/scope/i);
  });

  it("keeps RATE numerator/denominator closed and preserves INSUFFICIENT_DATA semantics", async () => {
    const { service } = await setup();
    const chain = validChain();
    expect(chain.metricObservations[0].value).toBe(
      chain.metricObservations[0].numerator! / chain.metricObservations[0].denominator!
    );

    const badRate = { ...chain.metricObservations[0], value: 0.5 };
    expect(metricObservationSchema.safeParse(badRate).success).toBe(false);

    const insufficient: MetricObservation = {
      ...chain.metricObservations[0],
      id: "observation_uaos_insufficient",
      aggregation: undefined,
      numerator: undefined,
      denominator: undefined,
      value: INSUFFICIENT_DATA_SENTINEL,
      status: "INSUFFICIENT_DATA"
    };
    expect(metricObservationSchema.safeParse(insufficient).success).toBe(true);
    await service.persistMetricDefinition(chain.metricDefinitions[0]);
    await expect(service.persistMetricObservation(insufficient)).resolves.toEqual(insufficient);
  });

  it("reruns the AC-1-2 migration and refuses a non-latest rollback", async () => {
    const { db } = await setup();
    expect(await runMigrations(db)).toEqual([]);
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
    expect(await runMigrations(db)).toEqual([
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
    await db.execute(sql`INSERT INTO schema_migrations (id) VALUES ('0007_later_test')`);
    await expect(rollbackMigration(db, "0006_evidence_receipt_metrics")).rejects.toThrow(/later migration/i);
    await expect(rollbackMigration(db, "0005_outbox_events")).rejects.toThrow(/later migration/i);
  });
});
