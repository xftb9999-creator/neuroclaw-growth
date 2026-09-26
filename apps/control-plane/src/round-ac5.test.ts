import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  runs,
  workItems,
  type Database
} from "@neuroclaw/db";
import {
  createGrowthAdapterSnapshot,
  createGrowthPackSnapshot,
  createGrowthWorkflowSnapshot,
  type UniversalScope
} from "@neuroclaw/shared";
import { ControlPlaneService, type MaterializeGrowthRunInput } from "./index.js";

const openDatabases: Database[] = [];
const timestamp = "2026-09-09T00:00:00Z";
const scope: UniversalScope = {
  organizationId: "org_ac5",
  workspaceId: "ws_ac5",
  projectId: "prj_ac5"
};

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

async function insertLegacyRun(db: Database, status: "running" | "cancelled" = "running"): Promise<string> {
  const id = "run_ac5_content";
  await db.insert(runs).values({
    id,
    workspaceId: scope.workspaceId!,
    templateType: "content_acquisition",
    status,
    input: JSON.stringify({ businessSummary: "AC-5 simulation" }),
    outputPayload: null,
    failureReason: null,
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: status === "running" ? timestamp : null,
    completedAt: status === "cancelled" ? timestamp : null,
    stepResults: null,
    tokensUsed: null,
    costUsd: null,
    teamId: null,
    relayId: null
  });
  return id;
}

function materializationInput(legacyRunId: string): MaterializeGrowthRunInput {
  const pack = createGrowthPackSnapshot(scope, "operator_ac5", timestamp);
  const workflow = createGrowthWorkflowSnapshot("content_acquisition", scope, "operator_ac5", timestamp);
  const adapter = createGrowthAdapterSnapshot("content_acquisition", scope, "operator_ac5", timestamp);
  return {
    legacyRunId,
    projectId: scope.projectId!,
    initiativeId: "initiative_ac5",
    assigneeRef: "operator_ac5",
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
    packSnapshotRef: "pack_snapshot_ac5",
    workflowSnapshotRef: "workflow_snapshot_ac5",
    adapterSnapshotRef: "adapter_snapshot_ac5",
    inputSnapshotRef: "input_snapshot_ac5",
    policySnapshotRef: "policy_snapshot_ac5",
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
  await service.registerProjectPack(pack, {
    workflows: [workflow],
    adapters: [adapter]
  });
  await service.persistWorkflowDefinition(workflow, { pack });
  await service.registerAdapter(adapter, { pack, workflows: [workflow] });
}

describe("AC-5-0 reliability boundaries", () => {
  it("cancels in place without creating a second Legacy Run or WorkItem", async () => {
    const { db, service } = await setup();
    const legacyRunId = await insertLegacyRun(db);
    const input = materializationInput(legacyRunId);
    await registerSnapshots(service, input);
    const first = await service.materializeGrowthRun(input);

    const canceled = await service.cancelMaterializedGrowthRun(legacyRunId, scope);
    expect(canceled.inserted).toBe(false);
    expect(canceled.workItem.id).toBe(first.workItem.id);
    expect(canceled.run.id).toBe(first.run.id);
    expect(canceled.workItem.status).toBe("CANCELED");
    expect(canceled.run.status).toBe("CANCELED");
    expect(canceled.receipt?.resultStatus).toBe("CANCELED");
    expect(await db.select().from(runs)).toHaveLength(1);
    expect(await db.select().from(workItems)).toHaveLength(1);

    const rerun = await service.materializeGrowthRun(input);
    expect(rerun.inserted).toBe(false);
    expect(rerun.workItem.id).toBe(first.workItem.id);
    expect(rerun.run.id).toBe(first.run.id);
    expect(rerun.workItem.status).toBe("CANCELED");
  });

  it("rejects cross-scope reads and corrupted persisted scope rows", async () => {
    const { db, service } = await setup();
    const legacyRunId = await insertLegacyRun(db);
    const input = materializationInput(legacyRunId);
    await registerSnapshots(service, input);
    const materialized = await service.materializeGrowthRun(input);

    await expect(service.getMaterializedGrowthRun(legacyRunId, {
      ...scope,
      projectId: "prj_other"
    })).rejects.toThrow(/scope mismatch/);

    await db.update(workItems)
      .set({ scopeProjectId: "prj_other" })
      .where(eq(workItems.id, materialized.workItem.id));
    await expect(service.getMaterializedGrowthRun(legacyRunId)).rejects.toThrow(
      /scope|identity|version mismatch/
    );
  });
});
