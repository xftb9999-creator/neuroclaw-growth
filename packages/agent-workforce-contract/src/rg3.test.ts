import { describe, expect, it } from "vitest";

import {
  CAPABILITY_INVENTORY_V1,
  agentEscalationSchema,
  agentKpiEntrySchema,
  agentMemoryScopeSchema,
  agentProfileSchema,
  capabilityInventoryFingerprint,
  type AgentContractField,
  type AgentProfile,
  type AgentRoleKey,
  type AgentSkillBinding,
  type AgentToolBinding
} from "./index.js";
import { canAgentTakeDuty, dutyContextSchema, type DutyContext } from "./duty-decision.js";

// ---------------------------------------------------------------------------
// RG-3 样例（依据提案 §二 字段 8/9/10；能力清单见 src/capability-inventory.v1.json）
// ---------------------------------------------------------------------------

function f(
  name: string,
  type: AgentContractField["type"],
  description: string,
  required = true
): AgentContractField {
  return { name, type, required, description };
}

function baseProfile(role: AgentRoleKey = "content_editor"): AgentProfile {
  return {
    role,
    inputContract: { fields: [f("businessSummary", "string", "Business context")] },
    outputContract: { fields: [f("contentAngles", "string[]", "Generated angles")] },
    acceptance: { requiredOutputFields: ["contentAngles"], minEvidenceLevel: "E1", verifier: "self" }
  };
}

const memoryScope = {
  visibility: "private" as const,
  namespace: "content_editor",
  retentionDays: 90,
  readableNamespaces: ["team:shared"]
};

const kpi = [
  {
    metricKey: "content_angles_delivered",
    target: 4,
    unit: "count",
    windowDays: 7,
    evidenceLevelRequired: "E1" as const
  }
];

const escalation = { reportsTo: "human" as const, onFailure: "halt" as const, maxRetries: 0 };

const availableSkill: AgentSkillBinding = {
  skillKey: "content_angles",
  skillVersion: "1.0.0",
  capabilityRefs: ["capability_growth_simulation"],
  promptTemplateRef: "prompt://content_angles"
};

const availableTool: AgentToolBinding = {
  toolKey: "browse_public_pages",
  capabilityRef: "browser_extract",
  scopes: ["read"],
  actionType: "browser_extract",
  requiresApproval: false
};

const missingTool: AgentToolBinding = {
  toolKey: "publish_channel",
  capabilityRef: "capability_channel_publish_xiaohongshu",
  scopes: ["read"],
  requiresApproval: false
};

const missingSkill: AgentSkillBinding = {
  skillKey: "compliance_check",
  skillVersion: "1.0.0",
  capabilityRefs: ["capability_compliance_tos_check"],
  promptTemplateRef: "prompt://compliance_check"
};

function dutyCtx(overrides: Partial<DutyContext> = {}): DutyContext {
  return { status: "ACTIVE", baseEngine: "content_acquisition", ...overrides };
}

// ---------------------------------------------------------------------------
// RG-3a 治理字段收紧（提案 §二 字段 8/9/10）
// ---------------------------------------------------------------------------

describe("RG-3a memoryScope 收紧", () => {
  it("合法值通过；缺 namespace/retentionDays 或未知键被拒", () => {
    expect(agentMemoryScopeSchema.safeParse(memoryScope).success).toBe(true);
    expect(agentMemoryScopeSchema.safeParse({ ...memoryScope, extra: 1 }).success).toBe(false);
    const { namespace: _namespace, ...withoutNamespace } = memoryScope;
    expect(agentMemoryScopeSchema.safeParse(withoutNamespace).success).toBe(false);
    expect(agentMemoryScopeSchema.safeParse({ ...memoryScope, namespace: "" }).success).toBe(false);
  });

  it("readableNamespaces 显式白名单：通配符被拒（跨工作区/项目禁止）", () => {
    expect(
      agentMemoryScopeSchema.safeParse({ ...memoryScope, readableNamespaces: ["*"] }).success
    ).toBe(false);
    expect(
      agentMemoryScopeSchema.safeParse({ ...memoryScope, readableNamespaces: ["workspace:*"] })
        .success
    ).toBe(false);
  });

  it("readableNamespaces 重复项与非正整数 retentionDays 被拒", () => {
    expect(
      agentMemoryScopeSchema.safeParse({
        ...memoryScope,
        readableNamespaces: ["team:shared", "team:shared"]
      }).success
    ).toBe(false);
    expect(agentMemoryScopeSchema.safeParse({ ...memoryScope, retentionDays: 0 }).success).toBe(
      false
    );
    expect(agentMemoryScopeSchema.safeParse({ ...memoryScope, retentionDays: 1.5 }).success).toBe(
      false
    );
  });
});

