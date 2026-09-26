import { describe, expect, it } from "vitest";
import {
  adapterManifestSchema,
  assertApprovalBinding,
  assertAttemptWithinLimit,
  approvalSchema,
  assertAuditReplayConsistency,
  assertControlledWriteAuthorized,
  assertContractSnapshotConsistency,
  assertExecutionIdentityConsistency,
  assertRetryAllowed,
  assertMetricDefinitionRegistryConsistency,
  assertProjectPackConsistency,
  assertReceiptEvidenceChain,
  budgetSchema,
  canTransitionUniversalStatus,
  evidenceSchema,
  eventEnvelopeSchema,
  INSUFFICIENT_DATA_SENTINEL,
  killSwitchSchema,
  metricDefinitionSchema,
  metricObservationSchema,
  normalizeLegacyRunStatus,
  policySchema,
  projectSchema,
  revocationSchema,
  taskReceiptSchema,
  transitionUniversalRun,
  transitionUniversalWorkItem,
  retryUniversalRun,
  universalScopeSchema,
  universalRunSchema,
  validateEventChain,
  validateWorkflowGraph,
  workflowDefinitionSchema,
  workflowEdgeSchema,
  workflowNodeSchema
} from "./universal-contracts.js";
import {
  pilotAdapterManifests,
  pilotAttempts,
  pilotAuditEvents,
  pilotEvidenceRecords,
  pilotEventChains,
  pilotMetricDefinitions,
  pilotMetricObservations,
  pilotPackManifests,
  pilotPolicies,
  pilotReceipts,
  pilotProjectKeys,
  pilotProjects,
  pilotReplayCheckpoints,
  pilotApprovals,
  pilotReviews,
  pilotRuns,
  pilotValidations,
  pilotWorkItems,
  pilotWorkflows,
  validateAllPilotFixtures
} from "./pilot-fixtures.js";

const timestamp = "2026-09-06T00:00:00Z";

