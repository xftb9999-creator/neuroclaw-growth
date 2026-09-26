import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildSimulationAdapterInputs,
  buildSimulationProjectIntegration,
  buildSimulationProjectIntegrationRegistration,
  createSimulationIntegrationRegistry,
  assertSimulationOnlyAdapter,
  type SimulationProjectIntegrationConfigInput
} from "./project-integration.js";
import {
  pilotAdapterManifests,
  pilotPackManifests,
  pilotProjectKeys,
  pilotProjects,
  pilotSimulationIntegrationConfigs,
  pilotWorkflows,
  validateAllPilotFixtures
} from "./pilot-fixtures.js";
import { researchClaimSchema } from "./research-pack.js";
import {
  assertAdapterRegistryConsistency,
  assertAdapterStatusTransition,
  assertProjectPackStatusTransition
} from "./universal-contracts.js";

/**
 * AG-1 proof: the fifth project ("demo_sandbox") exists entirely as the data
 * file `../examples/demo_sandbox.integration.json`; this test only loads it.
 * Registering it, validating it, generating its simulation-only adapter input
 * and exercising every fail-closed path requires zero changes to the shared
 * integration kernel.
 */
const demoIntegrationConfig: SimulationProjectIntegrationConfigInput = JSON.parse(
  readFileSync(new URL("../examples/demo_sandbox.integration.json", import.meta.url), "utf8")
) as SimulationProjectIntegrationConfigInput;

const asConfig = (value: unknown): SimulationProjectIntegrationConfigInput =>
  value as SimulationProjectIntegrationConfigInput;