describe("RG-3a kpi 收紧", () => {
  it("合法条目与空数组通过；非法 windowDays / 证据级别被拒", () => {
    expect(agentKpiEntrySchema.safeParse(kpi[0]).success).toBe(true);
    expect(agentProfileSchema.safeParse({ ...baseProfile(), kpi: [] }).success).toBe(true);
    expect(agentKpiEntrySchema.safeParse({ ...kpi[0], windowDays: 0 }).success).toBe(false);
    expect(agentKpiEntrySchema.safeParse({ ...kpi[0], evidenceLevelRequired: "E4" }).success).toBe(
      false
    );
  });

  it("空 metricKey / 空 unit / 未知键被拒", () => {
    expect(agentKpiEntrySchema.safeParse({ ...kpi[0], metricKey: "" }).success).toBe(false);
    expect(agentKpiEntrySchema.safeParse({ ...kpi[0], unit: "" }).success).toBe(false);
    expect(agentKpiEntrySchema.safeParse({ ...kpi[0], extra: 1 }).success).toBe(false);
  });
});

describe("RG-3a escalation 收紧", () => {
  it("reportsTo 可为岗位键或 human；非法值被拒", () => {
    expect(agentEscalationSchema.safeParse(escalation).success).toBe(true);
    expect(
      agentEscalationSchema.safeParse({ ...escalation, reportsTo: "retro_officer" }).success
    ).toBe(true);
    expect(
      agentEscalationSchema.safeParse({ ...escalation, reportsTo: "unknown_role" }).success
    ).toBe(false);
  });

  it("onFailure 枚举 / maxRetries 非负整数 / 未知键约束", () => {
    expect(
      agentEscalationSchema.safeParse({ ...escalation, onFailure: "retry" }).success
    ).toBe(true);
    expect(
      agentEscalationSchema.safeParse({ ...escalation, onFailure: "ignore" }).success
    ).toBe(false);
    expect(agentEscalationSchema.safeParse({ ...escalation, maxRetries: -1 }).success).toBe(false);
    expect(agentEscalationSchema.safeParse({ ...escalation, maxRetries: 1.5 }).success).toBe(false);
    expect(agentEscalationSchema.safeParse({ ...escalation, extra: 1 }).success).toBe(false);
  });
});

