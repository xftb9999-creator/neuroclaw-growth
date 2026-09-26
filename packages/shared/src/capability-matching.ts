import { createHash } from "node:crypto";
import { z } from "zod";

import { evidenceLevelSchema, universalIdSchema } from "./universal-contracts.js";

/**
 * D5 能力层匹配服务（B3 §D5 / 裁决 6）。
 *
 * Pure functions, zero DB, zero I/O: same input ⇒ same output, so the report
 * can be snapshotted into a golden file and compared byte-for-byte.
 *
 * Contract reuse (B3 C9): the requirement and inventory both identify
 * capabilities with the existing `capabilityRefs` / `capabilityRef` vocabulary
 * and the existing `universalIdSchema` identifier and `evidenceLevelSchema`
 * E-levels. No field is added to any existing contract.
 *
 * The inventory's `requires[].satisfied` is *resolved upstream* (P-1 owns real
 * semver). D5 deliberately does not re-implement version solving; it consumes
 * the resolved boolean and treats an unsatisfied dependency as missing
 * (rule 2, fail-closed).
 */

export const CAPABILITY_MATCH_REPORT_VERSION = "1.0";

export const capabilityLayerSchema = z.enum([
  "L0",
  "L1",
  "L2",
  "L3",
  "L4",
  "L5",
  "L6",
  "L7",
  "L8"
]);
export type CapabilityLayer = z.infer<typeof capabilityLayerSchema>;

export const capabilityWeightSchema = z.enum(["MUST", "SHOULD", "NICE"]);
export type CapabilityWeight = z.infer<typeof capabilityWeightSchema>;

/** The fixed six-segment chain: input → plan → execute → deliver → measure → optimize. */
export const chainSegmentSchema = z.enum([
  "input",
  "plan",
  "execute",
  "deliver",
  "measure",
  "optimize"
]);
export type ChainSegment = z.infer<typeof chainSegmentSchema>;
export const CHAIN_SEGMENTS = chainSegmentSchema.options;

export const capabilityMatchStatusSchema = z.enum(["COVERED", "PARTIAL", "MISSING"]);
export type CapabilityMatchStatus = z.infer<typeof capabilityMatchStatusSchema>;

export const segmentStatusSchema = z.enum(["EXECUTABLE", "CONDITIONAL", "BLOCKED"]);
export type SegmentStatus = z.infer<typeof segmentStatusSchema>;

/** A = all MUST covered; B = degraded but runnable; C = refuse to run. */
export const executabilityVerdictSchema = z.enum(["A", "B", "C"]);
export type ExecutabilityVerdict = z.infer<typeof executabilityVerdictSchema>;

export const channelAccountStatusSchema = z.enum(["READY", "PENDING", "DISABLED", "MISSING"]);
export type ChannelAccountStatus = z.infer<typeof channelAccountStatusSchema>;

export const capabilityRequirementSchema = z
  .object({
    reqId: universalIdSchema,
    layer: capabilityLayerSchema,
    capabilityRef: universalIdSchema,
    weight: capabilityWeightSchema,
    minEvidence: evidenceLevelSchema,
    chainSegment: chainSegmentSchema,
    /**
     * Rule 5 input: does satisfying this requirement mean writing to the real
     * world? A simulation-only provider then cannot cover it.
     */
    requiresRealSideEffect: z.boolean().default(false)
  })
  .strict();
export type CapabilityRequirement = z.infer<typeof capabilityRequirementSchema>;

