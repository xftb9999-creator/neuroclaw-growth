import type { CapabilityMatchInput } from "../capability-matching.js";

/**
 * D5 golden-file scenarios. Kept as a module (not inline in the test) so the
 * golden report can be regenerated from exactly the inputs the test asserts on.
 *
 * Six scenarios — one per fail-closed rule, plus the fully-covered baseline.
 * Rules: 1 missing provider, 2 unusable provider, 3 evidence shortfall,
 * 4 deliver channel not READY, 5 simulation-only for a real effect, 6 covered.
 */

const PLUGIN_BASE = {
  enabled: true,
  requires: [],
  simulationOnly: false,
  channels: []
};

export const CAPABILITY_MATCH_SCENARIOS: Record<string, CapabilityMatchInput> = {
  "rule-6-all-covered": {
    goalSpec: {
      objective: "Ship a research-backed outreach campaign",
      requirements: [
        {
          reqId: "req_research",
          layer: "L2",
          capabilityRef: "cap_research",
          weight: "MUST",
          minEvidence: "E2",
          chainSegment: "input"
        },
        {
          reqId: "req_write",
          layer: "L4",
          capabilityRef: "cap_write",
          weight: "MUST",
          minEvidence: "E2",
          chainSegment: "execute"
        },
        {
          reqId: "req_send",
          layer: "L5",
          capabilityRef: "cap_send",
          weight: "MUST",
          minEvidence: "E2",
          chainSegment: "deliver",
          requiresRealSideEffect: true
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_alpha",
        capabilityRefs: ["cap_research", "cap_write"],
        evidenceLevel: "E3"
      },
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_beta",
        capabilityRefs: ["cap_send"],
        evidenceLevel: "E2",
        channels: [{ channel: "email", accountStatus: "READY" }]
      }
    ]
  },

  "rule-1-must-missing-refuses": {
    goalSpec: {
      objective: "Publish to a channel no plugin covers",
      requirements: [
        {
          reqId: "req_publish",
          layer: "L5",
          capabilityRef: "cap_publish",
          weight: "MUST",
          minEvidence: "E1",
          chainSegment: "deliver",
          requiresRealSideEffect: true
        }
      ]
    },
    inventory: []
  },

  "rule-2-dependency-unresolved": {
    goalSpec: {
      objective: "Use a provider whose dependency cannot be resolved",
      requirements: [
        {
          reqId: "req_dep",
          layer: "L3",
          capabilityRef: "cap_dep",
          weight: "MUST",
          minEvidence: "E1",
          chainSegment: "plan"
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_dep",
        capabilityRefs: ["cap_dep"],
        evidenceLevel: "E3",
        requires: [{ ref: "plugin_base", satisfied: false }]
      }
    ]
  },

  "rule-3-evidence-shortfall": {
    goalSpec: {
      objective: "Use a provider whose evidence is too weak",
      requirements: [
        {
          reqId: "req_write",
          layer: "L4",
          capabilityRef: "cap_write",
          weight: "MUST",
          minEvidence: "E3",
          chainSegment: "execute"
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_alpha",
        capabilityRefs: ["cap_write"],
        evidenceLevel: "E1"
      }
    ]
  },

  "rule-4-channel-not-ready": {
    goalSpec: {
      objective: "Deliver through an account that is not ready",
      requirements: [
        {
          reqId: "req_send",
          layer: "L5",
          capabilityRef: "cap_send",
          weight: "MUST",
          minEvidence: "E1",
          chainSegment: "deliver",
          requiresRealSideEffect: true
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_beta",
        capabilityRefs: ["cap_send"],
        evidenceLevel: "E3",
        channels: [
          { channel: "email", accountStatus: "PENDING" },
          { channel: "sms", accountStatus: "DISABLED" }
        ]
      }
    ]
  },

  "rule-5-simulation-only-for-real-effect": {
    goalSpec: {
      objective: "Produce a real side effect with a simulation-only provider",
      requirements: [
        {
          reqId: "req_publish",
          layer: "L5",
          capabilityRef: "cap_publish",
          weight: "MUST",
          minEvidence: "E1",
          chainSegment: "deliver",
          requiresRealSideEffect: true
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_sim",
        capabilityRefs: ["cap_publish"],
        evidenceLevel: "E3",
        simulationOnly: true,
        channels: [{ channel: "email", accountStatus: "READY" }]
      }
    ]
  },

  "should-missing-degrades-to-b": {
    goalSpec: {
      objective: "A required capability plus a nice-to-have that is absent",
      requirements: [
        {
          reqId: "req_write",
          layer: "L4",
          capabilityRef: "cap_write",
          weight: "MUST",
          minEvidence: "E1",
          chainSegment: "execute"
        },
        {
          reqId: "req_optimize",
          layer: "L7",
          capabilityRef: "cap_optimize",
          weight: "SHOULD",
          minEvidence: "E1",
          chainSegment: "execute"
        }
      ]
    },
    inventory: [
      {
        ...PLUGIN_BASE,
        pluginId: "plugin_alpha",
        capabilityRefs: ["cap_write"],
        evidenceLevel: "E3"
      }
    ]
  }
};
