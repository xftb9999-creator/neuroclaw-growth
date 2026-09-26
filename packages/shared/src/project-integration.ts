import { z } from "zod";

import { semverRangeSchema } from "./semver-range.js";
import {
  adapterManifestSchema,
  adapterRegistryEntrySchema,
  assertProjectPackRegistryConsistency,
  projectPackManifestSchema,
  projectPackRegistryEntrySchema,
  projectSchema,
  universalIdSchema,
  universalScopeSchema,
  utcTimestampSchema,
  workflowDefinitionSchema,
  type AdapterManifest,
  type AdapterRegistryEntry,
  type ProjectPackManifest,
  type ProjectPackRegistryEntry,
  type UniversalProject,
  type UniversalScope,
  type WorkflowDefinition
} from "./universal-contracts.js";

export * from "./plugin-manifest.js";

/**
 * Round AG-1: universal project integration kernel.
 *
 * New projects register by declaring one config object; this module derives
 * the simulation-only Pack/Adapter/Workflow/Project manifests, the local
 * registry entries and the adapter inputs from it. The kernel never branches
 * on project names: project identity is data, and every derived manifest is
 * validated against the registry consistency gates below before it is
 * returned.
 *
 * Scope: simulation-only contracts and pure in-memory registration. No
 * persistence, network, credentials, or external side effects.
 */

export const integrationProjectKeySchema = z
  .string()
  .min(2, "projectKey must contain at least two characters")
  .max(64, "projectKey must contain at most 64 characters")
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "projectKey must be lowercase snake_case and start with a letter"
  );
export type IntegrationProjectKey = z.infer<typeof integrationProjectKeySchema>;

const SIMULATION_DEFAULTS = {
  organizationId: "org_simulation",
  workspaceId: "ws_simulation",
  packVersion: "1.0.0",
  compatibilityRange: ">=1.0.0 <2.0.0",
  lifecycleProfile: [
    "DISCOVER",
    "VALIDATE",
    "PLAN",
    "PILOT",
    "REVIEW",
    "PAUSE",
    "RETIRE"
  ],
  objectiveProfiles: ["activation", "verified_result", "retention"],
  metricDefinitions: ["metric_verified_result_rate"],
  workflowId: "workflow_simulated_growth_loop_v1",
  capabilityRefs: ["capability_evidence_capture", "capability_receipt_emit"],
  frontendModuleRegistry: [
    "ProjectOverview",
    "ObjectiveMap",
    "EvidenceInspector",
    "ReviewRoom"
  ],
  localizationRefs: ["locale_zh_cn", "locale_en_us"],
  evidenceRules: { minimumLevel: "E2", simulatedResultStatus: "SUCCESS_UNVERIFIED" },
  readScopes: ["project:read", "events:read"],
  objectMappings: [{ sourceType: "source.task", targetType: "WorkItem" }],
  eventMappings: [{ sourceEvent: "source.completed", targetEvent: "work_item.completed" }],
  outputSchema: { events: "EventEnvelope[]", receipt: "TaskReceipt" },
  evidenceRequirements: ["source_ref", "event_chain", "receipt_ref"],
  retryPolicy: { maxAttempts: 0 },
  rateLimit: { mode: "fixture" }
} as const;

/**
 * Config-driven Pack/Adapter input contract. Every field beyond the five
 * required identity keys has a simulation-safe default, so a new project only
 * supplies its own names and receives a fully validated simulation contract.
 */
