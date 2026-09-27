import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  createInMemoryDb,
  runMigrations,
  rollbackMigration,
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
  organizationId: "org_growth",
  workspaceId: "ws_growth",
  projectId: "prj_growth"
};

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

async function insertLegacyRun(
  db: Database,
  templateType: string,
  status: "draft" | "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled",
  approvalStatus: "not_required" | "pending" | "approved" | "rejected" = "not_required",
  suffix = ""
): Promise<string> {
  const id = `run_ac4_${templateType}${suffix ? `_${suffix}` : ""}`;
  await db.insert(runs).values({
    id,
    workspaceId: scope.workspaceId!,
    templateType,
    status,
    input: JSON.stringify({ businessSummary: "simulated business" }),
    outputPayload: status === "completed" ? JSON.stringify({ simulated: true }) : null,
    failureReason: null,
    currentStep: null,
    approvalStatus,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: status === "completed" ? timestamp : null,
    stepResults: null,
    tokensUsed: null,
    costUsd: null,
    teamId: null,
    relayId: null
  });
  return id;
}

function materializationInput(
  legacyRunId: string,
  templateType: string,
  overrides: Partial<MaterializeGrowthRunInput> = {}
): MaterializeGrowthRunInput {
  const pack = createGrowthPackSnapshot(scope, "operator_ac4", timestamp);
  const workflow = createGrowthWorkflowSnapshot(templateType, scope, "operator_ac4", timestamp);
  const adapter = createGrowthAdapterSnapshot(templateType, scope, "operator_ac4", timestamp);
  const compatibility = {
    content_acquisition: ["workflow_growth_content_acquisition", "adapter_growth_content_acquisition"],
    private_conversion: ["workflow_growth_private_conversion", "adapter_growth_private_conversion"],
    weekly_review: ["workflow_growth_weekly_review", "adapter_growth_weekly_review"]
  }[templateType] as [string, string];
  return {
    legacyRunId,
    projectId: scope.projectId!,
    initiativeId: "initiative_growth",
    assigneeRef: "operator_ac4",
    scope,
    packId: pack.packId,
    packVersion: pack.version,
    workflowRef: compatibility[0],
    workflowVersion: "1.0.0",
    adapterRef: compatibility[1],
    adapterVersion: "1.0.0",
    packSnapshot: pack,
    workflowSnapshot: workflow,
    adapterSnapshot: adapter,
    packSnapshotRef: "pack_snapshot_growth_v1",
    workflowSnapshotRef: `workflow_snapshot_${templateType}`,
    adapterSnapshotRef: `adapter_snapshot_${templateType}`,
    inputSnapshotRef: `input_snapshot_${legacyRunId}`,
    policySnapshotRef: "policy_snapshot_growth_simulation",
    approvalRefs: [],
    ...overrides
  };
}

async function registerSnapshots(
  service: ControlPlaneService,
  input: MaterializeGrowthRunInput,
  registerPack = true
): Promise<void> {
  const pack = input.packSnapshot!;
  const workflow = input.workflowSnapshot!;
  const adapter = input.adapterSnapshot!;
  if (registerPack) {
    await service.registerProjectPack(pack, {
      workflows: [workflow],
      adapters: [adapter]
    });
  }
  await service.persistWorkflowDefinition(workflow, { pack });
  await service.registerAdapter(adapter, { pack, workflows: [workflow] });
}

