import {
  adapterManifestSchema,
  attemptIdentitySchema,
  approvalSchema,
  assertAuditReplayConsistency,
  assertContractSnapshotConsistency,
  assertExecutionIdentityConsistency,
  assertMetricDefinitionRegistryConsistency,
  assertProjectPackConsistency,
  assertReceiptEvidenceChain,
  auditEventSchema,
  evidenceSchema,
  eventEnvelopeSchema,
  metricObservationSchema,
  metricDefinitionSchema,
  policySchema,
  projectPackManifestSchema,
  projectSchema,
  replayCheckpointSchema,
  receiptValidationSchema,
  reviewSchema,
  taskReceiptSchema,
  validateEventChain,
  universalRunSchema,
  workItemSchema,
  type AdapterManifest,
  type AttemptIdentity,
  type AuditEvent,
  type MetricDefinition,
  type UniversalApproval,
  type UniversalEvidence,
  type EventEnvelope,
  type MetricObservation,
  type ProjectPackManifest,
  type ReplayCheckpoint,
  type UniversalProject,
  type UniversalRun,
  type UniversalWorkItem,
  type WorkflowDefinition
} from "./universal-contracts.js";
import {
  buildSimulationProjectIntegration,
  type SimulationProjectIntegrationConfigInput
} from "./project-integration.js";
import { loadPilotProjectKeys, type PilotProjectKey } from "./pilot-manifest.js";

// P-0 清单外置：re-export the manifest layer so `@neuroclaw/shared` keeps a
// single entry point for the pilot project list and its loader.
export {
  loadPilotProjectKeys,
  loadPilotProjectManifest,
  parsePilotProjectManifest,
  pilotProjectKeySchema,
  pilotProjectManifestPath,
  pilotProjectManifestSchema,
  type PilotProjectKey,
  type PilotProjectManifest
} from "./pilot-manifest.js";

export const pilotProjectKeys: readonly PilotProjectKey[] = loadPilotProjectKeys();

const scopeFor = (projectKey: PilotProjectKey) => ({
  organizationId: "org_simulation",
  workspaceId: "ws_simulation",
  projectId: `prj_${projectKey}`
});

const event = (
  projectKey: PilotProjectKey,
  eventId: string,
  eventType: string,
  index: number,
  payload: Record<string, unknown>
): EventEnvelope => ({
  eventId,
  schemaVersion: "1.0",
  eventType,
  occurredAt: `2026-09-06T00:00:0${index}Z`,
  emittedAt: `2026-09-06T00:00:0${index}Z`,
  scope: scopeFor(projectKey),
  actorRef: `actor_${projectKey}`,
  subjectRef: `subject_${projectKey}`,
  correlationId: `corr_${projectKey}_simulation`,
  ...(index > 1 ? { causationId: `evt_${projectKey}_${index - 1}` } : {}),
  idempotencyKey: `idem_${projectKey}_${index}`,
  traceId: `trace_${projectKey}_simulation`,
  dataClass: "OPERATIONAL",
  payload: { ...payload, mode: "SIMULATION" }
});

