import { describe, expect, it } from "vitest";

import {
  AGENT_ROLE_KEYS,
  acceptanceEvidenceLevelSchema,
  agentProfileSchema,
  validateAgentInputContract,
  validateAgentOutputContract
} from "./index.js";
import type {
  AgentAcceptance,
  AgentContractField,
  AgentProfile,
  AgentRoleKey
} from "./index.js";

// ---------------------------------------------------------------------------
// RG-1 样例夹具（8 岗位 × 4 必填）
// 3 个 E3 岗位的 input/output 契约直迁 templates 原文（零新写）；
// 5 个设计岗为最小草案（E1，仅用于契约通过性样例，不构成冻结内容）。
// ---------------------------------------------------------------------------

function f(
  name: string,
  type: AgentContractField["type"],
  description: string,
  required = true
): AgentContractField {
  return { name, type, required, description };
}

function sample(
  role: AgentRoleKey,
  inputFields: AgentContractField[],
  outputFields: AgentContractField[],
  acceptance: AgentAcceptance
): AgentProfile {
  return {
    role,
    inputContract: { fields: inputFields },
    outputContract: { fields: outputFields },
    acceptance
  };
}

const goalOfficer = sample(
  "goal_officer",
  [
    f("businessSummary", "string", "Business context"),
    f("targetCustomer", "string", "Target customer"),
    f("timeHorizonDays", "number", "Planning horizon in days")
  ],
  [
    f("goalStatement", "string", "Single-sentence goal"),
    f("successMetrics", "string[]", "Measurable success metrics")
  ],
  { requiredOutputFields: ["goalStatement", "successMetrics"], minEvidenceLevel: "E1", verifier: "self" }
);

const strategist = sample(
  "strategist",
  [
    f("businessSummary", "string", "Business context"),
    f("goalStatement", "string", "Goal to plan for"),
    f("preferredChannels", "string[]", "Candidate channels")
  ],
  [
    f("planSteps", "string[]", "Ordered plan steps"),
    f("riskNotes", "string[]", "Known risks and constraints")
  ],
  { requiredOutputFields: ["planSteps"], minEvidenceLevel: "E1", verifier: "peer_role" }
);

// 直迁自 templates content_acquisition（templates/src/index.ts:45-58）
const contentEditor = sample(
  "content_editor",
  [
    f("businessSummary", "string", "Business context"),
    f("targetCustomer", "string", "Target customer"),
    f("preferredChannels", "string[]", "Preferred channels"),
    f("contentGoal", "string", "Desired content outcome")
  ],
  [
    f("contentAngles", "string[]", "Generated content angles"),
    f("channelRecommendations", "string[]", "Recommended channels")
  ],
  {
    requiredOutputFields: ["contentAngles", "channelRecommendations"],
    minEvidenceLevel: "E1",
    verifier: "self"
  }
);

// 直迁自 templates private_conversion（templates/src/index.ts:65-99，止于审批）
const conversionWriter = sample(
  "conversion_writer",
  [
    f("businessSummary", "string", "Offer context"),
    f("targetCustomer", "string", "Lead segment"),
    f("preferredChannels", "string[]", "Outreach channels"),
    f("offerAsset", "string", "Offer asset"),
    f("recipientEmail", "string", "Optional recipient email for approved delivery", false)
  ],
  [
    f("conversionDraft", "string", "Conversion draft"),
    f("approvalPreview", "string", "Approval preview")
  ],
  {
    requiredOutputFields: ["conversionDraft", "approvalPreview"],
    minEvidenceLevel: "E1",
    verifier: "human"
  }
);

const channelOps = sample(
  "channel_ops",
  [
    f("businessSummary", "string", "Business context"),
    f("preferredChannels", "string[]", "Candidate channels"),
    f("contentAngles", "string[]", "Angles to distribute")
  ],
  [
    f("channelPlan", "string", "Per-channel publish plan"),
    f("publishSchedule", "string[]", "Proposed publish schedule")
  ],
  {
    requiredOutputFields: ["channelPlan", "publishSchedule"],
    minEvidenceLevel: "E1",
    verifier: "self"
  }
);

// 直迁自 templates weekly_review（templates/src/index.ts:111-125）
const analyst = sample(
  "analyst",
  [
    f("businessSummary", "string", "Business context"),
    f("targetCustomer", "string", "Audience context"),
    f("preferredChannels", "string[]", "Relevant channels"),
    f("metricsWindowDays", "number", "Metrics review window"),
    f("metricsSummary", "string", "Optional metrics digest for the review window", false)
  ],
  [
    f("reviewSummary", "string", "Weekly review summary"),
    f("nextActions", "string[]", "Recommended follow-ups")
  ],
  {
    requiredOutputFields: ["reviewSummary", "nextActions"],
    minEvidenceLevel: "E1",
    verifier: "self"
  }
);

const complianceReviewer = sample(
  "compliance_reviewer",
  [
    f("contentDraft", "string", "Draft to review"),
    f("channelTarget", "string", "Target channel")
  ],
  [
    f("complianceVerdict", "string", "Pass / block verdict"),
    f("blockedReasons", "string[]", "Reasons if blocked")
  ],
  { requiredOutputFields: ["complianceVerdict"], minEvidenceLevel: "E2", verifier: "human" }
);

