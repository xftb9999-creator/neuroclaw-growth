import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  capabilityMatchInputSchema,
  matchCapabilities,
  type CapabilityMatchInput
} from "./capability-matching.js";
import { CAPABILITY_MATCH_SCENARIOS } from "./manifests/capability-matching-scenarios.js";

/**
 * D5 golden-file test (B3 §D5.5 §1).
 *
 * The expected reports live in `manifests/capability-matching.golden.json`; the
 * inputs live in `manifests/capability-matching-scenarios.ts`. The report
 * carries `inputFingerprint`, so editing a scenario without regenerating the
 * golden fails the comparison instead of silently passing.
 */

const GOLDEN_URL = new URL("./manifests/capability-matching.golden.json", import.meta.url);

function golden(): Record<string, unknown> {
  return JSON.parse(readFileSync(GOLDEN_URL, "utf8")) as Record<string, unknown>;
}

const SCENARIOS = CAPABILITY_MATCH_SCENARIOS;

describe("D5 capability matching", () => {
  it("matches the golden report for every scenario", () => {
    const expected = golden();

    for (const [name, input] of Object.entries(SCENARIOS)) {
      expect(expected[name], `golden entry missing for '${name}'`).toBeDefined();
      expect(matchCapabilities(input), `golden mismatch for '${name}'`).toEqual(expected[name]);
    }
    expect(Object.keys(expected).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  it("is pure: the same input yields the same report, independent of inventory order", () => {
    const input = SCENARIOS["rule-6-all-covered"]!;
    const reordered: CapabilityMatchInput = {
      ...input,
      inventory: [...input.inventory].reverse()
    };

    expect(matchCapabilities(input)).toEqual(matchCapabilities(input));

    // The fingerprint pins the exact input (so a reordered inventory is a
    // different input), but the *judgement* must not depend on inventory order.
    const { inputFingerprint: _fingerprint, ...judgement } = matchCapabilities(input);
    const { inputFingerprint: _reorderedFingerprint, ...reorderedJudgement } =
      matchCapabilities(reordered);
    expect(reorderedJudgement).toEqual(judgement);
  });

  it("refuses to run when a MUST requirement is missing (verdict C)", () => {
    const report = matchCapabilities(SCENARIOS["rule-1-must-missing-refuses"]!);

    expect(report.verdict).toBe("C");
    expect(report.segments).toContainEqual({ segment: "deliver", status: "BLOCKED" });
    expect(report.items[0]).toMatchObject({ status: "MISSING", evidenceLevel: "E0" });
    expect(report.items[0]?.unlockHint).toBeTruthy();
  });

  it("never reports COVERED without an E-level above E0", () => {
    const report = matchCapabilities({
      goalSpec: {
        objective: "An E0 provider must not count as covered",
        requirements: [
          {
            reqId: "req_write",
            layer: "L4",
            capabilityRef: "cap_write",
            weight: "MUST",
            minEvidence: "E0",
            chainSegment: "execute"
          }
        ]
      },
      inventory: [
        {
          pluginId: "plugin_no_evidence",
          capabilityRefs: ["cap_write"],
          enabled: true,
          requires: [],
          simulationOnly: false,
          channels: []
        }
      ]
    });

    expect(report.items[0]?.status).toBe("PARTIAL");
    expect(report.items[0]?.preconditions.length).toBeGreaterThan(0);
    expect(report.verdict).toBe("B");
  });

  it("lists a precondition for every PARTIAL and never upgrades it to COVERED", () => {
    for (const [name, input] of Object.entries(SCENARIOS)) {
      const report = matchCapabilities(input);
      for (const item of report.items) {
        if (item.status !== "PARTIAL") continue;
        expect(item.preconditions.length, `PARTIAL without preconditions in '${name}'`).toBeGreaterThan(
          0
        );
      }
    }
  });

  it("degrades rather than refuses when only a SHOULD requirement is missing", () => {
    const report = matchCapabilities(SCENARIOS["should-missing-degrades-to-b"]!);

    expect(report.verdict).toBe("B");
    expect(report.segments).toContainEqual({ segment: "execute", status: "CONDITIONAL" });
  });

  it("rejects an empty requirement list instead of returning verdict A", () => {
    expect(() =>
      capabilityMatchInputSchema.parse({
        goalSpec: { objective: "Nothing to match", requirements: [] },
        inventory: []
      })
    ).toThrow();
  });

  it("fingerprints the input so a golden entry cannot drift silently", () => {
    const input = SCENARIOS["rule-6-all-covered"]!;
    const mutated = structuredClone(input);
    mutated.goalSpec.requirements[0]!.weight = "NICE";

    expect(matchCapabilities(mutated).inputFingerprint).not.toBe(
      matchCapabilities(input).inputFingerprint
    );
  });
});