describe("universal project integration", () => {
  it("derives the four existing pilots through the same config-driven path", () => {
    const registry = createSimulationIntegrationRegistry();
    const expectedIdentities: Record<
      (typeof pilotProjectKeys)[number],
      { packId: string; adapterId: string; riskClass: string }
    > = {
      uaos: {
        packId: "pack_uaos_engineering",
        adapterId: "adapter_uaos_simulation",
        riskClass: "LOW"
      },
      hesn: {
        packId: "pack_hesn_social_agent",
        adapterId: "adapter_hesn_simulation",
        riskClass: "LOW"
      },
      ex_protocol: {
        packId: "pack_ex_taskpay",
        adapterId: "adapter_ex_protocol_simulation",
        riskClass: "HIGH"
      },
      bitmind: {
        packId: "pack_bitmind_research_decision",
        adapterId: "adapter_bitmind_simulation",
        riskClass: "HIGH"
      }
    };

    for (const config of pilotSimulationIntegrationConfigs) {
      const registration = registry.register(config);
      const { projectKey } = config;
      expect(registration.bundle.pack).toEqual(pilotPackManifests[projectKey]);
      expect(registration.bundle.adapter).toEqual(pilotAdapterManifests[projectKey]);
      expect(registration.bundle.workflow).toEqual(pilotWorkflows[projectKey]);
      expect(registration.bundle.project).toEqual(pilotProjects[projectKey]);
      expect(registration.bundle.pack.packId).toBe(expectedIdentities[projectKey].packId);
      expect(registration.bundle.adapter.adapterId).toBe(
        expectedIdentities[projectKey].adapterId
      );
      expect(registration.bundle.adapter.riskClass).toBe(
        expectedIdentities[projectKey].riskClass
      );
    }
    expect(registry.list().map((registration) => registration.projectKey)).toEqual([
      ...pilotProjectKeys
    ]);
  });

  it("registers demo_sandbox end-to-end with a simulation-only contract", () => {
    const registration = buildSimulationProjectIntegrationRegistration(demoIntegrationConfig);
    const { bundle } = registration;

    expect(bundle.projectKey).toBe("demo_sandbox");
    expect(bundle.project.id).toBe("prj_demo_sandbox");
    expect(bundle.pack.projectId).toBe("prj_demo_sandbox");
    expect(bundle.pack.adapterRefs).toEqual([bundle.adapter.adapterId]);
    expect(bundle.workflow.packId).toBe(bundle.pack.packId);
    expect(bundle.adapter.status).toBe("SANDBOXED");
    expect(bundle.adapter.simulationOnly).toBe(true);
    expect(bundle.adapter.writeScopes).toEqual([]);
    expect(bundle.adapter.controlledWriteBindings).toEqual([]);
    expect(bundle.adapter.sideEffects).toEqual(["none"]);
    expect(bundle.adapter.authRequirements).toEqual([]);
    expect(bundle.adapter.dryRunSupported).toBe(true);
    expect(bundle.pack.evidenceRules.minimumLevel).toBe("E2");

    expect(registration.packRegistryEntry).toMatchObject({
      projectId: "prj_demo_sandbox",
      packId: "pack_demo_sandbox_simulation",
      version: "1.0.0",
      status: "ACTIVE",
      rollbackPlan: "discard_simulation_run"
    });
    expect(registration.adapterRegistryEntry).toMatchObject({
      projectId: "prj_demo_sandbox",
      packId: "pack_demo_sandbox_simulation",
      packVersion: "1.0.0",
      adapterId: "adapter_demo_sandbox_simulation",
      status: "SANDBOXED"
    });
    expect(registration.adapterInput).toMatchObject({
      projectKey: "demo_sandbox",
      projectRef: "prj_demo_sandbox",
      status: "SANDBOXED",
      readiness: "READY",
      simulationOnly: true,
      writeScopes: []
    });

    const inputs = buildSimulationAdapterInputs({
      demo_sandbox: bundle.adapter
    });
    expect(inputs).toEqual([registration.adapterInput]);

    const registry = createSimulationIntegrationRegistry();
    expect(registry.register(demoIntegrationConfig).projectKey).toBe("demo_sandbox");
    expect(() => registry.register(demoIntegrationConfig)).toThrow("already registered");
    expect(registry.list()).toHaveLength(1);

    // The synthetic fifth project does not touch the four pilot fixtures.
    expect(validateAllPilotFixtures()).toHaveLength(4);
  });

  it("accepts any valid project key and rejects malformed keys", () => {
    const registry = createSimulationIntegrationRegistry();
    const first = registry.register(demoIntegrationConfig);
    const second = registry.register({
      projectKey: "zeta_lab",
      projectTypeKey: "zeta_research_pack",
      packId: "pack_zeta_lab_simulation",
      adapterId: "adapter_zeta_lab_simulation",
      sourceSystem: "ZETA_LAB_SIMULATION"
    });
    expect(first.bundle.project.id).toBe("prj_demo_sandbox");
    expect(second.bundle.project.id).toBe("prj_zeta_lab");
    expect(second.packRegistryEntry.id).toContain("pack_zeta_lab_simulation");

    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, projectKey: "Bad-Key" }))
    ).toThrow("projectKey");
    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, projectKey: "1bad" }))
    ).toThrow("projectKey");
  });

  it("fails closed for missing fields and unknown config keys", () => {
    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, sourceSystem: undefined }))
    ).toThrow();
    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, packId: "" }))
    ).toThrow();
    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, persistToProduction: true }))
    ).toThrow();
  });

  it("fails closed on an unparseable compatibilityRange", () => {
    // S1 gate: the range must be truly parseable; garbage fails closed.
    expect(() =>
      buildSimulationProjectIntegration(
        asConfig({ ...demoIntegrationConfig, compatibilityRange: "not-a-semver-range" })
      )
    ).toThrow("Invalid semver range");
    // Empty string is rejected too even though `semver` treats "" as "*".
    expect(() =>
      buildSimulationProjectIntegration(
        asConfig({ ...demoIntegrationConfig, compatibilityRange: "" })
      )
    ).toThrow();
  });

  it("keeps a valid custom compatibilityRange verbatim and applies the default when omitted", () => {
    const customRange = "^1.0.0";
    const registration = buildSimulationProjectIntegrationRegistration({
      ...demoIntegrationConfig,
      compatibilityRange: customRange
    });
    expect(registration.bundle.pack.compatibilityRange).toBe(customRange);
    expect(registration.bundle.adapter.compatibilityRange).toBe(customRange);

    const defaulted = buildSimulationProjectIntegration({
      projectKey: "range_gate_lab",
      projectTypeKey: "range_gate_research_pack",
      packId: "pack_range_gate_lab_simulation",
      adapterId: "adapter_range_gate_lab_simulation",
      sourceSystem: "RANGE_GATE_LAB_SIMULATION"
    });
    expect(defaulted.pack.compatibilityRange).toBe(">=1.0.0 <2.0.0");
    expect(defaulted.adapter.compatibilityRange).toBe(">=1.0.0 <2.0.0");
  });

  it("fails closed on cross-project scope reuse", () => {
    expect(() =>
      buildSimulationProjectIntegration(
        asConfig({ ...demoIntegrationConfig, scope: { projectId: "prj_other_project" } })
      )
    ).toThrow("scope.projectId");

    const registration = buildSimulationProjectIntegrationRegistration(demoIntegrationConfig);
    expect(() =>
      assertAdapterRegistryConsistency({
        pack: registration.bundle.pack,
        adapter: {
          ...registration.bundle.adapter,
          scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_other_project" }
        },
        project: registration.bundle.project,
        workflows: [registration.bundle.workflow]
      })
    ).toThrow();

    const registry = createSimulationIntegrationRegistry();
    registry.register(demoIntegrationConfig);
    expect(() =>
      registry.register(
        asConfig({
          ...demoIntegrationConfig,
          projectKey: "demo_clone",
          projectId: "prj_demo_clone",
          scope: { projectId: "prj_demo_clone" }
        })
      )
    ).toThrow("already registered");
  });

  it("fails closed on illegal status transitions", () => {
    expect(() => assertAdapterStatusTransition("SANDBOXED", "CONTROLLED_WRITE")).toThrow(
      "Cannot transition Adapter"
    );
    expect(() => assertProjectPackStatusTransition("ACTIVE", "DRAFT")).toThrow(
      "Cannot transition Project Pack"
    );
    expect(() =>
      buildSimulationProjectIntegration(
        asConfig({ ...demoIntegrationConfig, adapterStatus: "READ_ONLY_READY" })
      )
    ).toThrow();
    expect(() =>
      buildSimulationProjectIntegration(asConfig({ ...demoIntegrationConfig, packStatus: "PAUSED" }))
    ).toThrow();
  });

  it("fails closed on any real write intent", () => {
    expect(() =>
      buildSimulationProjectIntegration({ ...demoIntegrationConfig, writeScopes: ["external:write"] })
    ).toThrow("simulationOnly");
    expect(() =>
      buildSimulationProjectIntegration({ ...demoIntegrationConfig, authRequirements: ["oauth"] })
    ).toThrow("simulationOnly");
    expect(() =>
      buildSimulationProjectIntegration({ ...demoIntegrationConfig, sideEffects: ["external_write"] })
    ).toThrow("simulationOnly");
    expect(() =>
      buildSimulationProjectIntegration({ ...demoIntegrationConfig, budgetPolicy: { mode: "LIVE" } })
    ).toThrow("SIMULATION_ONLY");
    expect(() =>
      assertSimulationOnlyAdapter({
        ...pilotAdapterManifests.uaos,
        controlledWriteBindings: [{ actionRef: "action_write", resourceRef: "resource_write" }]
      })
    ).toThrow("simulationOnly");
    expect(() =>
      assertSimulationOnlyAdapter({ ...pilotAdapterManifests.uaos, status: "READ_ONLY_READY" })
    ).toThrow("simulationOnly");
  });

  it("keeps E0 material out of FACT claims on the demo path", () => {
    const claim = {
      id: "claim_demo_sandbox",
      schemaVersion: "1.0",
      scope: {
        organizationId: "org_simulation",
        workspaceId: "ws_simulation",
        projectId: "prj_demo_sandbox"
      },
      createdBy: "controller",
      createdAt: "2026-09-20T00:00:00Z",
      updatedAt: "2026-09-20T00:00:00Z",
      sourceRefs: ["source_demo_sandbox"],
      metadata: {},
      questionRef: "question_demo_sandbox",
      statement: "Synthetic sandbox material cannot be promoted to a fact.",
      claimType: "FACT",
      evidenceLevel: "E0",
      confidence: "HIGH",
      status: "SUPPORTED",
      observedAt: "2026-09-20T00:00:00Z",
      contradictionRefs: []
    };
    expect(() => researchClaimSchema.parse(claim)).toThrow(
      "E0 material cannot be promoted to a FACT claim"
    );
    expect(
      researchClaimSchema.parse({ ...claim, evidenceLevel: "E3" }).claimType
    ).toBe("FACT");
  });

  it("keeps project names out of the universal integration kernel", () => {
    const kernel = readFileSync(new URL("./project-integration.ts", import.meta.url), "utf8");
    for (const projectName of ["uaos", "hesn", "ex_protocol", "bitmind", "demo_sandbox"]) {
      expect(kernel).not.toContain(projectName);
    }
  });
});
