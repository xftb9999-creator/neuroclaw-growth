import { z } from "zod";

import {
  evidenceLevelSchema,
  sourceRefsSchema,
  universalIdSchema,
  universalScopeSchema,
  utcTimestampSchema,
  type AdapterManifest,
  type EvidenceLevel,
  type UniversalScope
} from "./universal-contracts.js";
import { buildSimulationAdapterInputs, type SimulationAdapterInput } from "./project-integration.js";
import { pilotAdapterManifests } from "./pilot-fixtures.js";

/**
 * Round AE-1: Research Pack contract.
 *
 * This is a pure, local contract layer. It deliberately models unknown and
 * contradictory research as explicit states and never turns simulation data
 * into a production fact or a real adapter capability.
 */

const researchEntityFields = {
  id: universalIdSchema,
  schemaVersion: z.string().min(1),
  scope: universalScopeSchema,
  createdBy: universalIdSchema,
  createdAt: utcTimestampSchema,
  updatedAt: utcTimestampSchema,
  sourceRefs: sourceRefsSchema,
  metadata: z.record(z.string(), z.unknown()).default({})
};

export const researchStatusSchema = z.enum([
  "DRAFT",
  "READY",
  "ACTIVE",
  "COMPLETED",
  "UNKNOWN",
  "DEGRADED",
  "BLOCKED",
  "DEFERRED"
]);
export type ResearchStatus = z.infer<typeof researchStatusSchema>;

export const researchConfidenceSchema = z.enum(["UNKNOWN", "LOW", "MEDIUM", "HIGH"]);
export type ResearchConfidence = z.infer<typeof researchConfidenceSchema>;

export const researchClaimTypeSchema = z.enum([
  "FACT",
  "INFERENCE",
  "ASSUMPTION",
  "UNVERIFIED_VIEW"
]);
export type ResearchClaimType = z.infer<typeof researchClaimTypeSchema>;

export const researchSourceKindSchema = z.enum(["DOCUMENT", "DATASET", "EVENT", "FIXTURE"]);
export const researchSourceStatusSchema = z.enum(["AVAILABLE", "PENDING", "UNAVAILABLE"]);

export const researchSourceSchema = z
  .object({
    ...researchEntityFields,
    title: z.string().min(1),
    kind: researchSourceKindSchema,
    locator: z.string().min(1),
    publisher: z.string().min(1).optional(),
    publishedAt: utcTimestampSchema.optional(),
    retrievedAt: utcTimestampSchema,
    evidenceLevel: evidenceLevelSchema,
    status: researchSourceStatusSchema,
    excerpt: z.string().min(1).optional()
  })
  .strict();
export type ResearchSource = z.infer<typeof researchSourceSchema>;

export const researchQuestionSchema = z
  .object({
    ...researchEntityFields,
    title: z.string().min(1),
    question: z.string().min(1),
    objective: z.string().min(1),
    ownerRef: universalIdSchema,
    timeWindow: z.string().min(1),
    status: researchStatusSchema
  })
  .strict();
export type ResearchQuestion = z.infer<typeof researchQuestionSchema>;

export const researchClaimSchema = z
  .object({
    ...researchEntityFields,
    questionRef: universalIdSchema,
    statement: z.string().min(1),
    claimType: researchClaimTypeSchema,
    evidenceLevel: evidenceLevelSchema,
    confidence: researchConfidenceSchema,
    status: z.enum(["SUPPORTED", "PARTIAL", "CONTRADICTED", "UNVERIFIED"]),
    observedAt: utcTimestampSchema,
    contradictionRefs: z.array(universalIdSchema).default([])
  })
  .strict()
  .superRefine((claim, ctx) => {
    if (claim.status === "SUPPORTED" && claim.confidence === "UNKNOWN") {
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "SUPPORTED claims require a non-UNKNOWN confidence"
      });
    }
    if (claim.claimType === "FACT" && claim.evidenceLevel === "E0") {
      ctx.addIssue({
        code: "custom",
        path: ["evidenceLevel"],
        message: "E0 material cannot be promoted to a FACT claim"
      });
    }
  });
export type ResearchClaim = z.infer<typeof researchClaimSchema>;

export const researchMetricWatchSchema = z
  .object({
    ...researchEntityFields,
    questionRef: universalIdSchema,
    metricKey: z.string().min(1),
    purpose: z.string().min(1),
    target: z.union([z.string(), z.number()]).optional(),
    unit: z.string().min(1),
    cadence: z.string().min(1),
    status: z.enum(["DRAFT", "ACTIVE", "PAUSED", "UNKNOWN"])
  })
  .strict();
export type ResearchMetricWatch = z.infer<typeof researchMetricWatchSchema>;

export const researchDecisionSchema = z
  .object({
    ...researchEntityFields,
    questionRef: universalIdSchema,
    title: z.string().min(1),
    decision: z.string().min(1),
    rationale: z.string().min(1),
    claimRefs: z.array(universalIdSchema).min(1),
    metricWatchRefs: z.array(universalIdSchema).default([]),
    evidenceLevel: evidenceLevelSchema,
    confidence: researchConfidenceSchema,
    status: z.enum(["PROPOSED", "APPROVED", "DEFERRED", "REJECTED", "UNKNOWN"]),
    nextActions: z.array(z.string().min(1)).min(1)
  })
  .strict()
  .superRefine((decision, ctx) => {
    if (decision.status === "APPROVED" && decision.confidence === "UNKNOWN") {
      ctx.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "APPROVED decisions require a non-UNKNOWN confidence"
      });
    }
  });