export const pilotEventChains: Record<PilotProjectKey, readonly EventEnvelope[]> = {
  uaos: [
    event("uaos", "evt_uaos_1", "goal.created", 1, { stage: "goal" }),
    event("uaos", "evt_uaos_2", "task.run.completed", 2, { stage: "execution" }),
    event("uaos", "evt_uaos_3", "artifact.verified", 3, { stage: "delivery" }),
    event("uaos", "evt_uaos_4", "evaluation.recorded", 4, { stage: "review" })
  ],
  hesn: [
    event("hesn", "evt_hesn_1", "agent.discovered", 1, { stage: "discovery" }),
    event("hesn", "evt_hesn_2", "task.completed", 2, { stage: "activation" }),
    event("hesn", "evt_hesn_3", "receipt.verified", 3, { stage: "trust" }),
    event("hesn", "evt_hesn_4", "relation.created", 4, { stage: "retention" }),
    event("hesn", "evt_hesn_5", "task.repeated", 5, { stage: "repeat" })
  ],
  ex_protocol: [
    event("ex_protocol", "evt_ex_protocol_1", "task.created", 1, { stage: "demand" }),
    event("ex_protocol", "evt_ex_protocol_2", "delivery.submitted", 2, { stage: "delivery" }),
    event("ex_protocol", "evt_ex_protocol_3", "acceptance.recorded", 3, { stage: "acceptance" }),
    event("ex_protocol", "evt_ex_protocol_4", "receipt.issued", 4, { stage: "receipt" })
  ],
  bitmind: [
    event("bitmind", "evt_bitmind_1", "research.completed", 1, { stage: "research" }),
    event("bitmind", "evt_bitmind_2", "decision.recorded", 2, { stage: "decision" }),
    event("bitmind", "evt_bitmind_3", "policy.evaluated", 3, { stage: "control" }),
    event("bitmind", "evt_bitmind_4", "simulation.completed", 4, { stage: "simulation" }),
    event("bitmind", "evt_bitmind_5", "receipt.issued", 5, { stage: "review" })
  ]
};

/**
 * Pilot projects are data: the same simulation-only integration config any new
 * project would supply. The pilot bundles below are derived through the
 * universal project-integration kernel, so the pilots no longer carry
 * hand-written Pack/Adapter constants.
 */
export const pilotSimulationIntegrationConfigs: readonly (SimulationProjectIntegrationConfigInput & {
  projectKey: PilotProjectKey;
})[] = [
  {
    projectKey: "uaos",
    projectTypeKey: "engineering_os",
    packId: "pack_uaos_engineering",
    adapterId: "adapter_uaos_simulation",
    sourceSystem: "UAOS_SIMULATION",
    registeredAt: "2026-09-06T00:00:00Z"
  },
  {
    projectKey: "hesn",
    projectTypeKey: "agent_social_ecosystem",
    packId: "pack_hesn_social_agent",
    adapterId: "adapter_hesn_simulation",
    sourceSystem: "HESN_SIMULATION",
    registeredAt: "2026-09-06T00:00:00Z"
  },
  {
    projectKey: "ex_protocol",
    projectTypeKey: "verifiable_economic_task",
    packId: "pack_ex_taskpay",
    adapterId: "adapter_ex_protocol_simulation",
    sourceSystem: "EX_PROTOCOL_SIMULATION",
    riskClass: "HIGH",
    registeredAt: "2026-09-06T00:00:00Z"
  },
  {
    projectKey: "bitmind",
    projectTypeKey: "research_decision_simulation",
    packId: "pack_bitmind_research_decision",
    adapterId: "adapter_bitmind_simulation",
    sourceSystem: "BITMIND_SIMULATION",
    riskClass: "HIGH",
    registeredAt: "2026-09-06T00:00:00Z"
  }
];

const pilotIntegrationBundles = pilotSimulationIntegrationConfigs.map((config) =>
  buildSimulationProjectIntegration(config)
);

export const pilotPackManifests = Object.fromEntries(
  pilotIntegrationBundles.map((bundle) => [bundle.projectKey, bundle.pack])
) as unknown as Record<PilotProjectKey, ProjectPackManifest>;

export const pilotAdapterManifests = Object.fromEntries(
  pilotIntegrationBundles.map((bundle) => [bundle.projectKey, bundle.adapter])
) as unknown as Record<PilotProjectKey, AdapterManifest>;

const entityFor = (projectKey: PilotProjectKey) => ({
  schemaVersion: "1.0",
  scope: scopeFor(projectKey),
  createdBy: `fixture_${projectKey}`,
  createdAt: "2026-09-06T00:00:00Z",
  updatedAt: "2026-09-06T00:00:00Z",
  sourceRefs: [`fixture:${projectKey}`],
  metadata: {}
});