describe("AC-4-0 Growth Run compatibility wrapper", () => {
  it("materializes all built-in Growth Runs without executing a second Run", async () => {
    const { db, service } = await setup();
    let packRegistered = false;
    for (const templateType of ["content_acquisition", "private_conversion", "weekly_review"] as const) {
      const runId = await insertLegacyRun(db, templateType, templateType === "private_conversion" ? "waiting_approval" : "completed", templateType === "private_conversion" ? "pending" : "not_required");
      const input = materializationInput(runId, templateType);
      await registerSnapshots(service, input, !packRegistered);
      packRegistered = true;
      const result = await service.materializeGrowthRun(input);
      expect(result.inserted).toBe(true);
      expect(result.workItem.projectId).toBe(scope.projectId);
      expect(result.workItem.workflowRef).toBe(result.run.workflowRef);
      expect(result.run.manifestRef).toBe(result.compatibility.adapterId);
      expect(result.run.status).toBe(templateType === "private_conversion" ? "WAITING_APPROVAL" : "COMPLETED");
      expect(result.receipt?.runId).toBe(templateType === "private_conversion" ? undefined : result.run.id);
    }
    expect(await db.select().from(runs)).toHaveLength(3);
    expect(await db.select().from(workItems)).toHaveLength(3);
  });

  it("returns the same binding on rerun and rejects a different context", async () => {
    const { service } = await setup();
    const runId = await insertLegacyRun(service.db, "content_acquisition", "completed");
    const input = materializationInput(runId, "content_acquisition");
    await registerSnapshots(service, input);
    const first = await service.materializeGrowthRun(input);
    const second = await service.materializeUniversalWorkItem(input);
    expect(second.inserted).toBe(false);
    expect(second.workItem.id).toBe(first.workItem.id);
    await expect(service.materializeGrowthRun({ ...input, initiativeId: "initiative_other" })).rejects.toThrow(/different Universal WorkItem context/i);
    expect(await service.getMaterializedGrowthRun(runId)).toMatchObject({ workItem: { id: first.workItem.id } });
  });

  it("fails closed for missing context, unknown template, identity mismatch, and unsafe Adapter", async () => {
    const { db, service } = await setup();
    const runId = await insertLegacyRun(db, "content_acquisition", "completed");
    const input = materializationInput(runId, "content_acquisition");
    await expect(service.materializeGrowthRun({ ...input, projectId: "" })).rejects.toThrow(/projectId/i);
    await expect(service.materializeGrowthRun({ ...input, workflowVersion: "9.9.9" })).rejects.toThrow(/identity or version/i);

    const unknownRunId = await insertLegacyRun(db, "custom_growth", "completed");
    await expect(service.materializeGrowthRun(materializationInput(unknownRunId, "content_acquisition"))).rejects.toThrow(/Unsupported Growth Run template/i);

    await expect(service.materializeGrowthRun({
      ...input,
      adapterSnapshot: { ...input.adapterSnapshot!, writeScopes: ["send:real"] }
    })).rejects.toThrow(/simulation-only|read-only/i);
  });

  it("keeps private conversion approval semantics and preview-only adapter boundaries", async () => {
    const { db, service } = await setup();
    const waitingId = await insertLegacyRun(db, "private_conversion", "waiting_approval", "pending", "waiting");
    const waitingInput = materializationInput(waitingId, "private_conversion");
    await registerSnapshots(service, waitingInput);
    const waiting = await service.materializeGrowthRun(waitingInput);
    expect(waiting.run.status).toBe("WAITING_APPROVAL");
    expect(waiting.workItem.approvalStatus).toBe("pending");
    expect(waiting.compatibility.simulationOnly).toBe(true);

    const rejectedId = await insertLegacyRun(db, "private_conversion", "cancelled", "rejected", "rejected");
    const rejectedInput = materializationInput(rejectedId, "private_conversion");
    const rejected = await service.materializeGrowthRun(rejectedInput);
    expect(rejected.run.status).toBe("CANCELED");
    expect(rejected.workItem.approvalStatus).toBe("rejected");

    const unapprovedId = await insertLegacyRun(db, "private_conversion", "completed", "pending", "unapproved");
    const unapprovedInput = materializationInput(unapprovedId, "private_conversion");
    await expect(service.materializeGrowthRun(unapprovedInput)).rejects.toThrow(/approved manual approval/i);
  });

  it("applies, reruns, and rejects over-rollback before ordered rollback", async () => {
    const { db } = await setup();
    expect(await runMigrations(db)).toEqual([]);
    await expect(rollbackMigration(db, "0009_growth_work_items")).rejects.toThrow(/later migration/i);
    expect(await rollbackMigration(db, "0013_run_lifecycle_checkpoints")).toBe(true);
    expect(await rollbackMigration(db, "0012_outbox_delivery_attempts")).toBe(true);
    expect(await rollbackMigration(db, "0011_run_events")).toBe(true);
    expect(await rollbackMigration(db, "0010_ac6_attempt_replay_audit")).toBe(true);
    expect(await rollbackMigration(db, "0009_growth_work_items")).toBe(true);
    expect(await runMigrations(db)).toEqual([
      "0009_growth_work_items",
      "0010_ac6_attempt_replay_audit",
      "0011_run_events",
      "0012_outbox_delivery_attempts",
      "0013_run_lifecycle_checkpoints"
    ]);
    expect(await runMigrations(db)).toEqual([]);
  });
});