export const simulationProjectIntegrationConfigSchema = z
  .object({
    projectKey: integrationProjectKeySchema,
    projectTypeKey: z.string().min(1),
    packId: universalIdSchema,
    adapterId: universalIdSchema,
    sourceSystem: z.string().min(1),
    projectId: universalIdSchema.optional(),
    projectName: z.string().min(1).optional(),
    ownerRef: universalIdSchema.optional(),
    scope: universalScopeSchema.optional(),
    packVersion: z.string().min(1).default(SIMULATION_DEFAULTS.packVersion),
    packStatus: z.literal("ACTIVE").default("ACTIVE"),
    adapterStatus: z.literal("SANDBOXED").default("SANDBOXED"),
    compatibilityRange: semverRangeSchema.default(SIMULATION_DEFAULTS.compatibilityRange),
    riskClass: z.enum(["LOW", "MEDIUM", "HIGH"]).default("LOW"),
    lifecycleProfile: z
      .array(z.string().min(1))
      .min(1)
      .default(() => [...SIMULATION_DEFAULTS.lifecycleProfile]),
    objectiveProfiles: z
      .array(z.string().min(1))
      .min(1)
      .default(() => [...SIMULATION_DEFAULTS.objectiveProfiles]),
    metricDefinitions: z
      .array(z.string().min(1))
      .min(1)
      .default(() => [...SIMULATION_DEFAULTS.metricDefinitions]),
    workflowId: universalIdSchema.default(SIMULATION_DEFAULTS.workflowId),
    capabilityRefs: z
      .array(z.string().min(1))
      .default(() => [...SIMULATION_DEFAULTS.capabilityRefs]),
    frontendModuleRegistry: z
      .array(z.string().min(1))
      .min(1)
      .default(() => [...SIMULATION_DEFAULTS.frontendModuleRegistry]),
    localizationRefs: z
      .array(z.string().min(1))
      .default(() => [...SIMULATION_DEFAULTS.localizationRefs]),
    approvalPolicy: z
      .record(z.string(), z.unknown())
      .default(() => ({ highImpactDefault: "manual" })),
    budgetPolicy: z
      .record(z.string(), z.unknown())
      .default(() => ({ mode: "SIMULATION_ONLY" })),
    evidenceRules: z
      .record(z.string(), z.unknown())
      .default(() => ({ ...SIMULATION_DEFAULTS.evidenceRules })),
    readScopes: z
      .array(z.string())
      .default(() => [...SIMULATION_DEFAULTS.readScopes]),
    /** Declared for fail-closed validation: simulations must keep it empty. */
    writeScopes: z.array(z.string()).default(() => []),
    /** Declared for fail-closed validation: simulations must keep it empty. */
    authRequirements: z.array(z.string()).default(() => []),
    sideEffects: z.array(z.string()).default(() => ["none"]),
    objectMappings: z
      .array(z.object({ sourceType: z.string().min(1), targetType: z.string().min(1) }))
      .min(1)
      .default(() => SIMULATION_DEFAULTS.objectMappings.map((mapping) => ({ ...mapping }))),
    eventMappings: z
      .array(z.object({ sourceEvent: z.string().min(1), targetEvent: z.string().min(1) }))
      .min(1)
      .default(() => SIMULATION_DEFAULTS.eventMappings.map((mapping) => ({ ...mapping }))),
    outputSchema: z
      .record(z.string(), z.unknown())
      .default(() => ({ ...SIMULATION_DEFAULTS.outputSchema })),
    evidenceRequirements: z
      .array(z.string().min(1))
      .min(1)
      .default(() => [...SIMULATION_DEFAULTS.evidenceRequirements]),
    rollbackHint: z.string().min(1).default("discard_simulation_run"),
    timeoutMs: z.number().int().positive().default(5000),
    retryPolicy: z.record(z.string(), z.unknown()).default(() => ({ ...SIMULATION_DEFAULTS.retryPolicy })),
    rateLimit: z.record(z.string(), z.unknown()).default(() => ({ ...SIMULATION_DEFAULTS.rateLimit })),
    healthCheck: z.string().min(1).default("fixture_available"),
    readinessCheck: z.string().min(1).default("contract_validated"),
    idempotencyStrategy: z.string().min(1).default("event_id + idempotency_key"),
    /** Deterministic registration timestamp; defaults to the current UTC time. */
    registeredAt: utcTimestampSchema.optional()
  })
  .strict()
  .superRefine((config, ctx) => {
    const projectId = config.projectId ?? `prj_${config.projectKey}`;
    if (config.scope?.projectId && config.scope.projectId !== projectId) {
      ctx.addIssue({
        code: "custom",
        path: ["scope", "projectId"],
        message: "Integration scope.projectId must match the configured projectId"
      });
    }
  });