export const installedPluginSchema = z
  .object({
    pluginId: universalIdSchema,
    /** Reuses the existing `capabilityRefs` contract vocabulary (B3 C9). */
    capabilityRefs: z.array(universalIdSchema),
    enabled: z.boolean().default(true),
    /**
     * Dependencies already resolved by the caller (P-1 owns semver).
     * `satisfied: false` means missing or version-conflicting.
     */
    requires: z
      .array(z.object({ ref: universalIdSchema, satisfied: z.boolean() }).strict())
      .default([]),
    evidenceLevel: evidenceLevelSchema.default("E0"),
    simulationOnly: z.boolean().default(false),
    /** Rule 4 input: deliverable channels and their account readiness. */
    channels: z
      .array(
        z
          .object({ channel: z.string().min(1), accountStatus: channelAccountStatusSchema })
          .strict()
      )
      .default([])
  })
  .strict();
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export const capabilityMatchInputSchema = z
  .object({
    goalSpec: z
      .object({
        objective: z.string().min(1),
        industryProfile: z.string().min(1).optional(),
        // An empty goal spec is a caller error, not an "A" verdict.
        requirements: z.array(capabilityRequirementSchema).min(1)
      })
      .strict(),
    inventory: z.array(installedPluginSchema),
    policy: z.object({ version: z.string().min(1) }).strict().optional()
  })
  .strict();
/**
 * Caller-facing shape: fields that carry a schema default stay optional, so a
 * caller never has to restate `enabled: true` or `evidenceLevel: "E0"`.
 */
export type CapabilityMatchInput = z.input<typeof capabilityMatchInputSchema>;

export const capabilityMatchItemSchema = z
  .object({
    reqId: universalIdSchema,
    capabilityRef: universalIdSchema,
    weight: capabilityWeightSchema,
    status: capabilityMatchStatusSchema,
    reason: z.string().min(1),
    evidenceLevel: evidenceLevelSchema,
    /** Non-empty for every PARTIAL — silent degradation is forbidden (D5.5 §2). */
    preconditions: z.array(z.string().min(1)),
    unlockHint: z.string().min(1).optional()
  })
  .strict();
export type CapabilityMatchItem = z.infer<typeof capabilityMatchItemSchema>;

export const capabilityMatchSegmentSchema = z
  .object({ segment: chainSegmentSchema, status: segmentStatusSchema })
  .strict();
export type CapabilityMatchSegment = z.infer<typeof capabilityMatchSegmentSchema>;

export const capabilityMatchReportSchema = z
  .object({
    verdict: executabilityVerdictSchema,
    segments: z.array(capabilityMatchSegmentSchema),
    items: z.array(capabilityMatchItemSchema),
    reportVersion: z.string().min(1),
    inputFingerprint: z.string().min(1)
  })
  .strict();
export type CapabilityMatchReport = z.infer<typeof capabilityMatchReportSchema>;

/**
 * Evidence floor. D5.5 §3: "COVERED 必须带 E 级证据：无证据按 E0 处理，不得判
 * COVERED" — so an E0 provider can never produce COVERED, whatever the
 * requirement's `minEvidence` says. This is the stricter (fail-closed) reading.
 */
const EVIDENCE_ORDER = evidenceLevelSchema.options;
const EVIDENCE_FLOOR: (typeof EVIDENCE_ORDER)[number] = "E1";

function evidenceAtLeast(actual: string, required: string): boolean {
  return EVIDENCE_ORDER.indexOf(actual as never) >= EVIDENCE_ORDER.indexOf(required as never);
}

function effectiveMinEvidence(minEvidence: string): string {
  return evidenceAtLeast(minEvidence, EVIDENCE_FLOOR) ? minEvidence : EVIDENCE_FLOOR;
}

/** Deterministic JSON (recursively sorted keys) so `inputFingerprint` is reproducible. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function capabilityMatchInputFingerprint(input: CapabilityMatchInput): string {
  // Fingerprinted over the *parsed* input, so defaults are materialized: writing
  // a default explicitly and omitting it produce the same fingerprint.
  return createHash("sha256").update(canonicalJson(capabilityMatchInputSchema.parse(input))).digest("hex");
}

/**
 * Pick the provider with the strongest evidence. Ties break on `pluginId` so
 * the choice never depends on inventory ordering.
 */
