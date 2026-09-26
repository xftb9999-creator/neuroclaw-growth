import { afterEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import {
  closeDatabase,
  createInMemoryDb,
  runMigrations,
  rollbackMigration,
  type Database,
  workflowDefinitions
} from "@neuroclaw/db";
import {
  assertProjectPackConsistency,
  pilotAdapterManifests,
  pilotPackManifests,
  pilotReceipts,
  pilotRuns,
  pilotWorkflows,
  projectPackManifestSchema,
  universalRunSchema,
  taskReceiptSchema,
  validateWorkflowGraph,
  workflowDefinitionSchema,
  type WorkflowDefinition
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

function workflowFor(version = "1.0.0"): WorkflowDefinition {
  return workflowDefinitionSchema.parse({
    ...pilotWorkflows[projectKey],
    projectId: "prj_uaos",
    packVersion: version,
    version
  });
}

function packFor(version = "1.0.0") {
  return projectPackManifestSchema.parse({
    ...pilotPackManifests[projectKey],
    version
  });
}

describe("AC-2-0 immutable WorkflowDefinition foundation", () => {
  it("persists, reads, and lists immutable identity/version snapshots", async () => {
    const { db, service } = await setup();
    const v1 = workflowFor();
    const v2 = workflowFor("2.0.0");

    await expect(service.persistWorkflowDefinition(v1, { pack: packFor() })).resolves.toEqual(v1);
    expect(await service.readWorkflowDefinition(v1.id, v1.version, v1.scope)).toEqual(v1);
    expect(await db.select().from(workflowDefinitions)).toHaveLength(1);

    await expect(
      service.persistWorkflowDefinition(
        { ...v1, metadata: { attemptedOverwrite: true } },
        { pack: packFor() }
      )
    ).rejects.toThrow(/immutable|already exists/i);

    await expect(service.writeWorkflowDefinition({ workflowDefinition: v2, pack: packFor("2.0.0") })).resolves.toEqual(v2);
    const versions = (await service.listWorkflowDefinitions(v1.scope)).map((workflow) => workflow.version);
    expect(new Set(versions)).toEqual(new Set(["1.0.0", "2.0.0"]));
    expect(await db.select().from(workflowDefinitions)).toHaveLength(2);

    await expect(
      service.readWorkflowDefinition(v1.id, v1.version, { ...v1.scope, projectId: "prj_other" })
    ).rejects.toThrow(/scope/i);
  });

  it("fails closed for missing project scope and Pack identity/version mismatches", async () => {
    const { service } = await setup();
    const workflow = workflowFor();

    await expect(
      service.persistWorkflowDefinition(
        { ...workflow, scope: { workspaceId: "ws_simulation" } },
        { pack: packFor() }
      )
    ).rejects.toThrow(/scope\.projectId/i);

    await expect(
      service.persistWorkflowDefinition(workflow, { pack: packFor("9.9.9") })
    ).rejects.toThrow(/Pack|version/i);

    const capabilityWorkflow = workflowDefinitionSchema.parse({
      ...workflow,
      nodes: [{ ...workflow.nodes[0], capabilityRefs: ["capability_not_registered"] }]
    });
    await expect(
      service.persistWorkflowDefinition(capabilityWorkflow, { pack: packFor() })
    ).rejects.toThrow(/not registered by the Pack/i);
  });

  it("rejects invalid graph and approval boundaries while accepting a valid DAG", async () => {
    const workflow = workflowFor();
    const nodeA = { ...workflow.nodes[0], nodeId: "node_a" };
    const nodeB = { ...workflow.nodes[0], nodeId: "node_b" };

    const validDag = workflowDefinitionSchema.parse({
      ...workflow,
      nodes: [nodeA, nodeB],
      edges: [{ from: "node_a", to: "node_b" }]
    });
    expect(() => validateWorkflowGraph(validDag)).not.toThrow();

    expect(
      workflowDefinitionSchema.safeParse({
        ...workflow,
        nodes: [nodeA, nodeB],
        edges: [
          { from: "node_a", to: "node_b" },
          { from: "node_a", to: "node_b" }
        ]
      }).success
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...workflow,
        nodes: [nodeA, nodeB],
        edges: [
          { from: "node_a", to: "node_b" },
          { from: "node_b", to: "node_a" }
        ]
      }).success
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({
        ...workflow,
        edges: [{ from: "node_a", to: "missing_node" }]
      }).success
    ).toBe(false);

    const approvalWorkflow = {
      ...workflow,
      nodes: [{ ...workflow.nodes[0], nodeId: "approval", approvalPoint: true }],
      approvalPoints: ["approval"],
      approvalPolicy: { mode: "manual" }
    };
    expect(workflowDefinitionSchema.safeParse(approvalWorkflow).success).toBe(true);
    expect(
      workflowDefinitionSchema.safeParse({ ...approvalWorkflow, approvalPolicy: {} }).success
    ).toBe(false);
    expect(
      workflowDefinitionSchema.safeParse({ ...approvalWorkflow, approvalPoints: ["unknown"] }).success
    ).toBe(false);
  });

  it("keeps AC-1 legacy pins valid and accepts the AC-2 identity aliases", () => {
    const workflow = workflowFor();
    const pack = packFor();
    const legacyRun = universalRunSchema.parse(pilotRuns[projectKey]);
    const legacyReceipt = taskReceiptSchema.parse(pilotReceipts[projectKey]);
    const { workflowRef: _runWorkflowRef, ...runWithoutLegacyRef } = legacyRun;
    const { workflowRef: _receiptWorkflowRef, ...receiptWithoutLegacyRef } = legacyReceipt;
    const aliasedRun = universalRunSchema.parse({
      ...runWithoutLegacyRef,
      workflowDefinitionId: workflow.id,
      workflowDefinitionVersion: workflow.version
    });
    const aliasedReceipt = taskReceiptSchema.parse({
      ...receiptWithoutLegacyRef,
      workflowDefinitionId: workflow.id,
      workflowDefinitionVersion: workflow.version
    });

    expect(() =>
      assertProjectPackConsistency({
        pack,
        workflow,
        adapter: pilotAdapterManifests[projectKey],
        run: aliasedRun,
        receipt: aliasedReceipt
      })
    ).not.toThrow();
    expect(() => universalRunSchema.parse(pilotRuns[projectKey])).not.toThrow();
    expect(() => taskReceiptSchema.parse(pilotReceipts[projectKey])).not.toThrow();
  });

  it("reruns migration 0007 and keeps rollback latest-only", async () => {
    const { db } = await setup();

    expect(await runMigrations(db)).toEqual([]);
    for (const migrationId of [
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
      "0012_outbox_delivery_attempts"
    ]);
    expect(await runMigrations(db)).toEqual([]);

    await db.execute(sql`INSERT INTO schema_migrations (id) VALUES ('0008_future_test')`);
    await expect(rollbackMigration(db, "0007_workflow_definitions")).rejects.toThrow(/later migration/i);
  });
});