export type SimulationProjectIntegrationConfigInput = z.input<
  typeof simulationProjectIntegrationConfigSchema
>;
export type SimulationProjectIntegrationConfig = z.output<
  typeof simulationProjectIntegrationConfigSchema
>;

type ResolvedSimulationProjectIntegrationConfig = SimulationProjectIntegrationConfig & {
  registeredAt: string;
};

function resolveIntegrationConfig(
  configInput: SimulationProjectIntegrationConfigInput
): ResolvedSimulationProjectIntegrationConfig {
  const config = simulationProjectIntegrationConfigSchema.parse(configInput);
  return {
    ...config,
    registeredAt: config.registeredAt ?? new Date().toISOString()
  };
}

function resolveProjectIdentity(config: ResolvedSimulationProjectIntegrationConfig): {
  projectId: string;
  scope: UniversalScope;
} {
  const projectId = config.projectId ?? `prj_${config.projectKey}`;
  const scope = universalScopeSchema.parse({
    organizationId: SIMULATION_DEFAULTS.organizationId,
    workspaceId: SIMULATION_DEFAULTS.workspaceId,
    projectId,
    ...(config.scope ?? {})
  });
  return { projectId, scope };
}

function simulationEntity(config: ResolvedSimulationProjectIntegrationConfig) {
  return {
    schemaVersion: "1.0",
    createdBy: `fixture_${config.projectKey}`,
    createdAt: config.registeredAt,
    updatedAt: config.registeredAt,
    sourceRefs: [`fixture:${config.projectKey}`],
    metadata: {}
  };
}

/** Derives the Pack manifest snapshot for one configured project. */
export function buildSimulationPackManifest(
  configInput: SimulationProjectIntegrationConfigInput
): ProjectPackManifest {
  return packManifestFromConfig(resolveIntegrationConfig(configInput));
}

function packManifestFromConfig(
  config: ResolvedSimulationProjectIntegrationConfig
): ProjectPackManifest {
  const { projectId, scope } = resolveProjectIdentity(config);
  return projectPackManifestSchema.parse({
    compatibilityRange: config.compatibilityRange,
    status: config.packStatus,
    lifecycleProfile: [...config.lifecycleProfile],
    objectiveProfiles: [...config.objectiveProfiles],
    metricDefinitions: [...config.metricDefinitions],
    workflowDefinitions: [config.workflowId],
    workflowRefs: [config.workflowId],
    capabilityRefs: [...config.capabilityRefs],
    approvalPolicy: { ...config.approvalPolicy },
    budgetPolicy: { ...config.budgetPolicy },
    evidenceRules: { ...config.evidenceRules },
    frontendModuleRegistry: [...config.frontendModuleRegistry],
    localizationRefs: [...config.localizationRefs],
    scope,
    projectId,
    packId: config.packId,
    version: config.packVersion,
    projectTypeKey: config.projectTypeKey,
    adapterRefs: [config.adapterId]
  });
}

/** Derives the simulation-only Adapter manifest snapshot for one configured project. */
export function buildSimulationAdapterManifest(
  configInput: SimulationProjectIntegrationConfigInput
): AdapterManifest {
  return adapterManifestFromConfig(resolveIntegrationConfig(configInput));
}

function adapterManifestFromConfig(
  config: ResolvedSimulationProjectIntegrationConfig
): AdapterManifest {
  const { projectId, scope } = resolveProjectIdentity(config);
  const adapter = adapterManifestSchema.parse({
    adapterId: config.adapterId,
    scope,
    version: config.packVersion,
    compatibilityRange: config.compatibilityRange,
    sourceSystem: config.sourceSystem,
    projectRef: projectId,
    objectMappings: config.objectMappings.map((mapping) => ({ ...mapping })),
    eventMappings: config.eventMappings.map((mapping) => ({ ...mapping })),
    readScopes: [...config.readScopes],
    writeScopes: [...config.writeScopes],
    inputSchema: { mode: "SIMULATION" },
    outputSchema: { ...config.outputSchema },
    authRequirements: [...config.authRequirements],
    sideEffects: [...config.sideEffects],
    simulationOnly: true,
    riskClass: config.riskClass,
    idempotencyStrategy: config.idempotencyStrategy,
    timeoutMs: config.timeoutMs,
    retryPolicy: { ...config.retryPolicy },
    rateLimit: { ...config.rateLimit },
    healthCheck: config.healthCheck,
    readinessCheck: config.readinessCheck,
    dryRunSupported: true,
    rollbackHint: config.rollbackHint,
    evidenceRequirements: [...config.evidenceRequirements],
    controlledWriteBindings: [],
    approvalRefs: [],
    status: config.adapterStatus
  });
  return assertSimulationOnlyAdapter(adapter);
}

