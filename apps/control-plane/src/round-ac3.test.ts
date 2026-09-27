import { afterEach, describe, expect, it } from "vitest";

import {
  adapterRegistry,
  closeDatabase,
  createInMemoryDb,
  projectPackRegistry,
  runMigrations,
  rollbackMigration,
  type Database
} from "@neuroclaw/db";
import {
  adapterManifestSchema,
  approvalSchema,
  assertAdapterRegistryConsistency,
  assertAdapterStatusTransition,
  assertProjectPackConsistency,
  assertProjectPackRegistryConsistency,
  assertProjectPackStatusTransition,
  budgetSchema,
  killSwitchSchema,
  pilotAdapterManifests,
  pilotPackManifests,
  pilotProjectKeys,
  pilotProjects,
  pilotWorkflows,
  policySchema,
  revocationSchema,
  validateAllPilotFixtures,
  workflowDefinitionSchema,
  type AdapterManifest,
  type UniversalApproval,
  type UniversalBudget,
  type UniversalKillSwitch,
  type UniversalPolicy,
  type UniversalRevocation
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

const openDatabases: Database[] = [];
const timestamp = "2026-09-09T00:00:00Z";

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

function controlledWriteFixtures(): {
  adapter: AdapterManifest;
  policy: UniversalPolicy;
  budget: UniversalBudget;
  approval: UniversalApproval;
  revocation: UniversalRevocation;
  killSwitch: UniversalKillSwitch;
} {
  const entity = {
    schemaVersion: "1.0",
    scope: pilotAdapterManifests.uaos.scope,
    createdBy: "operator_ac3",
    createdAt: timestamp,
    updatedAt: timestamp,
    sourceRefs: ["fixture:ac3"]
  };
  const policy = policySchema.parse({
    ...entity,
    id: "policy_ac3_v1",
    policyKey: "ac3-controlled-write",
    version: "1.0.0",
    actionClass: "CONTROLLED_WRITE",
    riskClass: "HIGH",
    decision: "REQUIRE_APPROVAL",
    requiresApproval: true,
    subjectRef: "adapter_uaos_simulation",
    actionRef: "publish_result",
    resourceRef: "resource_uaos",
    budgetRef: "budget_ac3_v1",
    revocationRef: "revocation_ac3_v1",
    killSwitchRef: "kill_ac3_v1",
    status: "ACTIVE"
  });
  const budget = budgetSchema.parse({
    ...entity,
    id: "budget_ac3_v1",
    budgetKey: "ac3-budget",
    version: "1.0.0",
    unit: "simulation_units",
    limit: 10,
    consumed: 0,
    subjectRef: "adapter_uaos_simulation",
    resourceRef: "resource_uaos",
    status: "ACTIVE"
  });
  const approval = approvalSchema.parse({
    ...entity,
    id: "approval_ac3_v1",
    policyRef: policy.id,
    policyVersion: policy.version,
    actionClass: "CONTROLLED_WRITE",
    subjectRef: "adapter_uaos_simulation",
    actionRef: "publish_result",
    resourceRef: "resource_uaos",
    requestedBy: "operator_ac3",
    approverRef: "reviewer_ac3",
    status: "APPROVED",
    requestedAt: timestamp,
    decidedAt: timestamp
  });
  const revocation = revocationSchema.parse({
    ...entity,
    id: "revocation_ac3_v1",
    version: "1.0.0",
    targetRef: "adapter_uaos_simulation",
    resourceRef: "resource_uaos",
    reason: "manual stop line",
    status: "REVOKED",
    effectiveAt: timestamp
  });
  const killSwitch = killSwitchSchema.parse({
    ...entity,
    id: "kill_ac3_v1",
    version: "1.0.0",
    targetRef: "adapter_uaos_simulation",
    resourceRef: "resource_uaos",
    reason: "emergency stop",
    state: "ARMED"
  });
  const adapter = adapterManifestSchema.parse({
    ...pilotAdapterManifests.uaos,
    simulationOnly: false,
    status: "CONTROLLED_WRITE",
    writeScopes: ["project:write"],
    independentValidationRef: "validation_ac3_independent",
    policyRef: policy.id,
    policyVersion: policy.version,
    budgetRef: budget.id,
    budgetVersion: budget.version,
    approvalRefs: [approval.id],
    revocationRef: revocation.id,
    revocationVersion: revocation.version,
    killSwitchRef: killSwitch.id,
    killSwitchVersion: killSwitch.version,
    controlledWriteBindings: [{ actionRef: "publish_result", resourceRef: "resource_uaos" }]
  });
  return { adapter, policy, budget, approval, revocation, killSwitch };
}

describe("AC-3-0 local Pack / Adapter registry", () => {
  it("registers immutable Pack and Adapter snapshots by identity/version", async () => {
    const { db, service } = await setup();
    const pack = pilotPackManifests.uaos;
    const adapter = pilotAdapterManifests.uaos;

    await expect(
      service.registerProjectPack(pack, {
        project: pilotProjects.uaos,
        workflows: [pilotWorkflows.uaos],
        adapters: [adapter]
      })
    ).resolves.toEqual(pack);
    await expect(
      service.registerAdapter(adapter, {
        pack,
        project: pilotProjects.uaos,
        workflows: [pilotWorkflows.uaos]
      })
    ).resolves.toEqual(adapter);

    expect(await service.readProjectPack(pack.packId, pack.version, pack.scope)).toEqual(pack);
    expect(await service.readAdapter(adapter.adapterId, adapter.version, adapter.scope)).toEqual(adapter);
    expect(await service.listPacks(pack.scope)).toHaveLength(1);
    expect(await service.listAdapters(pack.scope)).toHaveLength(1);
    expect(await db.select().from(projectPackRegistry)).toHaveLength(1);
    expect(await db.select().from(adapterRegistry)).toHaveLength(1);

    await expect(service.registerProjectPack(pack)).rejects.toThrow(/immutable|already exists/i);
    await expect(service.registerAdapter(adapter, { pack })).rejects.toThrow(/immutable|already exists/i);
  });

  it("fails closed for project, scope, Pack, Workflow, Adapter, and version mismatches", async () => {
    const { service } = await setup();
    const pack = pilotPackManifests.uaos;
    const adapter = pilotAdapterManifests.uaos;

    expect(() =>
      assertProjectPackRegistryConsistency({
        pack,
        project: { ...pilotProjects.uaos, packVersion: "9.9.9" },
        workflows: [pilotWorkflows.uaos],
        adapters: [adapter]
      })
    ).toThrow(/Pack project and version|exact Pack/i);
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter: { ...adapter, scope: { projectId: "prj_other" }, projectRef: "prj_other" }
      })
    ).toThrow(/Pack project|scope/i);
    await expect(
      service.registerAdapter({ ...adapter, version: "2.0.0" }, { pack })
    ).rejects.toThrow(/Pack project\/version|version/i);
    await service.registerProjectPack(pack);
    await expect(
      service.readProjectPack(pack.packId, pack.version, { projectId: "prj_other" })
    ).rejects.toThrow(/scope/i);
  });

  it("rejects orphan Adapters and Pack registration without controlled-write safety", async () => {
    const { service } = await setup();
    const pack = pilotPackManifests.uaos;
    const adapter = controlledWriteFixtures().adapter;

    await expect(
      service.registerAdapter(adapter, { pack })
    ).rejects.toThrow(/exact local Pack|without.*Pack|registry snapshot/i);

    await expect(
      service.registerProjectPack(pack, {
        project: pilotProjects.uaos,
        workflows: [pilotWorkflows.uaos],
        adapters: [adapter]
      })
    ).rejects.toThrow(/actionRef|policy|budget|revocation|kill|approval|safety/i);
  });

  it("rejects capability and status mismatches before registry writes", async () => {
    const { service } = await setup();
    const pack = pilotPackManifests.uaos;

    expect(() =>
      assertProjectPackRegistryConsistency({
        pack,
        project: pilotProjects.uaos,
        workflows: [
          {
            ...pilotWorkflows.uaos,
            nodes: [{ ...pilotWorkflows.uaos.nodes[0], capabilityRefs: ["capability_missing"] }]
          }
        ],
        adapters: [pilotAdapterManifests.uaos]
      })
    ).toThrow(/capability.*not registered/i);

    expect(() =>
      assertProjectPackRegistryConsistency({
        pack,
        project: pilotProjects.uaos,
        workflows: [{ ...pilotWorkflows.uaos, status: "RETIRED" }],
        adapters: [pilotAdapterManifests.uaos]
      })
    ).toThrow(/Workflow status.*incompatible/i);

    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter: { ...pilotAdapterManifests.uaos, status: "REVOKED" }
      })
    ).toThrow(/Adapter status.*incompatible/i);

    await expect(
      service.registerProjectPack(pack, {
        project: pilotProjects.uaos,
        workflows: [pilotWorkflows.uaos],
        adapters: [pilotAdapterManifests.uaos]
      })
    ).resolves.toEqual(pack);
  });

  it("keeps same-identity Pack and Adapter versions independently readable", async () => {
    const { service } = await setup();
    const packV1 = pilotPackManifests.uaos;
    const adapterV1 = pilotAdapterManifests.uaos;
    const workflowV1 = pilotWorkflows.uaos;
    const packV2 = { ...packV1, version: "2.0.0" };
    const adapterV2 = { ...adapterV1, version: "2.0.0" };
    const workflowV2 = { ...workflowV1, version: "2.0.0", packVersion: "2.0.0" };
    const projectV2 = { ...pilotProjects.uaos, packVersion: "2.0.0" };

    await service.registerProjectPack(packV1, {
      project: pilotProjects.uaos,
      workflows: [workflowV1],
      adapters: [adapterV1]
    });
    await service.registerAdapter(adapterV1, {
      pack: packV1,
      project: pilotProjects.uaos,
      workflows: [workflowV1]
    });
    await service.registerProjectPack(packV2, {
      project: projectV2,
      workflows: [workflowV2],
      adapters: [adapterV2]
    });
    await service.registerAdapter(adapterV2, {
      pack: packV2,
      project: projectV2,
      workflows: [workflowV2]
    });

    expect(await service.readProjectPack(packV1.packId, "1.0.0")).toEqual(packV1);
    expect(await service.readProjectPack(packV2.packId, "2.0.0")).toEqual(packV2);
    expect(await service.readAdapter(adapterV1.adapterId, "1.0.0")).toEqual(adapterV1);
    expect(await service.readAdapter(adapterV2.adapterId, "2.0.0")).toEqual(adapterV2);
    expect(await service.listPacks(packV1.scope)).toHaveLength(2);
    expect(await service.listAdapters(packV1.scope)).toHaveLength(2);
  });

  it("rejects orphan Adapters and requires an exact local Pack snapshot", async () => {
    const { db, service } = await setup();
    const pack = pilotPackManifests.uaos;
    const adapter = pilotAdapterManifests.uaos;

    await expect(service.registerAdapter(adapter, { pack })).rejects.toThrow(/local Pack|orphan/i);
    expect(await db.select().from(adapterRegistry)).toHaveLength(0);

    await service.registerProjectPack(pack);
    await expect(
      service.registerAdapter(adapter, {
        pack: { ...pack, status: "PAUSED" }
      })
    ).rejects.toThrow(/manifest snapshot|local registry/i);
    await expect(
      service.registerAdapter(adapter, {
        pack: { ...pack, projectId: "prj_other", scope: { projectId: "prj_other" } }
      })
    ).rejects.toThrow(/manifest snapshot|local registry|scope/i);
    expect(await db.select().from(adapterRegistry)).toHaveLength(0);
  });

  it("runs the complete safety gate for every controlled-write Adapter during Pack registration", async () => {
    const { db, service } = await setup();
    const { adapter, policy, budget, approval, revocation, killSwitch } = controlledWriteFixtures();
    const pack = { ...pilotPackManifests.uaos, adapterRefs: [adapter.adapterId] };

    await expect(
      service.registerProjectPack(pack, { adapters: [adapter] })
    ).rejects.toThrow(/policy|budget|approval|revocation|kill-switch|actionRef|safety/i);
    expect(await db.select().from(projectPackRegistry)).toHaveLength(0);

    await expect(
      service.registerProjectPack(pack, {
        adapters: [adapter],
        adapterSafety: {
          [adapter.adapterId]: {
            policy,
            budget,
            approvals: [approval],
            revocation,
            killSwitch,
            actionRef: "publish_result",
            resourceRef: "resource_uaos"
          }
        }
      })
    ).resolves.toEqual(pack);
  });

  it("rejects capability and Pack/Workflow/Adapter status combinations", () => {
    const pack = pilotPackManifests.uaos;
    const invalidCapabilityWorkflow = workflowDefinitionSchema.parse({
      ...pilotWorkflows.uaos,
      nodes: [{ ...pilotWorkflows.uaos.nodes[0], capabilityRefs: ["capability_not_in_pack"] }]
    });
    expect(() =>
      assertProjectPackConsistency({ pack, workflow: invalidCapabilityWorkflow })
    ).toThrow(/not registered by the Pack/i);
    expect(() =>
      assertProjectPackRegistryConsistency({
        pack,
        workflows: [workflowDefinitionSchema.parse({ ...pilotWorkflows.uaos, status: "RETIRED" })],
        adapters: [pilotAdapterManifests.uaos]
      })
    ).toThrow(/status.*incompatible/i);
    expect(() =>
      assertProjectPackRegistryConsistency({
        pack,
        adapters: [{ ...pilotAdapterManifests.uaos, status: "DRAFT" }]
      })
    ).toThrow(/status.*incompatible/i);
  });

  it("enforces status boundaries and complete CONTROLLED_WRITE safety snapshots", async () => {
    expect(() => assertProjectPackStatusTransition("ACTIVE", "DRAFT")).toThrow(/transition/);
    expect(() => assertProjectPackStatusTransition("ACTIVE", "PAUSED")).not.toThrow();
    expect(() => assertAdapterStatusTransition("SANDBOXED", "CONTROLLED_WRITE")).toThrow(/transition/);
    expect(() => assertAdapterStatusTransition("READ_ONLY_READY", "CONTROLLED_WRITE")).not.toThrow();

    const { adapter, policy, budget, approval, revocation, killSwitch } = controlledWriteFixtures();
    const pack = pilotPackManifests.uaos;
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter,
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch,
        actionRef: "publish_result",
        resourceRef: "resource_uaos"
      })
    ).not.toThrow();
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter: { ...adapter, independentValidationRef: undefined },
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch,
        actionRef: "publish_result",
        resourceRef: "resource_uaos"
      })
    ).toThrow(/independent validation|validation/i);
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter,
        policy,
        approvals: [approval],
        revocation,
        killSwitch,
        actionRef: "publish_result",
        resourceRef: "resource_uaos"
      })
    ).toThrow(/budget|active referenced/i);
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter,
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, version: "9.9.9" },
        killSwitch,
        actionRef: "publish_result",
        resourceRef: "resource_uaos"
      })
    ).toThrow(/version pins/i);
    expect(() =>
      assertAdapterRegistryConsistency({
        pack,
        adapter,
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, schemaVersion: "9.9.9" },
        killSwitch: { ...killSwitch, schemaVersion: "9.9.9" },
        actionRef: "publish_result",
        resourceRef: "resource_uaos"
      })
    ).not.toThrow();
  });

  it("preserves the four simulation-only pilot safety boundaries", () => {
    expect(validateAllPilotFixtures()).toHaveLength(4);
    for (const projectKey of pilotProjectKeys) {
      const pack = pilotPackManifests[projectKey];
      const adapter = pilotAdapterManifests[projectKey];
      expect(adapter.simulationOnly).toBe(true);
      expect(adapter.status).toBe("SANDBOXED");
      expect(adapter.writeScopes).toEqual([]);
      expect(adapter.sideEffects).toEqual(["none"]);
      expect(() =>
        assertAdapterRegistryConsistency({
          pack,
          adapter,
          project: pilotProjects[projectKey],
          workflows: [pilotWorkflows[projectKey]]
        })
      ).not.toThrow();
    }
  });

  it("keeps same-identity Pack and Adapter versions independently readable and listable", async () => {
    const { service } = await setup();
    const packV1 = pilotPackManifests.uaos;
    const adapterV1 = pilotAdapterManifests.uaos;
    const packV2 = { ...packV1, version: "2.0.0" };
    const adapterV2 = { ...adapterV1, version: "2.0.0" };

    await service.registerProjectPack(packV1);
    await service.registerAdapter(adapterV1, { pack: packV1 });
    await service.registerProjectPack(packV2);
    await service.registerAdapter(adapterV2, { pack: packV2 });

    expect(await service.readProjectPack(packV1.packId, "1.0.0", packV1.scope)).toEqual(packV1);
    expect(await service.readProjectPack(packV2.packId, "2.0.0", packV2.scope)).toEqual(packV2);
    expect(await service.readAdapter(adapterV1.adapterId, "1.0.0", adapterV1.scope)).toEqual(adapterV1);
    expect(await service.readAdapter(adapterV2.adapterId, "2.0.0", adapterV2.scope)).toEqual(adapterV2);
    expect((await service.listPacks(packV1.scope)).map((item) => item.version).sort()).toEqual([
      "1.0.0",
      "2.0.0"
    ]);
    expect((await service.listAdapters(adapterV1.scope)).map((item) => item.version).sort()).toEqual([
      "1.0.0",
      "2.0.0"
    ]);
  });

  it("keeps the AC-3 migration repeatable and locally reversible", async () => {
    const { db } = await setup();
    expect(await runMigrations(db)).toEqual([]);
    expect(await rollbackMigration(db, "0014_checkpoint_seq_and_job_idempotency")).toBe(true);
    expect(await rollbackMigration(db, "0013_run_lifecycle_checkpoints")).toBe(true);
    expect(await rollbackMigration(db, "0012_outbox_delivery_attempts")).toBe(true);
    expect(await rollbackMigration(db, "0011_run_events")).toBe(true);
    expect(await rollbackMigration(db, "0010_ac6_attempt_replay_audit")).toBe(true);
    expect(await rollbackMigration(db, "0009_growth_work_items")).toBe(true);
    expect(await rollbackMigration(db, "0008_project_pack_adapter_registry")).toBe(true);
    expect(await runMigrations(db)).toEqual([
      "0008_project_pack_adapter_registry",
      "0009_growth_work_items",
      "0010_ac6_attempt_replay_audit",
      "0011_run_events",
      "0012_outbox_delivery_attempts",
      "0013_run_lifecycle_checkpoints",
      "0014_checkpoint_seq_and_job_idempotency"
    ]);
    expect(await runMigrations(db)).toEqual([]);
  });
});