export const pilotProjects = Object.fromEntries(
  pilotIntegrationBundles.map((bundle) => [bundle.projectKey, bundle.project])
) as unknown as Record<PilotProjectKey, UniversalProject>;

export const pilotWorkflows = Object.fromEntries(
  pilotIntegrationBundles.map((bundle) => [bundle.projectKey, bundle.workflow])
) as unknown as Record<PilotProjectKey, WorkflowDefinition>;

export const pilotWorkItems: Record<PilotProjectKey, UniversalWorkItem> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `work_item_${projectKey}`,
      initiativeId: `initiative_${projectKey}`,
      kind: "SIMULATION_LOOP",
      title: `${projectKey} simulation loop`,
      dependencies: [],
      workflowRef: pilotWorkflows[projectKey].id,
      capabilityRefs: ["capability_evidence_capture", "capability_receipt_emit"],
      assigneeRef: `operator_${projectKey}`,
      riskClass: pilotAdapterManifests[projectKey].riskClass,
      status: "COMPLETED"
    }
  ])
) as unknown as Record<PilotProjectKey, UniversalWorkItem>;

export const pilotMetricDefinitions: Record<PilotProjectKey, MetricDefinition> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: "metric_verified_result_rate",
      metricKey: "verified_result_rate",
      name: "Verified result rate",
      description: "Simulation-only ratio of verified receipts to completed runs",
      unit: "ratio",
      aggregation: "RATE",
      numerator: "verified_receipts",
      denominator: "completed_runs",
      timeWindow: "PT1M",
      definitionVersion: "1.0.0",
      sourceEventTypes: ["artifact.verified", "receipt.verified"],
      privacyPolicy: { mode: "fixture" },
      status: "ACTIVE"
    }
  ])
) as unknown as Record<PilotProjectKey, MetricDefinition>;

export const pilotEvidenceRecords: Record<PilotProjectKey, UniversalEvidence> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `evidence_${projectKey}_result`,
      subjectRef: `subject_${projectKey}`,
      evidenceLevel: "E2",
      sourceType: "SIMULATION_FIXTURE",
      sourceRef: pilotEventChains[projectKey][2]?.eventId ?? pilotEventChains[projectKey][0].eventId,
      observedAt: "2026-09-06T00:00:02Z",
      collectedAt: "2026-09-06T00:00:03Z",
      contentHash: `sha256:simulation_${projectKey}`,
      status: "CURRENT",
      retentionPolicy: { mode: "fixture" }
    } satisfies UniversalEvidence
  ])
) as unknown as Record<PilotProjectKey, UniversalEvidence>;

export const pilotPolicies = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `policy_${projectKey}_v1`,
      policyKey: `policy_${projectKey}_simulation`,
      version: "1.0.0",
      actionClass: "SIMULATION",
      riskClass: "LOW",
      decision: "ALLOW",
      requiresApproval: false,
      subjectRef: pilotAdapterManifests[projectKey].adapterId,
      actionRef: `simulate_${projectKey}`,
      resourceRef: `resource_${projectKey}`,
      status: "ACTIVE"
    }
  ])
) as Record<PilotProjectKey, ReturnType<typeof policySchema.parse>>;

export const pilotApprovals: Record<PilotProjectKey, UniversalApproval> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `approval_${projectKey}_v1`,
      policyRef: pilotPolicies[projectKey].id,
      policyVersion: pilotPolicies[projectKey].version,
      actionClass: "SIMULATION",
      subjectRef: pilotAdapterManifests[projectKey].adapterId,
      actionRef: `simulate_${projectKey}`,
      resourceRef: `resource_${projectKey}`,
      requestedBy: `operator_${projectKey}`,
      approverRef: `reviewer_${projectKey}`,
      status: "APPROVED",
      requestedAt: "2026-09-06T00:00:04Z",
      decidedAt: "2026-09-06T00:00:05Z",
      decisionNote: "Simulation-only fixture approval"
    }
  ])
) as Record<PilotProjectKey, UniversalApproval>;