describe("RG-3a profile 级收紧后果", () => {
  it("治理三字段可缺省（旧夹具兼容）", () => {
    expect(agentProfileSchema.safeParse(baseProfile()).success).toBe(true);
  });

  it("过渡空对象不再合法（memoryScope: {} / escalation: {} 被拒）", () => {
    expect(
      agentProfileSchema.safeParse({ ...baseProfile(), memoryScope: {}, kpi: [], escalation: {} })
        .success
    ).toBe(false);
  });

  it("合法治理组合通过（存在即须合规）", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      skills: [availableSkill],
      tools: [availableTool],
      memoryScope,
      kpi,
      escalation
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RG-3b canAgentTakeDuty 7 步裁决（agent-workforce.md:584-602）
// ---------------------------------------------------------------------------

describe("RG-3b canAgentTakeDuty 7 步裁决", () => {
  it("全步通过 → ELIGIBLE（7 步记录 + 指纹齐备）", () => {
    const decision = canAgentTakeDuty(
      { ...baseProfile(), skills: [availableSkill], tools: [availableTool] },
      dutyCtx({ allowedRiskClass: "MEDIUM" })
    );
    expect(decision.verdict).toBe("ELIGIBLE");
    expect(decision.steps.map((step) => step.step)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(decision.steps.at(-1)?.outcome).toBe("PASS");
    expect(decision.blocked).toEqual([]);
    expect(decision.blockedWriteScopes).toEqual([]);
    expect(decision.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(decision.inventoryFingerprint).toBe(capabilityInventoryFingerprint());
  });

  it("零绑定 profile → 步骤 3/4 空集通过 → ELIGIBLE", () => {
    const decision = canAgentTakeDuty(baseProfile(), dutyCtx());
    expect(decision.verdict).toBe("ELIGIBLE");
    expect(decision.steps.find((step) => step.step === 3)?.reason).toContain("空集");
  });

  it("INACTIVE → NOT_ELIGIBLE（仅步骤 1；优先于能力缺失）", () => {
    const decision = canAgentTakeDuty(
      { ...baseProfile(), tools: [missingTool] },
      dutyCtx({ status: "INACTIVE" })
    );
    expect(decision.verdict).toBe("NOT_ELIGIBLE");
    expect(decision.steps).toHaveLength(1);
    expect(decision.steps[0]?.step).toBe(1);
  });

  it("baseEngine 缺失 → NOT_ELIGIBLE（步骤 2）", () => {
    const decision = canAgentTakeDuty(baseProfile(), dutyCtx({ baseEngine: null }));
    expect(decision.verdict).toBe("NOT_ELIGIBLE");
    expect(decision.steps.map((step) => step.step)).toEqual([1, 2]);
  });

  it("tools capabilityRef MISSING → BLOCKED_BY_CAPABILITY + 名单", () => {
    const decision = canAgentTakeDuty(
      { ...baseProfile(), tools: [missingTool] },
      dutyCtx()
    );
    expect(decision.verdict).toBe("BLOCKED_BY_CAPABILITY");
    expect(decision.blocked).toEqual(["capability_channel_publish_xiaohongshu"]);
    expect(decision.steps.find((step) => step.step === 3)?.outcome).toBe("FAIL");
  });

  it("skills capabilityRef MISSING → BLOCKED_BY_CAPABILITY + 名单", () => {
    const decision = canAgentTakeDuty(
      { ...baseProfile(), skills: [missingSkill] },
      dutyCtx()
    );
    expect(decision.verdict).toBe("BLOCKED_BY_CAPABILITY");
    expect(decision.blocked).toEqual(["capability_compliance_tos_check"]);
    expect(decision.steps.find((step) => step.step === 4)?.outcome).toBe("FAIL");
  });

  it("writeScopes 非空且无授权链证据（缺省空集）→ BLOCKED（fail-closed）", () => {
    const decision = canAgentTakeDuty(
      {
        ...baseProfile(),
        permissions: {
          readScopes: [],
          writeScopes: ["publish:xiaohongshu"],
          maxRiskClass: "LOW",
          requiresApprovalFor: []
        }
      },
      dutyCtx()
    );
    expect(decision.verdict).toBe("BLOCKED_BY_CAPABILITY");
    expect(decision.blockedWriteScopes).toEqual(["publish:xiaohongshu"]);
    expect(decision.steps.find((step) => step.step === 5)?.outcome).toBe("FAIL");
  });

  it("writeScopes 全获授权链支持 → 步骤 5 PASS → ELIGIBLE", () => {
    const decision = canAgentTakeDuty(
      {
        ...baseProfile(),
        permissions: {
          readScopes: [],
          writeScopes: ["publish:xiaohongshu"],
          maxRiskClass: "LOW",
          requiresApprovalFor: []
        }
      },
      dutyCtx({ supportedWriteScopes: ["publish:xiaohongshu"] })
    );
    expect(decision.verdict).toBe("ELIGIBLE");
    expect(decision.steps.find((step) => step.step === 5)?.outcome).toBe("PASS");
  });

  it("风险档：maxRiskClass HIGH > 计划允许 LOW → PARTIAL；允许 HIGH → ELIGIBLE", () => {
    const highProfile: AgentProfile = {
      ...baseProfile(),
      permissions: {
        readScopes: [],
        writeScopes: [],
        maxRiskClass: "HIGH",
        requiresApprovalFor: []
      }
    };
    const partial = canAgentTakeDuty(highProfile, dutyCtx({ allowedRiskClass: "LOW" }));
    expect(partial.verdict).toBe("PARTIAL");
    expect(partial.steps.find((step) => step.step === 6)?.outcome).toBe("FAIL");

    const eligible = canAgentTakeDuty(highProfile, dutyCtx({ allowedRiskClass: "HIGH" }));
    expect(eligible.verdict).toBe("ELIGIBLE");
  });

  it("计划未声明 allowedRiskClass → 步骤 6 SKIPPED（不降级）", () => {
    const decision = canAgentTakeDuty(baseProfile(), dutyCtx());
    expect(decision.verdict).toBe("ELIGIBLE");
    expect(decision.steps.find((step) => step.step === 6)?.outcome).toBe("SKIPPED");
  });

  it("可复算：同输入两次调用字节一致；context 变化 → inputFingerprint 变化", () => {
    const profile: AgentProfile = { ...baseProfile(), skills: [availableSkill] };
    const context = dutyCtx({ allowedRiskClass: "MEDIUM" });
    const first = canAgentTakeDuty(profile, context);
    const second = canAgentTakeDuty(profile, context);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const changed = canAgentTakeDuty(profile, dutyCtx({ allowedRiskClass: "LOW" }));
    expect(changed.inputFingerprint).not.toBe(first.inputFingerprint);
  });

  it("DutyContext 严格校验（未知键/非法 status 被拒）", () => {
    expect(dutyContextSchema.safeParse(dutyCtx()).success).toBe(true);
    expect(dutyContextSchema.safeParse({ ...dutyCtx(), extra: 1 }).success).toBe(false);
    expect(
      dutyContextSchema.safeParse({ status: "PENDING", baseEngine: "content_acquisition" }).success
    ).toBe(false);
  });

  it("清单指纹透传：与 capabilityInventoryFingerprint 一致（含自定义清单）", () => {
    const decision = canAgentTakeDuty(baseProfile(), dutyCtx(), CAPABILITY_INVENTORY_V1);
    expect(decision.inventoryFingerprint).toBe(capabilityInventoryFingerprint(CAPABILITY_INVENTORY_V1));
  });
});