const retroOfficer = sample(
  "retro_officer",
  [
    f("goalStatement", "string", "Goal being reviewed"),
    f("metricsSummary", "string", "Metrics digest"),
    f("reviewSummary", "string", "Optional prior review", false)
  ],
  [
    f("retroSummary", "string", "Retrospective summary"),
    f("nextActions", "string[]", "Follow-ups")
  ],
  {
    requiredOutputFields: ["retroSummary", "nextActions"],
    minEvidenceLevel: "E1",
    verifier: "self"
  }
);

const samples: AgentProfile[] = [
  goalOfficer,
  strategist,
  contentEditor,
  conversionWriter,
  channelOps,
  analyst,
  complianceReviewer,
  retroOfficer
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgentRoleKey（8 岗位键）", () => {
  it("恰为方案稿 §3.2 的 8 个 roleKey（固定顺序）", () => {
    expect([...AGENT_ROLE_KEYS]).toEqual([
      "goal_officer",
      "strategist",
      "content_editor",
      "conversion_writer",
      "channel_ops",
      "analyst",
      "compliance_reviewer",
      "retro_officer"
    ]);
  });
});

describe("RG-1 样例 profile（8 岗位 × 4 必填）", () => {
  for (const profile of samples) {
    it(`${profile.role} 通过 agentProfileSchema（strict）`, () => {
      const parsed = agentProfileSchema.safeParse(profile);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    });
  }
});

describe("agentProfileSchema 门禁", () => {
  it(".strict() 拒绝未知顶层字段", () => {
    expect(agentProfileSchema.safeParse({ ...contentEditor, unknownField: 1 }).success).toBe(false);
  });

  for (const key of ["role", "inputContract", "outputContract", "acceptance"] as const) {
    it(`4 必填：缺 ${key} 被拒`, () => {
      const { [key]: _removed, ...rest } = contentEditor;
      expect(agentProfileSchema.safeParse(rest).success).toBe(false);
    });
  }

  it("非法 role 值被拒", () => {
    expect(agentProfileSchema.safeParse({ ...contentEditor, role: "cto" }).success).toBe(false);
  });

  it("requiredOutputFields 必须 ⊆ outputContract 声明字段", () => {
    const bad: AgentProfile = {
      ...contentEditor,
      acceptance: { ...contentEditor.acceptance, requiredOutputFields: ["notDeclared"] }
    };
    expect(agentProfileSchema.safeParse(bad).success).toBe(false);
  });

  it("acceptance 证据级别为 E0–E3（E4 不接受）", () => {
    expect(acceptanceEvidenceLevelSchema.safeParse("E3").success).toBe(true);
    expect(acceptanceEvidenceLevelSchema.safeParse("E4").success).toBe(false);
  });

  it("6 过渡键位可缺省（样例本身即缺省态）", () => {
    expect("skills" in contentEditor).toBe(false);
    expect(agentProfileSchema.safeParse(contentEditor).success).toBe(true);
  });

  it("6 过渡键位被接受（RG-2/RG-3 收紧后须为合法值）", () => {
    const withDefaults = {
      ...contentEditor,
      skills: [],
      tools: [],
      permissions: { readScopes: [], writeScopes: [], maxRiskClass: "LOW", requiresApprovalFor: [] },
      memoryScope: {
        visibility: "private",
        namespace: "content_editor",
        retentionDays: 90,
        readableNamespaces: []
      },
      kpi: [],
      escalation: { reportsTo: "human", onFailure: "halt", maxRetries: 0 }
    };
    expect(agentProfileSchema.safeParse(withDefaults).success).toBe(true);
  });
});

describe("validateAgentInputContract（复用 shared 校验器）", () => {
  const contract = contentEditor.inputContract;

  it("合法输入通过", () => {
    expect(() =>
      validateAgentInputContract(
        {
          businessSummary: "b",
          targetCustomer: "t",
          preferredChannels: ["x"],
          contentGoal: "g"
        },
        contract
      )
    ).not.toThrow();
  });

  it("必填缺失抛错", () => {
    expect(() => validateAgentInputContract({ businessSummary: "b" }, contract)).toThrow(
      /targetCustomer/
    );
  });

  it("类型不符抛错", () => {
    expect(() =>
      validateAgentInputContract(
        {
          businessSummary: 1,
          targetCustomer: "t",
          preferredChannels: ["x"],
          contentGoal: "g"
        },
        contract
      )
    ).toThrow(/businessSummary/);
  });
});

describe("validateAgentOutputContract（必填 + 未声明字段）", () => {
  const contract = contentEditor.outputContract;

  it("合法输出通过", () => {
    expect(() =>
      validateAgentOutputContract({ contentAngles: ["a"], channelRecommendations: ["b"] }, contract)
    ).not.toThrow();
  });

  it("必填缺失抛错", () => {
    expect(() => validateAgentOutputContract({ contentAngles: ["a"] }, contract)).toThrow(
      /channelRecommendations/
    );
  });

  it("未声明字段抛错（防上游污染下游）", () => {
    expect(() =>
      validateAgentOutputContract(
        { contentAngles: ["a"], channelRecommendations: ["b"], extra: 1 },
        contract
      )
    ).toThrow(/undeclared field: extra/);
  });
});