export const pilotReceipts = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `receipt_${projectKey}_v1`,
      workItemId: `work_item_${projectKey}`,
      runId: `run_${projectKey}_v1`,
      actorRef: `actor_${projectKey}`,
      capabilityRef: "capability_receipt_emit",
      workflowVersion: "1.0.0",
      workflowRef: pilotWorkflows[projectKey].id,
      inputSnapshotRef: `input_${projectKey}_v1`,
      manifestRef: pilotAdapterManifests[projectKey].adapterId,
      manifestVersion: pilotAdapterManifests[projectKey].version,
      policySnapshotVersion: pilotPolicies[projectKey].version,
      outputArtifactRefs: [`artifact_${projectKey}_v1`],
      evidenceRefs: [pilotEvidenceRecords[projectKey].id],
      validationRefs: [`validation_${projectKey}_v1`],
      policySnapshotRef: pilotPolicies[projectKey].id,
      approvalRefs: [pilotApprovals[projectKey].id],
      attemptRef: `attempt_${projectKey}_v1`,
      attemptNumber: 1,
      resultStatus: "VERIFIED_SUCCESS",
      replayRef: `checkpoint_${projectKey}_v1`,
      producedAt: "2026-09-06T00:00:06Z"
    }
  ])
) as Record<PilotProjectKey, ReturnType<typeof taskReceiptSchema.parse>>;

export const pilotRuns: Record<PilotProjectKey, UniversalRun> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `run_${projectKey}_v1`,
      workItemId: `work_item_${projectKey}`,
      workflowVersion: "1.0.0",
      workflowRef: pilotWorkflows[projectKey].id,
      mode: "SIMULATION",
      status: "COMPLETED",
      inputSnapshotRef: `input_${projectKey}_v1`,
      policySnapshotRef: pilotPolicies[projectKey].id,
      manifestRef: pilotAdapterManifests[projectKey].adapterId,
      manifestVersion: pilotAdapterManifests[projectKey].version,
      policySnapshotVersion: pilotPolicies[projectKey].version,
      approvalRefs: [pilotApprovals[projectKey].id],
      attemptRef: `attempt_${projectKey}_v1`,
      attemptNumber: 1,
      endedAt: "2026-09-06T00:00:06Z"
    } satisfies UniversalRun
  ])
) as Record<PilotProjectKey, UniversalRun>;

export const pilotAttempts: Record<PilotProjectKey, AttemptIdentity> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `attempt_${projectKey}_v1`,
      runId: pilotRuns[projectKey].id,
      workItemId: pilotRuns[projectKey].workItemId,
      attemptNumber: 1,
      idempotencyKey: `attempt_idem_${projectKey}_v1`,
      workflowVersion: pilotRuns[projectKey].workflowVersion,
      workflowRef: pilotRuns[projectKey].workflowRef,
      status: "COMPLETED",
      startedAt: "2026-09-06T00:00:00Z",
      endedAt: "2026-09-06T00:00:06Z",
      checkpointRef: `checkpoint_${projectKey}_v1`
    }
  ])
) as Record<PilotProjectKey, AttemptIdentity>;

export const pilotReplayCheckpoints: Record<PilotProjectKey, ReplayCheckpoint> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `checkpoint_${projectKey}_v1`,
      runId: pilotRuns[projectKey].id,
      workItemId: pilotRuns[projectKey].workItemId,
      attemptId: pilotAttempts[projectKey].id,
      sequence: 1,
      workflowVersion: pilotRuns[projectKey].workflowVersion,
      workflowRef: pilotRuns[projectKey].workflowRef,
      stateHash: `sha256:checkpoint_${projectKey}_v1`,
      sourceEventRefs: [pilotEventChains[projectKey][0].eventId],
      status: "VERIFIED"
    }
  ])
) as Record<PilotProjectKey, ReplayCheckpoint>;