function bestProvider(candidates: readonly InstalledPlugin[]): InstalledPlugin {
  return [...candidates].sort((left, right) => {
    const byEvidence =
      EVIDENCE_ORDER.indexOf(right.evidenceLevel) - EVIDENCE_ORDER.indexOf(left.evidenceLevel);
    if (byEvidence !== 0) return byEvidence;
    return left.pluginId.localeCompare(right.pluginId);
  })[0]!;
}

interface Evaluation {
  status: CapabilityMatchStatus;
  evidenceLevel: string;
  reason: string;
  preconditions: string[];
  unlockHint?: string;
}

/**
 * D5.3 fail-closed rules 1–6, evaluated in order. Every failing rule
 * contributes its precondition; the item is COVERED only when none failed.
 */
function evaluateRequirement(
  requirement: CapabilityRequirement,
  inventory: readonly InstalledPlugin[]
): Evaluation {
  const providing = inventory.filter((plugin) =>
    plugin.capabilityRefs.includes(requirement.capabilityRef)
  );

  // Rule 1 — no plugin provides the capability.
  if (providing.length === 0) {
    return {
      status: "MISSING",
      evidenceLevel: "E0",
      reason: `No installed plugin provides '${requirement.capabilityRef}'`,
      preconditions: [],
      unlockHint: `Install a plugin that provides '${requirement.capabilityRef}'`
    };
  }

  // Rule 2 — disabled, or dependencies unresolvable (missing / version conflict).
  const usable = providing.filter(
    (plugin) => plugin.enabled && plugin.requires.every((dependency) => dependency.satisfied)
  );
  if (usable.length === 0) {
    const blockers = providing.map((plugin) => {
      if (!plugin.enabled) return `'${plugin.pluginId}' is disabled`;
      const unsatisfied = plugin.requires
        .filter((dependency) => !dependency.satisfied)
        .map((dependency) => dependency.ref);
      return `'${plugin.pluginId}' has unresolved dependencies: ${unsatisfied.join(", ")}`;
    });
    return {
      status: "MISSING",
      evidenceLevel: "E0",
      reason: `Every provider of '${requirement.capabilityRef}' is unusable — ${blockers.join("; ")}`,
      preconditions: [],
      unlockHint: `Enable a provider of '${requirement.capabilityRef}' or resolve its dependencies`
    };
  }

  const provider = bestProvider(usable);
  const preconditions: string[] = [];
  const failures: string[] = [];

  // Rule 3 — evidence below the requirement (with the E1 floor from D5.5 §3).
  const floor = effectiveMinEvidence(requirement.minEvidence);
  if (!evidenceAtLeast(provider.evidenceLevel, floor)) {
    failures.push(
      `evidence ${provider.evidenceLevel} is below the required ${floor} (requirement minEvidence ${requirement.minEvidence})`
    );
    preconditions.push(
      `Raise '${provider.pluginId}' evidence to ${floor} or higher (currently ${provider.evidenceLevel})`
    );
  }

  // Rule 4 — deliver segment with no READY account.
  if (requirement.chainSegment === "deliver") {
    const notReady = provider.channels.filter((channel) => channel.accountStatus !== "READY");
    if (notReady.length > 0 || provider.channels.length === 0) {
      failures.push(
        provider.channels.length === 0
          ? "no delivery channel is declared"
          : `channels not READY: ${notReady
              .map((channel) => `${channel.channel}=${channel.accountStatus}`)
              .join(", ")}`
      );
      preconditions.push(
        provider.channels.length === 0
          ? `Declare a READY delivery channel on '${provider.pluginId}'`
          : `Bring '${provider.pluginId}' channel account(s) to READY: ${notReady
              .map((channel) => `${channel.channel} (${channel.accountStatus})`)
              .join(", ")}`
      );
    }
  }

  // Rule 5 — simulation-only provider for a requirement that needs real effect.
  if (provider.simulationOnly && requirement.requiresRealSideEffect) {
    failures.push("provider is simulationOnly but the requirement needs a real side effect");
    preconditions.push(
      `Replace '${provider.pluginId}' with a non-simulation provider for '${requirement.capabilityRef}'`
    );
  }

  // Rule 6 — everything passed.
  if (failures.length === 0) {
    return {
      status: "COVERED",
      evidenceLevel: provider.evidenceLevel,
      reason: `'${provider.pluginId}' covers '${requirement.capabilityRef}' at ${provider.evidenceLevel}`,
      preconditions: []
    };
  }

  return {
    status: "PARTIAL",
    evidenceLevel: provider.evidenceLevel,
    reason: failures.join("; "),
    preconditions
  };
}

