import { describe, expect, it } from "vitest";

import {
  buildPilotSimulationAdapterInputs,
  researchClaimSchema,
  validateResearchPack,
  type ResearchClaim,
  type ResearchDecision,
  type ResearchMetricWatch,
  type ResearchQuestion,
  type ResearchSource
} from "./research-pack.js";
import { pilotAdapterManifests } from "./pilot-fixtures.js";

const scope = { organizationId: "org_ae1", workspaceId: "ws_ae1", projectId: "prj_ae1" } as const;
const entity = (id: string, sourceRefs: string[]) => ({
  id,
  schemaVersion: "1.0",
  scope,
  createdBy: "controller",
  createdAt: "2026-09-10T00:00:00Z",
  updatedAt: "2026-09-10T00:00:00Z",
  sourceRefs,
  metadata: {}
});

const source: ResearchSource = {
  ...entity("source_1", ["source_1"]),
  title: "Simulation baseline",
  kind: "FIXTURE",
  locator: "fixture://ae1/baseline",
  retrievedAt: "2026-09-10T00:00:00Z",
  evidenceLevel: "E3",
  status: "AVAILABLE"
};
const question: ResearchQuestion = {
  ...entity("question_1", [source.id]),
  title: "Can the pilot loop be replayed?",
  question: "Can the four project pilot loop be replayed without external writes?",
  objective: "Verify the simulation-only evidence path.",
  ownerRef: "controller",
  timeWindow: "2026-09-10/2026-09-17",
  status: "ACTIVE"
};
const claim: ResearchClaim = {
  ...entity("claim_1", [source.id]),
  questionRef: question.id,
  statement: "The fixture path is replayable without external side effects.",
  claimType: "FACT",
  evidenceLevel: "E3",
  confidence: "HIGH",
  status: "SUPPORTED",
  observedAt: "2026-09-10T00:00:00Z",
  contradictionRefs: []
};
const watch: ResearchMetricWatch = {
  ...entity("watch_1", [source.id]),
  questionRef: question.id,
  metricKey: "pilot_replay_success",
  purpose: "Track replayable simulation runs.",
  unit: "ratio",
  cadence: "per_round",
  status: "ACTIVE"
};
const decision: ResearchDecision = {
  ...entity("decision_1", [source.id]),
  questionRef: question.id,
  title: "Keep pilot adapters simulation-only",
  decision: "Keep all four pilot adapters read-only until real inputs are independently verified.",
  rationale: "The current evidence is a local fixture, not a project authorization.",
  claimRefs: [claim.id],
  metricWatchRefs: [watch.id],
  evidenceLevel: "E3",
  confidence: "HIGH",
  status: "APPROVED",
  nextActions: ["Collect real API/event/authorization evidence before adapter expansion."]
};

describe("Research Pack contract", () => {
  it("validates traceable question -> source -> claim -> decision -> watch links", () => {
    expect(validateResearchPack({
      scope,
      questions: [question],
      sources: [source],
      claims: [claim],
      decisions: [decision],
      metricWatches: [watch]
    })).toEqual({
      scope,
      questionCount: 1,
      sourceCount: 1,
      claimCount: 1,
      decisionCount: 1,
      metricWatchCount: 1,
      unresolvedClaimCount: 0,
      blockedDecisionCount: 0,
      highestEvidenceLevel: "E3"
    });
  });

  it("fails closed for missing source links and cross-scope entities", () => {
    expect(() => validateResearchPack({
      scope,
      questions: [question],
      sources: [source],
      claims: [{ ...claim, sourceRefs: ["missing_source"] }],
      decisions: [decision],
      metricWatches: [watch]
    })).toThrow("Claim claim_1 references a missing source");

    expect(() => validateResearchPack({
      scope,
      questions: [{ ...question, scope: { projectId: "other_project" } }],
      sources: [source],
      claims: [claim],
      decisions: [decision],
      metricWatches: [watch]
    })).toThrow("Question scope must match");

    expect(() => validateResearchPack({
      scope,
      questions: [question, { ...question, id: "question_1" }],
      sources: [source],
      claims: [claim],
      decisions: [decision],
      metricWatches: [watch]
    })).toThrow("Question IDs must be unique");

    expect(() => validateResearchPack({
      scope,
      questions: [question],
      sources: [source],
      claims: [claim],
      decisions: [decision],
      metricWatches: [watch, { ...watch, metricKey: "duplicate_id_watch" }]
    })).toThrow("Metric watch IDs must be unique");

    expect(() => validateResearchPack({
      scope,
      questions: [question],
      sources: [{ ...source, sourceRefs: ["source_1", "source_1"] }],
      claims: [claim],
      decisions: [decision],
      metricWatches: [watch]
    })).toThrow();
  });

  it("keeps all pilot adapter inputs simulation-only and rejects write scopes", () => {
    const inputs = buildPilotSimulationAdapterInputs();
    expect(inputs).toHaveLength(4);
    expect(inputs.every((input) => input.simulationOnly && input.status === "SANDBOXED" && input.writeScopes.length === 0 && input.sideEffects[0] === "none")).toBe(true);

    expect(() => buildPilotSimulationAdapterInputs({
      ...pilotAdapterManifests,
      uaos: { ...pilotAdapterManifests.uaos, writeScopes: ["external:write"] }
    })).toThrow("simulationOnly");
  });

  it("rejects research-pack adapters with controlled write bindings", () => {
    const uaosWithoutBindings = { ...pilotAdapterManifests.uaos };
    delete uaosWithoutBindings.controlledWriteBindings;
    expect(buildPilotSimulationAdapterInputs({
      ...pilotAdapterManifests,
      uaos: uaosWithoutBindings
    })).toHaveLength(4);

    expect(() => buildPilotSimulationAdapterInputs({
      ...pilotAdapterManifests,
      uaos: {
        ...pilotAdapterManifests.uaos,
        controlledWriteBindings: [{ actionRef: "action_write", resourceRef: "resource_write" }]
      }
    })).toThrow("simulationOnly");
  });

  it("keeps contradiction, deferred, and unknown states explicit", () => {
    const unresolvedClaim: ResearchClaim = {
      ...claim,
      id: "claim_unresolved",
      claimType: "INFERENCE",
      statement: "The simulation result may generalize to real projects.",
      confidence: "MEDIUM",
      status: "CONTRADICTED",
      contradictionRefs: [claim.id]
    };
    const deferredDecision: ResearchDecision = {
      ...decision,
      id: "decision_deferred",
      claimRefs: [unresolvedClaim.id],
      status: "DEFERRED",
      confidence: "UNKNOWN",
      decision: "Do not generalize the fixture result to real project performance.",
      nextActions: ["Collect independently verified real inputs before deciding."]
    };

    expect(validateResearchPack({
      scope,
      questions: [question],
      sources: [source],
      claims: [claim, unresolvedClaim],
      decisions: [deferredDecision],
      metricWatches: [watch]
    })).toMatchObject({ unresolvedClaimCount: 1, blockedDecisionCount: 1 });
  });

  it("does not promote E0 material to a factual claim", () => {
    expect(() => researchClaimSchema.parse({
      ...claim,
      evidenceLevel: "E0",
      claimType: "FACT"
    })).toThrow("E0 material cannot be promoted to a FACT claim");
  });
});