export const pilotAuditEvents: Record<PilotProjectKey, readonly AuditEvent[]> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    [
      {
        ...entityFor(projectKey),
        id: `audit_${projectKey}_1`,
        runId: pilotRuns[projectKey].id,
        attemptId: pilotAttempts[projectKey].id,
        receiptRef: pilotReceipts[projectKey].id,
        sequence: 1,
        eventType: "run.started",
        actorRef: `operator_${projectKey}`,
        subjectRef: pilotRuns[projectKey].id,
        idempotencyKey: `audit_idem_${projectKey}_1`,
        occurredAt: "2026-09-06T00:00:00Z",
        payload: { mode: "SIMULATION" }
      },
      {
        ...entityFor(projectKey),
        id: `audit_${projectKey}_2`,
        runId: pilotRuns[projectKey].id,
        attemptId: pilotAttempts[projectKey].id,
        receiptRef: pilotReceipts[projectKey].id,
        sequence: 2,
        eventType: "receipt.verified",
        actorRef: `validator_${projectKey}`,
        subjectRef: pilotReceipts[projectKey].id,
        idempotencyKey: `audit_idem_${projectKey}_2`,
        occurredAt: "2026-09-06T00:00:07Z",
        payload: { mode: "SIMULATION" }
      }
    ]
  ])
) as unknown as Record<PilotProjectKey, readonly AuditEvent[]>;

export const pilotValidations = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `validation_${projectKey}_v1`,
      receiptRef: pilotReceipts[projectKey].id,
      evidenceRefs: [pilotEvidenceRecords[projectKey].id],
      validatorRef: `validator_${projectKey}`,
      status: "PASSED",
      validatedAt: "2026-09-06T00:00:07Z"
    }
  ])
) as Record<PilotProjectKey, ReturnType<typeof receiptValidationSchema.parse>>;

export const pilotMetricObservations: Record<PilotProjectKey, MetricObservation> = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `observation_${projectKey}_v1`,
      definitionRef: "metric_verified_result_rate",
      metricKey: "verified_result_rate",
      projectId: `prj_${projectKey}`,
      aggregation: "RATE",
      value: 1,
      unit: "ratio",
      numerator: 1,
      denominator: 1,
      periodStart: "2026-09-06T00:00:00Z",
      periodEnd: "2026-09-06T00:01:00Z",
      definitionVersion: "1.0.0",
      sourceEventRefs: [pilotEventChains[projectKey][2]?.eventId ?? pilotEventChains[projectKey][0].eventId],
      evidenceRefs: [pilotEvidenceRecords[projectKey].id],
      observedAt: "2026-09-06T00:00:08Z",
      confidence: "HIGH",
      status: "SIMULATED"
    } satisfies MetricObservation
  ])
) as Record<PilotProjectKey, MetricObservation>;

export const pilotReviews = Object.fromEntries(
  pilotProjectKeys.map((projectKey) => [
    projectKey,
    {
      ...entityFor(projectKey),
      id: `review_${projectKey}_v1`,
      projectId: `prj_${projectKey}`,
      receiptRef: pilotReceipts[projectKey].id,
      evidenceRefs: [pilotEvidenceRecords[projectKey].id],
      metricObservationRefs: [pilotMetricObservations[projectKey].id],
      reviewerRef: `reviewer_${projectKey}`,
      approvalRef: pilotApprovals[projectKey].id,
      status: "APPROVED",
      reviewedAt: "2026-09-06T00:00:09Z"
    }
  ])
) as Record<PilotProjectKey, ReturnType<typeof reviewSchema.parse>>;