describe("universal contracts", () => {
  it("validates a project in an explicit scope", () => {
    const project = projectSchema.parse({
      id: "prj_demo",
      schemaVersion: "1.0",
      scope: { workspaceId: "ws_demo", projectId: "prj_demo" },
      createdBy: "user_demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["spec:demo"],
      name: "Demo Project",
      packId: "pack_demo",
      packVersion: "1.0.0",
      typeKey: "demo",
      lifecycleState: "PILOT",
      ownerRef: "user_demo",
      riskPosture: "LOW",
      status: "ACTIVE"
    });

    expect(project.scope.projectId).toBe("prj_demo");
  });

  it("requires a versioned metric definition reference for observations", () => {
    const result = metricObservationSchema.safeParse({
      id: "obs_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "system",
      createdAt: timestamp,
      updatedAt: timestamp,
      metricKey: "verified_result_rate",
      projectId: "prj_demo",
      value: 1,
      unit: "ratio",
      periodStart: timestamp,
      periodEnd: timestamp,
      definitionVersion: "1.0",
      sourceEventRefs: ["evt_demo"],
      observedAt: timestamp,
      confidence: "HIGH",
      status: "SIMULATED"
    });

    expect(result.success).toBe(false);
  });

  it("enforces RATE operands and keeps INSUFFICIENT_DATA outside measured rates", () => {
    const definition = pilotMetricDefinitions.uaos;
    expect(metricDefinitionSchema.safeParse({ ...definition, numerator: "" }).success).toBe(false);
    expect(metricDefinitionSchema.safeParse({ ...definition, denominator: undefined }).success).toBe(false);

    const observation = pilotMetricObservations.uaos;
    expect(metricObservationSchema.safeParse({ ...observation, numerator: undefined }).success).toBe(false);
    expect(metricObservationSchema.safeParse({ ...observation, denominator: 0 }).success).toBe(false);
    expect(metricObservationSchema.safeParse({ ...observation, value: 0.5 }).success).toBe(false);
    expect(
      metricObservationSchema.safeParse({
        ...observation,
        status: "INSUFFICIENT_DATA",
        value: INSUFFICIENT_DATA_SENTINEL
      }).success
    ).toBe(false);
  });

  it("accepts an acyclic workflow and rejects invalid graph boundaries", () => {
    const base = {
      id: "wf_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "system",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["spec:workflow"],
      packId: "pack_demo",
      version: "1.0.0",
      nodes: [
        { nodeId: "discover", kind: "discover", riskClass: "LOW", timeoutMs: 1000 },
        { nodeId: "verify", kind: "verify", riskClass: "LOW", timeoutMs: 1000 }
      ],
      edges: [{ from: "discover", to: "verify" }]
    };
    const workflow = workflowDefinitionSchema.parse(base);
    expect(() => validateWorkflowGraph(workflow)).not.toThrow();

    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        edges: [
          { from: "discover", to: "verify" },
          { from: "verify", to: "discover" }
        ]
      })
    ).toThrow(/acyclic/);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        edges: [{ from: "discover", to: "missing" }]
      })
    ).toThrow(/unknown node/);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        approvalPoints: ["missing"]
      })
    ).toThrow(/approval point/);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        edges: [
          { from: "discover", to: "verify" },
          { from: "discover", to: "verify" }
        ]
      })
    ).toThrow(/duplicate edges/);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        edges: [{ from: "discover", to: "verify", failureRoute: "missing" }]
      })
    ).toThrow(/failure route/);
    expect(
      workflowNodeSchema.safeParse({
        ...base.nodes[0],
        unexpectedNodeField: true
      }).success
    ).toBe(false);
    expect(
      workflowEdgeSchema.safeParse({
        ...base.edges[0],
        unexpectedEdgeField: true
      }).success
    ).toBe(false);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        nodes: [base.nodes[0], base.nodes[0]]
      })
    ).toThrow(/node IDs must be unique/);
    expect(() =>
      workflowDefinitionSchema.parse({
        ...base,
        approvalPoints: ["discover", "discover"]
      })
    ).toThrow(/approval points must be unique/);
    expect(() => validateWorkflowGraph(workflow)).not.toThrow();
  });

  it("rejects a zero value for INSUFFICIENT_DATA but accepts a non-zero sentinel", () => {
    const base = {
      id: "obs_insufficient",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "system",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["event:demo"],
      definitionRef: "metric_def_demo",
      metricKey: "verified_result_rate",
      projectId: "prj_demo",
      unit: "ratio",
      periodStart: timestamp,
      periodEnd: timestamp,
      definitionVersion: "1.0",
      sourceEventRefs: ["evt_demo"],
      observedAt: timestamp,
      confidence: "UNKNOWN" as const,
      status: "INSUFFICIENT_DATA" as const
    };
    expect(metricObservationSchema.safeParse({ ...base, value: 0 }).success).toBe(false);
    expect(metricObservationSchema.safeParse({ ...base, value: 1 }).success).toBe(false);
    expect(
      metricObservationSchema.safeParse({ ...base, value: INSUFFICIENT_DATA_SENTINEL }).success
    ).toBe(true);
    expect(
      metricObservationSchema.safeParse({
        ...base,
        status: "SIMULATED",
        value: INSUFFICIENT_DATA_SENTINEL
      }).success
    ).toBe(false);
  });

  it("requires a traceable evidence and validation chain for VERIFIED_SUCCESS", () => {
    const base = {
      id: "receipt_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "system",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["run:demo"],
      workItemId: "work_demo",
      runId: "run_demo",
      actorRef: "actor_demo",
      workflowVersion: "1.0.0",
      inputSnapshotRef: "input_demo_v1",
      policySnapshotRef: "policy_demo_v1",
      resultStatus: "VERIFIED_SUCCESS" as const,
      producedAt: timestamp
    };
    expect(taskReceiptSchema.safeParse(base).success).toBe(false);
    expect(
      taskReceiptSchema.safeParse({
        ...base,
        evidenceRefs: ["evidence_demo"],
        validationRefs: ["validation_demo"]
      }).success
    ).toBe(true);
  });

  it("requires object-level Receipt, Validation, and Evidence consistency", () => {
    const receipt = pilotReceipts.uaos;
    const validation = pilotValidations.uaos;
    const evidence = pilotEvidenceRecords.uaos;

    expect(() =>
      assertReceiptEvidenceChain({ receipt, validations: [validation], evidences: [evidence] })
    ).not.toThrow();
    expect(
      evidenceSchema.safeParse({ ...evidence, unexpectedEvidenceField: true }).success
    ).toBe(false);
    expect(() =>
      assertReceiptEvidenceChain({
        receipt,
        validations: [{ ...validation, receiptRef: "receipt_other" }],
        evidences: [evidence]
      })
    ).toThrow(/not a passed validation/);
    expect(() =>
      assertReceiptEvidenceChain({
        receipt,
        validations: [{ ...validation, evidenceRefs: ["evidence_other"] }],
        evidences: [evidence]
      })
    ).toThrow(/missing evidence/);
    expect(() =>
      assertReceiptEvidenceChain({
        receipt: { ...receipt, evidenceRefs: ["evidence_other"] },
        validations: [validation],
        evidences: [evidence]
      })
    ).toThrow(/outside the receipt set/);
  });

  it("normalizes the legacy Growth cancellation spelling at the boundary", () => {
    expect(normalizeLegacyRunStatus("cancelled")).toBe("CANCELED");
    expect(normalizeLegacyRunStatus("running")).toBe("running");
  });

  it("rejects cross-project objects and mismatched project scopes", () => {
    const project = {
      id: "prj_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "user_demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["spec:demo"],
      name: "Demo Project",
      packId: "pack_demo",
      packVersion: "1.0.0",
      typeKey: "demo",
      lifecycleState: "PILOT",
      ownerRef: "user_demo",
      riskPosture: "LOW" as const,
      status: "ACTIVE" as const
    };
    expect(projectSchema.safeParse({ ...project, scope: { projectId: "prj_other" } }).success).toBe(false);
    expect(
      projectSchema.safeParse({
        ...project,
        scope: { projectId: "prj_demo", unexpectedNestedField: "must reject" }
      }).success
    ).toBe(false);

    expect(
      metricObservationSchema.safeParse({
        id: "obs_demo",
        schemaVersion: "1.0",
        scope: { projectId: "prj_other" },
        createdBy: "system",
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceRefs: ["event:demo"],
        definitionRef: "metric_def_demo",
        metricKey: "verified_result_rate",
        projectId: "prj_demo",
        value: 1,
        unit: "ratio",
        periodStart: timestamp,
        periodEnd: timestamp,
        definitionVersion: "1.0",
        sourceEventRefs: ["evt_demo"],
        observedAt: timestamp,
        confidence: "HIGH",
        status: "SIMULATED"
      }).success
    ).toBe(false);
  });

  it("requires sourceRefs and does not silently accept the snake_case spelling", () => {
    const valid = {
      id: "prj_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "user_demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["spec:demo"],
      name: "Demo Project",
      packId: "pack_demo",
      packVersion: "1.0.0",
      typeKey: "demo",
      lifecycleState: "PILOT",
      ownerRef: "user_demo",
      riskPosture: "LOW" as const,
      status: "ACTIVE" as const
    };
    const missing = { ...valid } as Record<string, unknown>;
    delete missing.sourceRefs;

    expect(projectSchema.safeParse(missing).success).toBe(false);
    expect(projectSchema.safeParse({ ...valid, source_refs: ["spec:demo"] }).success).toBe(false);
    expect(projectSchema.parse(valid).sourceRefs).toEqual(["spec:demo"]);
  });

  it("rejects unknown fields in nested universal scopes", () => {
    expect(
      universalScopeSchema.safeParse({
        projectId: "prj_demo",
        unknownScopeField: "must-not-be-stripped"
      }).success
    ).toBe(false);
  });

  it("blocks CONTROLLED_WRITE without approval evidence", () => {
    const result = adapterManifestSchema.safeParse({
      ...pilotAdapterManifests.uaos,
      status: "CONTROLLED_WRITE",
      writeScopes: ["project:write"]
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path[0] === "approvalRefs")).toBe(true);
    }
  });

  it("requires action/resource identity at the CONTROLLED_WRITE schema boundary", () => {
    const entity = {
      id: "policy_demo",
      schemaVersion: "1.0",
      scope: { projectId: "prj_demo" },
      createdBy: "operator_demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["fixture:demo"],
      policyKey: "policy-demo",
      version: "1.0.0",
      actionClass: "CONTROLLED_WRITE" as const,
      riskClass: "HIGH" as const,
      decision: "REQUIRE_APPROVAL" as const,
      requiresApproval: true,
      status: "ACTIVE" as const
    };
    expect(policySchema.safeParse(entity).success).toBe(false);
    expect(
      approvalSchema.safeParse({
        id: "approval_demo",
        schemaVersion: "1.0",
        scope: { projectId: "prj_demo" },
        createdBy: "operator_demo",
        createdAt: timestamp,
        updatedAt: timestamp,
        sourceRefs: ["fixture:demo"],
        policyRef: "policy_demo",
        actionClass: "CONTROLLED_WRITE",
        subjectRef: "adapter_demo",
        requestedBy: "operator_demo",
        status: "APPROVED",
        approverRef: "reviewer_demo",
        requestedAt: timestamp,
        decidedAt: timestamp
      }).success
    ).toBe(false);
  });

  it("requires active, versioned, same-identity safety contracts", () => {
    const entity = {
      schemaVersion: "1.0",
      scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_uaos" },
      createdBy: "operator_demo",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["fixture:uaos"]
    };
    const policy = policySchema.parse({
      ...entity,
      id: "policy_uaos_v1",
      policyKey: "uaos-control",
      version: "1.0.0",
      actionClass: "CONTROLLED_WRITE",
      riskClass: "HIGH",
      decision: "REQUIRE_APPROVAL",
      requiresApproval: true,
      subjectRef: "adapter_uaos_simulation",
      actionRef: "publish_result",
      resourceRef: "resource_campaign_uaos",
      budgetRef: "budget_uaos_v1",
      revocationRef: "revocation_uaos_v1",
      killSwitchRef: "kill_uaos_v1",
      status: "ACTIVE"
    });
    const budget = budgetSchema.parse({
      ...entity,
      id: "budget_uaos_v1",
      budgetKey: "uaos-budget",
      version: "1.0.0",
      unit: "simulation_units",
      limit: 100,
      consumed: 0,
      subjectRef: "adapter_uaos_simulation",
      resourceRef: "resource_campaign_uaos",
      status: "ACTIVE"
    });
    const approval = approvalSchema.parse({
      ...entity,
      id: "approval_uaos_v1",
      policyRef: policy.id,
      policyVersion: policy.version,
      actionClass: "CONTROLLED_WRITE",
      subjectRef: "adapter_uaos_simulation",
      actionRef: "publish_result",
      resourceRef: "resource_campaign_uaos",
      requestedBy: "operator_demo",
      approverRef: "reviewer_demo",
      status: "APPROVED",
      requestedAt: timestamp,
      decidedAt: timestamp
    });
    const revocation = revocationSchema.parse({
      ...entity,
      id: "revocation_uaos_v1",
      version: "1.0.0",
      targetRef: "adapter_uaos_simulation",
      resourceRef: "resource_campaign_uaos",
      reason: "manual stop line",
      status: "REVOKED",
      effectiveAt: timestamp
    });
    const killSwitch = killSwitchSchema.parse({
      ...entity,
      id: "kill_uaos_v1",
      version: "1.0.0",
      targetRef: "adapter_uaos_simulation",
      resourceRef: "resource_campaign_uaos",
      reason: "emergency stop",
      state: "ARMED"
    });
    const manifest = adapterManifestSchema.parse({
      ...pilotAdapterManifests.uaos,
      status: "CONTROLLED_WRITE",
      writeScopes: ["project:write"],
      policyRef: policy.id,
      policyVersion: policy.version,
      budgetRef: budget.id,
      budgetVersion: budget.version,
      approvalRefs: [approval.id],
      revocationRef: revocation.id,
      revocationVersion: revocation.version,
      killSwitchRef: killSwitch.id,
      killSwitchVersion: killSwitch.version,
      controlledWriteBindings: [
        { actionRef: "publish_result", resourceRef: "resource_campaign_uaos" },
        { actionRef: "archive_result", resourceRef: "resource_archive_uaos" }
      ]
    });

    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).not.toThrow();
    expect(() =>
      assertContractSnapshotConsistency({
        manifest,
        policy: { ...policy, status: "DRAFT" },
        budget,
        approval,
        revocation,
        killSwitch
      })
    ).toThrow(/active referenced policy/i);
    // A different action or resource cannot reuse the same approval record.
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "archive_result",
        resourceRef: "resource_archive_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/policy identity|approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_archive_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/action\/resource/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy: { ...policy, resourceRef: "resource_other" },
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/policy identity/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget: { ...budget, resourceRef: "resource_other" },
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/budget identity/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [{ ...approval, resourceRef: "resource_other" }],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, resourceRef: "resource_other" },
        killSwitch
      })
    ).toThrow(/revocation target/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch: { ...killSwitch, resourceRef: "resource_other" }
      })
    ).toThrow(/kill switch target/);
    // A referenced budget ID is not enough: its project scope must also match.
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget: { ...budget, scope: { projectId: "prj_other" } },
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/authorization resources/);
    // The manifest project is part of the authorization identity and cannot be borrowed.
    expect(() =>
      assertControlledWriteAuthorized({
        manifest: { ...manifest, projectRef: "prj_other" },
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval|authorization resources|scope\.projectId/);
    // The manifest adapter/resource identity must match the approval and stop-line records.
    expect(() =>
      assertControlledWriteAuthorized({
        manifest: { ...manifest, adapterId: "adapter_other" },
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/policy identity|approved matching approval|revocation target|kill switch target/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [{ ...approval, subjectRef: "adapter_other" }],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [{ ...approval, policyRef: "policy_other" }],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [{ ...approval, scope: { projectId: "prj_other" } }],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy: { ...policy, decision: "DENY" },
        budget,
        approvals: [approval],
        revocation,
        killSwitch
      })
    ).toThrow(/allow or approval-gated policy/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [{ ...approval, actionClass: "SIMULATION" }],
        revocation,
        killSwitch
      })
    ).toThrow(/approved matching approval/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, status: "ACTIVE" },
        killSwitch
      })
    ).toThrow(/revocation/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, targetRef: "adapter_other" },
        killSwitch
      })
    ).toThrow(/revocation target/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation: { ...revocation, scope: { projectId: "prj_other" } },
        killSwitch
      })
    ).toThrow(/revocation target|authorization resources/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch: {
          ...killSwitch,
          state: "TRIGGERED",
          triggeredAt: timestamp,
          triggeredBy: "operator_demo"
        }
      })
    ).toThrow(/kill switch/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch: { ...killSwitch, targetRef: "adapter_other" }
      })
    ).toThrow(/kill switch target/);
    expect(() =>
      assertControlledWriteAuthorized({
        manifest,
        actionRef: "publish_result",
        resourceRef: "resource_campaign_uaos",
        policy,
        budget,
        approvals: [approval],
        revocation,
        killSwitch: { ...killSwitch, scope: { projectId: "prj_other" } }
      })
    ).toThrow(/kill switch target|authorization resources/);
  });
});