/** Derives the simulation workflow for one configured project. */
export function buildSimulationWorkflowDefinition(
  configInput: SimulationProjectIntegrationConfigInput
): WorkflowDefinition {
  return workflowDefinitionFromConfig(resolveIntegrationConfig(configInput));
}

function workflowDefinitionFromConfig(
  config: ResolvedSimulationProjectIntegrationConfig
): WorkflowDefinition {
  const { scope } = resolveProjectIdentity(config);
  return workflowDefinitionSchema.parse({
    ...simulationEntity(config),
    id: config.workflowId,
    scope,
    packId: config.packId,
    version: config.packVersion,
    inputSchema: { mode: "SIMULATION" },
    outputSchema: { receipt: "TaskReceipt" },
    nodes: [
      {
        nodeId: "simulate",
        kind: "simulate",
        capabilityRefs: [...config.capabilityRefs],
        riskClass: "LOW",
        timeoutMs: 5000,
        produces: ["receipt"]
      }
    ],
    edges: [],
    retryPolicy: { maxAttempts: 1 },
    failurePolicy: { mode: "explicit_failure" },
    approvalPoints: []
  });
}

/** Derives the Project record for one configured project. */
export function buildSimulationProject(
  configInput: SimulationProjectIntegrationConfigInput
): UniversalProject {
  return projectFromConfig(resolveIntegrationConfig(configInput));
}

function projectFromConfig(config: ResolvedSimulationProjectIntegrationConfig): UniversalProject {
  const { projectId, scope } = resolveProjectIdentity(config);
  return projectSchema.parse({
    ...simulationEntity(config),
    id: projectId,
    scope,
    name: config.projectName ?? `${config.projectKey} simulation project`,
    packId: config.packId,
    packVersion: config.packVersion,
    typeKey: config.projectTypeKey,
    lifecycleState: "PILOT",
    ownerRef: config.ownerRef ?? `owner_${config.projectKey}`,
    riskPosture: config.riskClass,
    status: "ACTIVE"
  });
}

export interface SimulationProjectIntegrationBundle {
  projectKey: string;
  project: UniversalProject;
  pack: ProjectPackManifest;
  adapter: AdapterManifest;
  workflow: WorkflowDefinition;
}

/**
 * Builds one consistent simulation-only bundle from a config. Fail-closed:
 * cross-scope reuse, write intent, non-sandboxed statuses, or any Pack/
 * Workflow/Adapter/Project reference mismatch throws before returning.
 */
export function buildSimulationProjectIntegration(
  configInput: SimulationProjectIntegrationConfigInput
): SimulationProjectIntegrationBundle {
  const config = resolveIntegrationConfig(configInput);
  const bundle: SimulationProjectIntegrationBundle = {
    projectKey: config.projectKey,
    project: projectFromConfig(config),
    pack: packManifestFromConfig(config),
    adapter: adapterManifestFromConfig(config),
    workflow: workflowDefinitionFromConfig(config)
  };
  assertSimulationProjectIntegrationConsistency(bundle);
  return bundle;
}