export function validatePilotFixture(projectKey: PilotProjectKey): {
  projectKey: PilotProjectKey;
  packId: string;
  adapterId: string;
  eventCount: number;
  simulationOnly: true;
} {
  const pack = projectPackManifestSchema.parse(pilotPackManifests[projectKey]);
  const adapter = adapterManifestSchema.parse(pilotAdapterManifests[projectKey]);
  const events = validateEventChain(pilotEventChains[projectKey]);
  const evidence = evidenceSchema.parse(pilotEvidenceRecords[projectKey]);
  const receipt = taskReceiptSchema.parse(pilotReceipts[projectKey]);
  const validation = receiptValidationSchema.parse(pilotValidations[projectKey]);
  const observation = metricObservationSchema.parse(pilotMetricObservations[projectKey]);
  const review = reviewSchema.parse(pilotReviews[projectKey]);
  const policy = policySchema.parse(pilotPolicies[projectKey]);
  const approval = approvalSchema.parse(pilotApprovals[projectKey]);
  const run = universalRunSchema.parse(pilotRuns[projectKey]);
  const workflow = pilotWorkflows[projectKey];
  const workItem = workItemSchema.parse(pilotWorkItems[projectKey]);
  const metricDefinition = metricDefinitionSchema.parse(pilotMetricDefinitions[projectKey]);
  const attempt = attemptIdentitySchema.parse(pilotAttempts[projectKey]);
  const checkpoint = replayCheckpointSchema.parse(pilotReplayCheckpoints[projectKey]);
  const auditEvents = auditEventSchema.array().parse(pilotAuditEvents[projectKey]);

  if (
    adapter.status !== "SANDBOXED" ||
    adapter.inputSchema.mode !== "SIMULATION" ||
    adapter.writeScopes.length > 0 ||
    JSON.stringify(adapter.sideEffects) !== JSON.stringify(["none"]) ||
    !adapter.dryRunSupported
  ) {
    throw new Error(`${projectKey} pilot fixture must be simulation-only`);
  }
  if (!events.every((item) => item.payload.mode === "SIMULATION")) {
    throw new Error(`${projectKey} pilot events must be marked SIMULATION`);
  }
  if (pack.adapterRefs.length !== 1 || pack.adapterRefs[0] !== adapter.adapterId) {
    throw new Error(`${projectKey} pilot pack must pin its adapter`);
  }
  assertProjectPackConsistency({
    pack,
    project: pilotProjects[projectKey],
    workflow,
    adapter,
    run,
    receipt
  });
  assertMetricDefinitionRegistryConsistency({
    pack,
    definitions: [metricDefinition],
    observations: [observation]
  });
  assertReceiptEvidenceChain({ receipt, validations: [validation], evidences: [evidence] });
  assertExecutionIdentityConsistency({
    workItem,
    run,
    receipt,
    workflow,
    evidences: [evidence],
    validations: [validation],
    observations: [observation],
    reviews: [review],
    approvals: [approval]
  });
  assertContractSnapshotConsistency({ manifest: adapter, policy, approval, workflow, run, receipt });
  assertAuditReplayConsistency({
    run,
    receipt,
    attempts: [attempt],
    checkpoints: [checkpoint],
    auditEvents
  });
  if (
    !events.some((item) => item.eventId === evidence.sourceRef) ||
    observation.sourceEventRefs.some((eventRef) => !events.some((item) => item.eventId === eventRef))
  ) {
    throw new Error(`${projectKey} pilot evidence/observation source events are not traceable`);
  }
  if (
    !receipt.evidenceRefs.includes(evidence.id) ||
    !receipt.validationRefs.includes(validation.id) ||
    validation.receiptRef !== receipt.id ||
    !validation.evidenceRefs.includes(evidence.id) ||
    !observation.evidenceRefs.includes(evidence.id) ||
    !review.evidenceRefs.includes(evidence.id) ||
    review.receiptRef !== receipt.id ||
    !review.metricObservationRefs.includes(observation.id) ||
    review.approvalRef !== approval.id ||
    approval.policyRef !== policy.id
  ) {
    throw new Error(`${projectKey} pilot fixture evidence chain is not traceable`);
  }

  return {
    projectKey,
    packId: pack.packId,
    adapterId: adapter.adapterId,
    eventCount: events.length,
    simulationOnly: true
  };
}

export function validateAllPilotFixtures(): ReturnType<typeof validatePilotFixture>[] {
  return pilotProjectKeys.map((projectKey) => validatePilotFixture(projectKey));
}

export { eventEnvelopeSchema };