describe("four-project simulation fixtures", () => {
  it("validates all pilot packs, read-only adapters, and causal event chains", () => {
    const results = validateAllPilotFixtures();

    expect(results.map((item) => item.projectKey)).toEqual([...pilotProjectKeys]);
    expect(results.every((item) => item.simulationOnly)).toBe(true);
    expect(results.reduce((sum, item) => sum + item.eventCount, 0)).toBe(18);
    for (const key of pilotProjectKeys) {
      const adapter = pilotAdapterManifests[key];
      expect(adapter.status).toBe("SANDBOXED");
      expect(adapter.inputSchema.mode).toBe("SIMULATION");
      expect(adapter.sideEffects).toEqual(["none"]);
      expect(adapter.writeScopes).toEqual([]);
    }
  });

  it("pins Run and Receipt snapshots to exact manifest and policy versions", () => {
    const receipt = pilotReceipts.uaos;
    const run = universalRunSchema.parse({
      id: receipt.runId,
      schemaVersion: "1.0",
      scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_uaos" },
      createdBy: "fixture_uaos",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["fixture:uaos"],
      workItemId: receipt.workItemId,
      workflowVersion: receipt.workflowVersion,
      workflowRef: receipt.workflowRef,
      mode: "SIMULATION",
      status: "COMPLETED",
      inputSnapshotRef: receipt.inputSnapshotRef,
      policySnapshotRef: receipt.policySnapshotRef,
      manifestRef: receipt.manifestRef,
      manifestVersion: receipt.manifestVersion,
      policySnapshotVersion: receipt.policySnapshotVersion,
      approvalRefs: receipt.approvalRefs,
      endedAt: timestamp
    });

    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        run,
        receipt
      })
    ).toThrow(/requires a Workflow snapshot/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: pilotWorkflows.uaos,
        run,
        receipt
      })
    ).not.toThrow();
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: pilotWorkflows.uaos,
        run,
        receipt: { ...receipt, manifestVersion: "9.9.9" }
      })
    ).toThrow(/snapshot/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: pilotWorkflows.uaos,
        run,
        receipt: { ...receipt, policySnapshotVersion: undefined }
      })
    ).toThrow(/snapshot/);
  });

  it("rejects budget ref/version mismatches and workflow project/version mismatches", () => {
    const receipt = pilotReceipts.uaos;
    const budget = budgetSchema.parse({
      id: "budget_uaos_v1",
      schemaVersion: "1.0",
      scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_uaos" },
      createdBy: "fixture_uaos",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["fixture:uaos"],
      budgetKey: "budget_uaos",
      version: "1.0.0",
      unit: "simulation_units",
      limit: 100,
      consumed: 0,
      subjectRef: pilotAdapterManifests.uaos.adapterId,
      resourceRef: "resource_uaos",
      status: "ACTIVE"
    });
    const workflow = workflowDefinitionSchema.parse({
      id: pilotWorkflows.uaos.id,
      schemaVersion: "1.0",
      scope: { organizationId: "org_simulation", workspaceId: "ws_simulation", projectId: "prj_uaos" },
      createdBy: "fixture_uaos",
      createdAt: timestamp,
      updatedAt: timestamp,
      sourceRefs: ["fixture:uaos"],
      packId: "pack_uaos_engineering",
      version: receipt.workflowVersion,
      nodes: [{ nodeId: "start", kind: "start", riskClass: "LOW", timeoutMs: 1000 }],
      edges: []
    });

    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        budget,
        workflow,
        receipt: {
          ...receipt,
          budgetSnapshotRef: "budget_other",
          budgetSnapshotVersion: budget.version
        }
      })
    ).toThrow(/budget version/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        budget,
        workflow,
        receipt: {
          ...receipt,
          budgetSnapshotRef: budget.id,
          budgetSnapshotVersion: "9.9.9"
        }
      })
    ).toThrow(/budget version/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: { ...workflow, scope: { projectId: "prj_other" } },
        receipt
      })
    ).toThrow(/Workflow snapshot does not match the manifest project|scope mismatch/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: { ...workflow, version: "9.9.9" },
        receipt
      })
    ).toThrow(/workflow version/);
    expect(() =>
      assertContractSnapshotConsistency({
        manifest: pilotAdapterManifests.uaos,
        policy: pilotPolicies.uaos,
        approval: pilotApprovals.uaos,
        workflow: { ...pilotWorkflows.uaos, id: "workflow_unrelated" },
        run: pilotRuns.uaos,
        receipt
      })
    ).toThrow(/workflow identity/);
  });

  it("enforces the complete WorkItem to Review identity chain", () => {
    const key = "uaos" as const;
    const base = {
      workItem: pilotWorkItems[key],
      run: pilotRuns[key],
      receipt: pilotReceipts[key],
      workflow: pilotWorkflows[key],
      evidences: [pilotEvidenceRecords[key]],
      validations: [pilotValidations[key]],
      observations: [pilotMetricObservations[key]],
      reviews: [pilotReviews[key]],
      approvals: [pilotApprovals[key]]
    };
    expect(() => assertExecutionIdentityConsistency(base)).not.toThrow();
    expect(() =>
      assertExecutionIdentityConsistency({ ...base, workflow: undefined })
    ).toThrow(/requires a Workflow snapshot/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        workflow: { ...base.workflow, version: "9.9.9" }
      })
    ).toThrow(/workflow identity\/version/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        receipt: { ...base.receipt, evidenceRefs: ["evidence_missing"] }
      })
    ).toThrow(/Receipt references missing execution evidence/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        receipt: { ...base.receipt, validationRefs: [base.validations[0].id] },
        validations: [{ ...base.validations[0], status: "FAILED" }]
      })
    ).toThrow(/must be PASSED/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        run: { ...base.run, workItemId: "work_item_other" }
      })
    ).toThrow(/identity chain/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        evidences: [{ ...base.evidences[0], scope: { ...base.evidences[0].scope, projectId: "prj_other" } }]
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        observations: [{
          ...base.observations[0],
          scope: { ...base.observations[0].scope, organizationId: "org_other" }
        }]
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        approvals: [{
          ...base.approvals[0],
          scope: { ...base.approvals[0].scope, workspaceId: "ws_other" }
        }]
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertExecutionIdentityConsistency({
        ...base,
        reviews: [{ ...base.reviews[0], approvalRef: "approval_missing" }]
      })
    ).toThrow(/missing Approval/);
  });

  it("binds Pack, Project, Workflow, Adapter, Run, and Receipt transitively", () => {
    const key = "uaos" as const;
    const valid = {
      pack: pilotPackManifests[key],
      project: pilotProjects[key],
      workflow: pilotWorkflows[key],
      adapter: pilotAdapterManifests[key],
      run: pilotRuns[key],
      receipt: pilotReceipts[key]
    };
    expect(() => assertProjectPackConsistency(valid)).not.toThrow();
    expect(() =>
      assertProjectPackConsistency({ ...valid, workflow: pilotWorkflows.hesn })
    ).toThrow(/Workflow .*Pack project\/version/);
    expect(() =>
      assertProjectPackConsistency({ ...valid, adapter: pilotAdapterManifests.hesn })
    ).toThrow(/Adapter .*not registered|Adapter .*Pack project\/version/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        receipt: { ...valid.receipt, manifestVersion: "9.9.9" }
      })
    ).toThrow(/adapter snapshot/);
    expect(() =>
      assertProjectPackConsistency({
        pack: valid.pack,
        project: valid.project,
        workflow: valid.workflow,
        run: { ...valid.run, manifestRef: "adapter_unregistered" },
        receipt: { ...valid.receipt, manifestRef: "adapter_unregistered" }
      })
    ).toThrow(/not registered by the Pack/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        adapter: undefined,
        run: { ...valid.run, scope: { ...valid.run.scope, workspaceId: "ws_other" } }
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        adapter: { ...valid.adapter, scope: { ...valid.adapter.scope, organizationId: "org_other" } }
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        run: { ...valid.run, workflowRef: "workflow_same_version_other_identity" }
      })
    ).toThrow(/workflow identity/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        run: { ...valid.run, workflowRef: undefined }
      })
    ).toThrow(/workflow identity/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        workflow: { ...valid.workflow, id: "workflow_same_version_other_identity" },
        run: { ...valid.run, workflowRef: "workflow_same_version_other_identity" },
        receipt: { ...valid.receipt, workflowRef: "workflow_same_version_other_identity" }
      })
    ).toThrow(/not registered by the Pack/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        pack: { ...valid.pack, projectId: "prj_other" }
      })
    ).toThrow(/Pack project|scope\.projectId/);
    expect(() =>
      assertProjectPackConsistency({
        ...valid,
        run: { ...valid.run, scope: { ...valid.run.scope, projectId: "prj_other" } },
        receipt: { ...valid.receipt, scope: { ...valid.receipt.scope, projectId: "prj_other" } }
      })
    ).toThrow(/scope mismatch|Runtime object/);
  });

  it("requires registered metric definitions and exact versions", () => {
    const key = "uaos" as const;
    const definition = metricDefinitionSchema.parse(pilotMetricDefinitions[key]);
    const observation = pilotMetricObservations[key];
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [observation]
      })
    ).not.toThrow();
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{ ...observation, definitionRef: "metric_missing" }]
      })
    ).toThrow(/missing definition/);
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{ ...observation, definitionVersion: "9.9.9" }]
      })
    ).toThrow(/version\/project/);
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{
          ...observation,
          projectId: "prj_other",
          scope: { ...observation.scope, projectId: "prj_other" }
        }]
      })
    ).toThrow(/scope mismatch|Pack project/);
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{ ...observation, aggregation: "COUNT" }]
      })
    ).toThrow(/aggregation/);
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{ ...observation, aggregation: undefined }]
      })
    ).toThrow(/aggregation/);
    expect(() =>
      assertMetricDefinitionRegistryConsistency({
        pack: pilotPackManifests[key],
        definitions: [definition],
        observations: [{ ...observation, denominator: undefined }]
      })
    ).toThrow(/numerator\/denominator|denominator/);
  });

  it("provides a minimal bound Audit/Replay chain without persistence", () => {
    const key = "uaos" as const;
    const valid = {
      run: pilotRuns[key],
      receipt: pilotReceipts[key],
      attempts: [pilotAttempts[key]],
      checkpoints: [pilotReplayCheckpoints[key]],
      auditEvents: pilotAuditEvents[key]
    };
    expect(() => assertAuditReplayConsistency(valid)).not.toThrow();
    expect(() =>
      assertAuditReplayConsistency({ ...valid, checkpoints: [] })
    ).toThrow(/requires an attempt, checkpoint, and audit event/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        checkpoints: [{ ...valid.checkpoints[0], workflowVersion: "9.9.9" }]
      })
    ).toThrow(/Run\/Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        auditEvents: [{ ...valid.auditEvents[0], scope: { ...valid.auditEvents[0].scope, projectId: "prj_other" } }]
      })
    ).toThrow(/scope mismatch/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        receipt: { ...valid.receipt, replayRef: "checkpoint_missing" }
      })
    ).toThrow(/existing replay checkpoint/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        receipt: { ...valid.receipt, replayRef: "checkpoint_uaos_other" },
        attempts: [
          valid.attempts[0],
          { ...valid.attempts[0], id: "attempt_uaos_other", checkpointRef: "checkpoint_uaos_other" }
        ],
        checkpoints: [
          valid.checkpoints[0],
          { ...valid.checkpoints[0], id: "checkpoint_uaos_other", attemptId: "attempt_uaos_other" }
        ]
      })
    ).toThrow(/same Attempt|Run\/Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        run: { ...valid.run, attemptRef: undefined }
      })
    ).toThrow(/must reference an Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        receipt: { ...valid.receipt, attemptRef: undefined }
      })
    ).toThrow(/must reference an Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        receipt: { ...valid.receipt, attemptRef: "attempt_other" }
      })
    ).toThrow(/same Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        attempts: [{ ...valid.attempts[0], checkpointRef: "checkpoint_missing" }]
      })
    ).toThrow(/checkpointRef/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        checkpoints: [{ ...valid.checkpoints[0], status: "INVALIDATED" }]
      })
    ).toThrow(/Run\/Attempt/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        auditEvents: [
          valid.auditEvents[0],
          { ...valid.auditEvents[1], idempotencyKey: valid.auditEvents[0].idempotencyKey }
        ]
      })
    ).toThrow(/idempotency keys/);
    expect(() =>
      assertAuditReplayConsistency({
        ...valid,
        auditEvents: [{ ...valid.auditEvents[0], receiptRef: undefined }, valid.auditEvents[1]]
      })
    ).toThrow(/Run\/Attempt\/Receipt/);
  });

  it("rejects duplicate event IDs and duplicate idempotency keys", () => {
    const original = eventEnvelopeSchema.parse(pilotEventChains.uaos[0]);
    expect(() => validateEventChain([original, { ...original, causationId: original.eventId }])).toThrow(
      /Duplicate event ID/
    );
    expect(pilotProjectKeys.every((key) => pilotAdapterManifests[key].writeScopes.length === 0)).toBe(true);
  });

  it("keeps Universal lifecycle terminal and retry transitions fail closed", () => {
    expect(canTransitionUniversalStatus("PAUSED", "RUNNING")).toBe(true);
    expect(canTransitionUniversalStatus("COMPLETED", "RUNNING")).toBe(false);
    expect(() => transitionUniversalRun(pilotRuns.uaos, "RUNNING", timestamp)).toThrow(/Invalid Universal/);

    const failed = universalRunSchema.parse({
      ...pilotRuns.uaos,
      status: "FAILED",
      attemptNumber: 1,
      endedAt: timestamp
    });
    expect(assertRetryAllowed(failed, 2)).toBe(2);
    expect(() => assertRetryAllowed(failed, 1)).toThrow(/maxAttempts/);
    expect(retryUniversalRun(failed, 2, timestamp)).toMatchObject({
      status: "QUEUED",
      attemptNumber: 2,
      attemptRef: undefined,
      endedAt: undefined
    });
    expect(() => transitionUniversalRun({ ...pilotRuns.uaos, status: "CANCELED" }, "QUEUED", timestamp)).toThrow(
      /Invalid Universal/
    );
    expect(() => transitionUniversalWorkItem({ ...pilotWorkItems.uaos, status: "CANCELED" }, "RUNNING", timestamp)).toThrow(
      /Invalid Universal/
    );
    expect(() => assertAttemptWithinLimit(3, 2)).toThrow(/maxAttempts/);
  });

  it("requires every controlled approval identity to match before authorization", () => {
    const approval = pilotApprovals.uaos;
    const input = {
      approval,
      scope: pilotRuns.uaos.scope,
      policyRef: pilotPolicies.uaos.id,
      policyVersion: pilotPolicies.uaos.version,
      actionRef: approval.actionRef!,
      resourceRef: approval.resourceRef!,
      subjectRef: approval.subjectRef
    };
    expect(() => assertApprovalBinding(input)).not.toThrow();
    expect(() => assertApprovalBinding({ ...input, approval: { ...approval, status: "PENDING" } })).toThrow(
      /scope, policy\/version, action\/resource, subject, and status/
    );
    expect(() => assertApprovalBinding({ ...input, scope: { ...input.scope, workspaceId: "ws_other" } })).toThrow(
      /scope mismatch/
    );
    expect(() => assertApprovalBinding({ ...input, approval: { ...approval, actionRef: "action_other" } })).toThrow(
      /scope, policy\/version, action\/resource, subject, and status/
    );
  });

  it("does not let replayRef bypass the Attempt checkpoint binding", () => {
    const valid = {
      run: pilotRuns.uaos,
      receipt: pilotReceipts.uaos,
      attempts: [pilotAttempts.uaos],
      checkpoints: [pilotReplayCheckpoints.uaos],
      auditEvents: pilotAuditEvents.uaos
    };
    expect(() => assertAuditReplayConsistency(valid)).not.toThrow();
    expect(() => assertAuditReplayConsistency({
      ...valid,
      attempts: [{ ...valid.attempts[0], checkpointRef: "checkpoint_other" }]
    })).toThrow(/checkpointRef/);
    expect(() => assertAuditReplayConsistency({
      ...valid,
      attempts: [{ ...valid.attempts[0], idempotencyKey: "attempt_idem_other" }],
      checkpoints: [{ ...valid.checkpoints[0], attemptId: "attempt_other" }]
    })).toThrow(/Run\/Attempt/);
  });
});