/**
 * Capability matching — the pre-plan gate (B3 §D5.4). Match *before* planning,
 * so a TaskDAG is never built out of capabilities that cannot be executed.
 *
 * Segment status: any MUST MISSING ⇒ BLOCKED; otherwise EXECUTABLE only when
 * every requirement in the segment is COVERED, else CONDITIONAL. (Reading
 * "段内全部 MUST = COVERED → EXECUTABLE" strictly would call a segment with a
 * MISSING SHOULD executable; that is optimistic, so CONDITIONAL wins.)
 *
 * Verdict: any MUST MISSING or BLOCKED segment ⇒ C; any remaining PARTIAL or
 * non-MUST MISSING ⇒ B; otherwise A.
 */
export function matchCapabilities(input: CapabilityMatchInput): CapabilityMatchReport {
  const parsed = capabilityMatchInputSchema.parse(input);

  const items: CapabilityMatchItem[] = parsed.goalSpec.requirements.map((requirement) => {
    const evaluation = evaluateRequirement(requirement, parsed.inventory);
    if (evaluation.status === "PARTIAL" && evaluation.preconditions.length === 0) {
      // Invariant guard: silent degradation is forbidden (D5.5 §2).
      throw new Error(
        `PARTIAL requirement '${requirement.reqId}' must list at least one precondition`
      );
    }
    return {
      reqId: requirement.reqId,
      capabilityRef: requirement.capabilityRef,
      weight: requirement.weight,
      status: evaluation.status,
      reason: evaluation.reason,
      evidenceLevel: evaluation.evidenceLevel as CapabilityMatchItem["evidenceLevel"],
      preconditions: evaluation.preconditions,
      ...(evaluation.unlockHint ? { unlockHint: evaluation.unlockHint } : {})
    };
  });

  const segments: CapabilityMatchSegment[] = [];
  for (const segment of CHAIN_SEGMENTS) {
    const inSegment = items.filter((item) => {
      const requirement = parsed.goalSpec.requirements.find((entry) => entry.reqId === item.reqId)!;
      return requirement.chainSegment === segment;
    });
    if (inSegment.length === 0) continue;

    const mustMissing = inSegment.some(
      (item) => item.weight === "MUST" && item.status === "MISSING"
    );
    const allCovered = inSegment.every((item) => item.status === "COVERED");
    segments.push({
      segment,
      status: mustMissing ? "BLOCKED" : allCovered ? "EXECUTABLE" : "CONDITIONAL"
    });
  }

  const mustItems = items.filter((item) => item.weight === "MUST");
  const anyMustMissing = mustItems.some((item) => item.status === "MISSING");
  const anyBlockedSegment = segments.some((segment) => segment.status === "BLOCKED");
  const anyDegraded = items.some((item) => item.status !== "COVERED");

  const verdict: ExecutabilityVerdict =
    anyMustMissing || anyBlockedSegment ? "C" : anyDegraded ? "B" : "A";

  return capabilityMatchReportSchema.parse({
    verdict,
    segments,
    items,
    reportVersion: CAPABILITY_MATCH_REPORT_VERSION,
    inputFingerprint: capabilityMatchInputFingerprint(parsed)
  });
}