export type ResearchDecision = z.infer<typeof researchDecisionSchema>;

export interface ResearchPackInput {
  scope: UniversalScope;
  questions: readonly ResearchQuestion[];
  sources: readonly ResearchSource[];
  claims: readonly ResearchClaim[];
  decisions: readonly ResearchDecision[];
  metricWatches: readonly ResearchMetricWatch[];
}

export interface ResearchPackSummary {
  scope: UniversalScope;
  questionCount: number;
  sourceCount: number;
  claimCount: number;
  decisionCount: number;
  metricWatchCount: number;
  unresolvedClaimCount: number;
  blockedDecisionCount: number;
  highestEvidenceLevel: EvidenceLevel | null;
}

function assertUniqueIds(label: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error(`${label} IDs must be unique`);
}

function assertSameScope(scope: UniversalScope, label: string, entities: readonly { scope: UniversalScope }[]): void {
  for (const entity of entities) {
    const keys: Array<keyof UniversalScope> = ["organizationId", "workspaceId", "projectId"];
    if (keys.some((key) => entity.scope[key] !== scope[key])) {
      throw new Error(`${label} scope must match the Research Pack scope`);
    }
  }
}

/** Validate object links before a Research Pack can be rendered or persisted. */
export function validateResearchPack(input: ResearchPackInput): ResearchPackSummary {
  const scope = universalScopeSchema.parse(input.scope);
  const questions = researchQuestionSchema.array().parse(input.questions);
  const sources = researchSourceSchema.array().parse(input.sources);
  const claims = researchClaimSchema.array().parse(input.claims);
  const decisions = researchDecisionSchema.array().parse(input.decisions);
  const metricWatches = researchMetricWatchSchema.array().parse(input.metricWatches);

  assertSameScope(scope, "Question", questions);
  assertSameScope(scope, "Source", sources);
  assertSameScope(scope, "Claim", claims);
  assertSameScope(scope, "Decision", decisions);
  assertSameScope(scope, "Metric watch", metricWatches);

  const questionIds = new Set(questions.map((item) => item.id));
  const sourceIds = new Set(sources.map((item) => item.id));
  const claimIds = new Set(claims.map((item) => item.id));
  const watchIds = new Set(metricWatches.map((item) => item.id));
  assertUniqueIds("Question", questions.map((item) => item.id));
  assertUniqueIds("Source", sources.map((item) => item.id));
  assertUniqueIds("Claim", claims.map((item) => item.id));
  assertUniqueIds("Decision", decisions.map((item) => item.id));
  assertUniqueIds("Metric watch", metricWatches.map((item) => item.id));

  for (const question of questions) {
    if (question.sourceRefs.some((ref) => !sourceIds.has(ref))) {
      throw new Error(`Question ${question.id} references a missing source`);
    }
  }
  for (const claim of claims) {
    if (!questionIds.has(claim.questionRef)) throw new Error(`Claim ${claim.id} references a missing question`);
    if (claim.sourceRefs.some((ref) => !sourceIds.has(ref))) {
      throw new Error(`Claim ${claim.id} references a missing source`);
    }
    if (claim.contradictionRefs.some((ref) => !claimIds.has(ref))) {
      throw new Error(`Claim ${claim.id} references a missing contradiction claim`);
    }
  }
  for (const watch of metricWatches) {
    if (!questionIds.has(watch.questionRef)) throw new Error(`Metric watch ${watch.id} references a missing question`);
    if (watch.sourceRefs.some((ref) => !sourceIds.has(ref))) {
      throw new Error(`Metric watch ${watch.id} references a missing source`);
    }
  }
  for (const decision of decisions) {
    if (!questionIds.has(decision.questionRef)) throw new Error(`Decision ${decision.id} references a missing question`);
    if (decision.sourceRefs.some((ref) => !sourceIds.has(ref))) {
      throw new Error(`Decision ${decision.id} references a missing source`);
    }
    if (decision.claimRefs.some((ref) => !claimIds.has(ref))) {
      throw new Error(`Decision ${decision.id} references a missing claim`);
    }
    if (decision.metricWatchRefs.some((ref) => !watchIds.has(ref))) {
      throw new Error(`Decision ${decision.id} references a missing metric watch`);
    }
  }

  const evidenceLevels = [...sources, ...claims, ...decisions].map((item) => item.evidenceLevel);
  const levelRank: Record<EvidenceLevel, number> = { E0: 0, E1: 1, E2: 2, E3: 3, E4: 4 };
  const highestEvidenceLevel = evidenceLevels.length
    ? evidenceLevels.reduce((highest, current) => levelRank[current] > levelRank[highest] ? current : highest)
    : null;

  return {
    scope,
    questionCount: questions.length,
    sourceCount: sources.length,
    claimCount: claims.length,
    decisionCount: decisions.length,
    metricWatchCount: metricWatches.length,
    unresolvedClaimCount: claims.filter((claim) => claim.status !== "SUPPORTED").length,
    blockedDecisionCount: decisions.filter((decision) => decision.status === "UNKNOWN" || decision.status === "DEFERRED").length,
    highestEvidenceLevel
  };
}

export type { SimulationAdapterInput } from "./project-integration.js";

/**
 * The simulation-only adapter gate and input shape live in the universal
 * integration kernel; this wrapper keeps the pilot-specific default entry
 * used by the Research Pack contract tests and report builders.
 */
export function buildPilotSimulationAdapterInputs(
  manifests: Record<string, AdapterManifest> = pilotAdapterManifests
): SimulationAdapterInput[] {
  return buildSimulationAdapterInputs(manifests);
}
