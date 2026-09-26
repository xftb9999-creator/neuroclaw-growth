import { afterEach, describe, expect, it } from "vitest";

import {
  attempts,
  closeDatabase,
  createInMemoryDb,
  replayCheckpoints,
  rollbackMigration,
  runMigrations,
  runs,
  universalAuditEvents,
  type Database,
  workItems
} from "@neuroclaw/db";
import {
  createGrowthAdapterSnapshot,
  createGrowthPackSnapshot,
  createGrowthWorkflowSnapshot,
  pilotAttempts,
  pilotAuditEvents,
  pilotReceipts,
  pilotReplayCheckpoints,
  pilotRuns,
  type UniversalScope
} from "@neuroclaw/shared";
import { ControlPlaneService, type MaterializeGrowthRunInput } from "./index.js";

const openDatabases: Database[] = [];
const timestamp = "2026-09-09T00:00:00Z";
const scope: UniversalScope = {
  organizationId: "org_ac6",
  workspaceId: "ws_ac6",
  projectId: "prj_ac6"
};

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

async function insertLegacyRun(db: Database): Promise<string> {
  const id = "run_ac6_content";
  await db.insert(runs).values({
    id,
    workspaceId: scope.workspaceId!,
    templateType: "content_acquisition",
    status: "running",
    input: JSON.stringify({ businessSummary: "AC-6 simulation" }),
    outputPayload: null,
    failureReason: null,
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    completedAt: null,
    stepResults: null,
    tokensUsed: null,
    costUsd: null,
    teamId: null,
    relayId: null
  });
  return id;
}

function materializationInput(legacyRunId: string): MaterializeGrowthRunInput {
  const pack = createGrowthPackSnapshot(scope, "operator_ac6", timestamp);
  const workflow = createGrowthWorkflowSnapshot("content_acquisition", scope, "operator_ac6", timestamp);
  const adapter = createGrowthAdapterSnapshot("content_acquisition", scope, "operator_ac6", timestamp);
  return {
    legacyRunId,
    projectId: scope.projectId!,
    initiativeId: "initiative_ac6",
    assigneeRef: "operator_ac6",
    scope,
    packId: pack.packId,
    packVersion: pack.version,
    workflowRef: workflow.id,
    workflowVersion: workflow.version,
    adapterRef: adapter.adapterId,
    adapterVersion: adapter.version,
    packSnapshot: pack,
    workflowSnapshot: workflow,
    adapterSnapshot: adapter,
    packSnapshotRef: "pack_snapshot_ac6",
    workflowSnapshotRef: "workflow_snapshot_ac6",
    adapterSnapshotRef: "adapter_snapshot_ac6",
    inputSnapshotRef: "input_snapshot_ac6",
    policySnapshotRef: "policy_snapshot_ac6",
    approvalRefs: []
  };
}

async function registerSnapshots(
  service: ControlPlaneService,
  input: MaterializeGrowthRunInput
): Promise<void> {
  const pack = input.packSnapshot!;
  const workflow = input.workflowSnapshot!;
  const adapter = input.adapterSnapshot!;
  await service.registerProjectPack(pack, { workflows: [workflow], adapters: [adapter] });
  await service.persistWorkflowDefinition(workflow, { pack });
  await service.registerAdapter(adapter, { pack, workflows: [workflow] });
}

describe("AC-6-1 release-gate remediation", () => {
  it("rejects empty registries and conflicting duplicate materialization", async () => {
    const { db, service } = await setup();
    const legacyRunId = await insertLegacyRun(db);
    const input = materializationInput(legacyRunId);

    await expect(service.materializeGrowthRun(input)).rejects.toThrow(/exact local Pack registry/i);

    await registerSnapshots(service, input);
    await expect(service.materializeGrowthRun(input)).resolves.toMatchObject({ inserted: true });
    await expect(
      service.materializeGrowthRun({ ...input, packSnapshotRef: "pack_snapshot_conflict" })
    ).rejects.toThrow(/different Universal WorkItem context|conflicting queryable snapshot context|conflicting Universal snapshot/i);
    expect(await db.select().from(workItems)).toHaveLength(1);
  });

  it("persists and reads the Attempt/ReplayCheckpoint/Universal Audit chain with scope checks", async () => {
    const { db, service } = await setup();
    const attempt = pilotAttempts.uaos;
    const checkpoint = pilotReplayCheckpoints.uaos;
    const auditEvents = pilotAuditEvents.uaos;

    await service.persistAuditReplayChain({
      run: pilotRuns.uaos,
      receipt: pilotReceipts.uaos,
      attempts: [attempt],
      checkpoints: [checkpoint],
      auditEvents
    });

    expect(await db.select().from(attempts)).toHaveLength(1);
    expect(await db.select().from(replayCheckpoints)).toHaveLength(1);
    expect(await db.select().from(universalAuditEvents)).toHaveLength(auditEvents.length);
    expect(await service.readAttempt(attempt.id, attempt.scope)).toEqual(attempt);
    expect(await service.readReplayCheckpoint(checkpoint.id, checkpoint.scope)).toEqual(checkpoint);
    expect(await service.readAuditEvent(auditEvents[0].id, auditEvents[0].scope)).toEqual(auditEvents[0]);
    await expect(service.persistAttempt({ ...attempt, status: "FAILED" }))
      .rejects.toThrow(/different snapshot/i);
    await expect(service.readAttempt(attempt.id, { ...attempt.scope, projectId: "prj_other" }))
      .rejects.toThrow(/scope mismatch/i);
  });

  it("allows only ordered rollback and rerun of the latest AC-6 migration", async () => {
    const { db } = await setup();
    expect(await runMigrations(db)).toEqual([]);
    await expect(rollbackMigration(db, "0009_growth_work_items")).rejects.toThrow(/later migration/i);
    expect(await rollbackMigration(db, "0011_run_events")).toBe(true);
    expect(await rollbackMigration(db, "0010_ac6_attempt_replay_audit")).toBe(true);
    expect(await rollbackMigration(db, "0009_growth_work_items")).toBe(true);
    expect(await runMigrations(db)).toEqual([
      "0009_growth_work_items",
      "0010_ac6_attempt_replay_audit",
      "0011_run_events"
    ]);
    expect(await runMigrations(db)).toEqual([]);
  });
});