/** Registry-level gate for a configured project bundle; throws when inconsistent. */
export function assertSimulationProjectIntegrationConsistency(
  bundle: SimulationProjectIntegrationBundle
): void {
  const pack = projectPackManifestSchema.parse(bundle.pack);
  const project = projectSchema.parse(bundle.project);
  const adapter = assertSimulationOnlyAdapter(bundle.adapter);
  const workflow = workflowDefinitionSchema.parse(bundle.workflow);
  if (pack.budgetPolicy.mode !== "SIMULATION_ONLY") {
    throw new Error("Simulation integrations require budgetPolicy.mode = SIMULATION_ONLY");
  }
  assertProjectPackRegistryConsistency({
    pack,
    project,
    workflows: [workflow],
    adapters: [adapter]
  });
  if (project.id !== adapter.projectRef || project.id !== pack.projectId) {
    throw new Error("Integration Project, Pack and Adapter must share one project identity");
  }
}

export interface SimulationAdapterInput {
  projectKey: string;
  projectRef: string;
  adapterId: string;
  sourceSystem: string;
  status: AdapterManifest["status"];
  readiness: "READY" | "UNKNOWN" | "DEGRADED" | "BLOCKED";
  reason: string;
  evidenceAt: string;
  nextAction: string;
  readScopes: string[];
  writeScopes: string[];
  sideEffects: string[];
  simulationOnly: boolean;
}

/**
 * Simulation-only adapter gate: simulationOnly adapters must stay sandboxed,
 * dry-run capable, read-only, auth-free, and side-effect free. Any write
 * intent fails closed.
 */
export function assertSimulationOnlyAdapter(manifest: AdapterManifest): AdapterManifest {
  const parsed = adapterManifestSchema.parse(manifest);
  if (
    parsed.status !== "SANDBOXED" ||
    parsed.simulationOnly !== true ||
    parsed.inputSchema.mode !== "SIMULATION" ||
    parsed.writeScopes.length !== 0 ||
    (parsed.controlledWriteBindings ?? []).length !== 0 ||
    JSON.stringify(parsed.sideEffects) !== JSON.stringify(["none"]) ||
    parsed.authRequirements.length !== 0
  ) {
    throw new Error(
      "Simulation adapters must declare simulationOnly=true, SANDBOXED status, SIMULATION inputs, empty write scopes, no controlled writes, no auth requirements, and side effects [\"none\"]"
    );
  }
  return parsed;
}

function toSimulationAdapterInput(
  projectKey: string,
  manifest: AdapterManifest
): SimulationAdapterInput {
  const parsed = assertSimulationOnlyAdapter(manifest);
  return {
    projectKey,
    projectRef: parsed.projectRef,
    adapterId: parsed.adapterId,
    sourceSystem: parsed.sourceSystem,
    status: parsed.status,
    readiness: "READY",
    reason: "Simulation fixture contract is available; real project inputs are not asserted.",
    evidenceAt: "2026-09-06T00:00:00Z",
    nextAction:
      "Obtain independently verified project API, event samples and authorization before any real adapter work.",
    readScopes: [...parsed.readScopes],
    writeScopes: [...parsed.writeScopes],
    sideEffects: [...parsed.sideEffects],
    simulationOnly: parsed.simulationOnly
  };
}

/**
 * Generic adapter input generator: accepts any project key -> manifest map,
 * never a fixed project list. Input-schema order is preserved.
 */
export function buildSimulationAdapterInputs(
  manifests: Readonly<Record<string, AdapterManifest>>
): SimulationAdapterInput[] {
  return Object.entries(manifests).map(([projectKey, manifest]) =>
    toSimulationAdapterInput(integrationProjectKeySchema.parse(projectKey), manifest)
  );
}

export interface SimulationProjectIntegrationRegistrationOptions {
  /** Deterministic override for the registration record timestamps. */
  registeredAt?: string;
  /** Rollback plan recorded on the registry entries; defaults to the adapter rollback hint. */
  rollbackPlan?: string;
}

export interface SimulationProjectIntegrationRegistration {
  projectKey: string;
  bundle: SimulationProjectIntegrationBundle;
  packRegistryEntry: ProjectPackRegistryEntry;
  adapterRegistryEntry: AdapterRegistryEntry;
  adapterInput: SimulationAdapterInput;
}

/**
 * Builds the immutable local registration records (Pack + Adapter entries)
 * for one configured project, plus its simulation adapter input.
 */
export function buildSimulationProjectIntegrationRegistration(
  configInput: SimulationProjectIntegrationConfigInput,
  options: SimulationProjectIntegrationRegistrationOptions = {}
): SimulationProjectIntegrationRegistration {
  const bundle = buildSimulationProjectIntegration(configInput);
  const registeredAt = options.registeredAt ?? bundle.project.createdAt;
  const rollbackPlan = options.rollbackPlan ?? bundle.adapter.rollbackHint;
  const packRegistryEntry = projectPackRegistryEntrySchema.parse({
    id: `pack_entry_${bundle.pack.packId}_${bundle.pack.version}`,
    projectId: bundle.pack.projectId,
    packId: bundle.pack.packId,
    version: bundle.pack.version,
    scope: bundle.pack.scope,
    status: bundle.pack.status,
    manifestSnapshot: bundle.pack,
    rollbackPlan,
    createdAt: registeredAt,
    updatedAt: registeredAt
  });
  const adapterRegistryEntry = adapterRegistryEntrySchema.parse({
    id: `adapter_entry_${bundle.adapter.adapterId}_${bundle.adapter.version}`,
    projectId: bundle.adapter.projectRef,
    packId: bundle.pack.packId,
    packVersion: bundle.pack.version,
    adapterId: bundle.adapter.adapterId,
    version: bundle.adapter.version,
    scope: bundle.adapter.scope,
    status: bundle.adapter.status,
    manifestSnapshot: bundle.adapter,
    rollbackPlan,
    createdAt: registeredAt,
    updatedAt: registeredAt
  });
  if (
    adapterRegistryEntry.packId !== packRegistryEntry.packId ||
    adapterRegistryEntry.packVersion !== packRegistryEntry.version ||
    adapterRegistryEntry.projectId !== packRegistryEntry.projectId
  ) {
    throw new Error("Adapter registry entry must bind to the same Pack/project registration");
  }
  return {
    projectKey: bundle.projectKey,
    bundle,
    packRegistryEntry,
    adapterRegistryEntry,
    adapterInput: toSimulationAdapterInput(bundle.projectKey, bundle.adapter)
  };
}

export interface SimulationIntegrationRegistry {
  register(
    configInput: SimulationProjectIntegrationConfigInput,
    options?: SimulationProjectIntegrationRegistrationOptions
  ): SimulationProjectIntegrationRegistration;
  get(projectKey: string): SimulationProjectIntegrationRegistration | undefined;
  list(): readonly SimulationProjectIntegrationRegistration[];
}

/**
 * Pure in-memory registration facade. Project keys, Pack identities and
 * Adapter identities are immutable once registered; duplicates fail closed
 * instead of silently overwriting a version.
 */
export function createSimulationIntegrationRegistry(): SimulationIntegrationRegistry {
  const registrations = new Map<string, SimulationProjectIntegrationRegistration>();
  const packIdentities = new Set<string>();
  const adapterIdentities = new Set<string>();
  return {
    register(configInput, options = {}) {
      const registration = buildSimulationProjectIntegrationRegistration(configInput, options);
      const { bundle } = registration;
      if (registrations.has(bundle.projectKey)) {
        throw new Error(`Project '${bundle.projectKey}' is already registered`);
      }
      const packIdentity = `${bundle.pack.packId}@${bundle.pack.version}`;
      const adapterIdentity = `${bundle.adapter.adapterId}@${bundle.adapter.version}`;
      if (packIdentities.has(packIdentity)) {
        throw new Error(`Pack ${packIdentity} is already registered and immutable`);
      }
      if (adapterIdentities.has(adapterIdentity)) {
        throw new Error(`Adapter ${adapterIdentity} is already registered and immutable`);
      }
      registrations.set(bundle.projectKey, registration);
      packIdentities.add(packIdentity);
      adapterIdentities.add(adapterIdentity);
      return registration;
    },
    get(projectKey) {
      return registrations.get(projectKey);
    },
    list() {
      return [...registrations.values()];
    }
  };
}
