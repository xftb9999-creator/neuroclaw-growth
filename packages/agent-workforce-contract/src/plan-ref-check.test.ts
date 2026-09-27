import { describe, expect, it } from "vitest";

import {
  capabilityInventoryFingerprint,
  type AgentContractField,
  type AgentProfile,
  type AgentSkillBinding,
  type PlanSpec,
  type TaskNode
} from "./index.js";
import { canAgentTakeDuty, type DutyContext, type DutyDecision } from "./duty-decision.js";
import { validatePlanSpecRefs } from "./plan-ref-check.js";

// ---------------------------------------------------------------------------
// F5a 夹具：1 TaskNode PlanSpec（来源 agent-workforce.md:200-243；字段值仅样例）。
// 覆盖口径：清单 AVAILABLE 条目（content_acquisition / capability_growth_simulation）vs
// MISSING 条目（capability_channel_publish_xiaohongshu / capability_ratelimit_enforce）。
// ---------------------------------------------------------------------------

const INVENTORY_FINGERPRINT = capabilityInventoryFingerprint();

function f(name: string, type: AgentContractField["type"]): AgentContractField {
  return { name, type, required: true, description: `${name} field` };
}

function baseProfile(role: AgentProfile["role"] = "content_editor"): AgentProfile {
  return {
    role,
    inputContract: { fields: [f("businessSummary", "string")] },
    outputContract: { fields: [f("contentAngles", "string[]")] },
    acceptance: {
      requiredOutputFields: ["contentAngles"],
      minEvidenceLevel: "E1",
      verifier: "self"
    }
  };
}

const availableSkill: AgentSkillBinding = {
  skillKey: "content_angles",
  skillVersion: "1.0.0",
  capabilityRefs: ["capability_growth_simulation"],
  promptTemplateRef: "prompt://content_angles"
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

function eligibleDecision(): DutyDecision {
  return canAgentTakeDuty({ ...baseProfile(), skills: [availableSkill] }, dutyCtx());
}

function blockedDecision(): DutyDecision {
  return canAgentTakeDuty({ ...baseProfile(), skills: [missingSkill] }, dutyCtx());
}

function task(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    taskId: "task_generate",
    kind: "generate",
    title: "生成内容角度",
    capabilityRefs: ["content_acquisition"],
    assignedRole: "content_editor",
    inputs: [],
    outputs: [{ field: "contentAngles", contract: [f("contentAngles", "string[]")] }],
    acceptanceCriteria: [
      {
        criterionId: "ac_1",
        key: "angles_count",
        target: 3,
        unit: "个",
        evidenceLevelRequired: "E1"
      }
    ],
    riskClass: "LOW",
    timeoutMs: 60000,
    approvalPoint: false,
    retryPolicy: { maxAttempts: 1 },
    failurePolicy: "explicit_failure",
    ...overrides
  };
}

function plan(overrides: Partial<PlanSpec> = {}): PlanSpec {
  return {
    planId: "plan_1",
    planVersion: "0.1.0",
    schemaVersion: "1.0",
    goalSpecRef: { goalId: "goal_1", goalVersion: "0.1.0", goalFingerprint: "b".repeat(64) },
    plannerVersion: "rules-v1",
    plannerKind: "rules",
    status: "NEEDS_APPROVAL",
    tasks: [task()],
    edges: [],
    approvalPoints: [],
    approvalPolicy: {},
    inventoryFingerprint: INVENTORY_FINGERPRINT,
    executabilityTier: "A",
    executabilityReportRef: "report_1",
    missingCapabilities: [],
    degradations: [],
    riskClass: "LOW",
    estimatedCost: { unit: "run", amount: 1 },
    planFingerprint: "d".repeat(64),
    ...overrides
  };
}

function uncoveredTask(): TaskNode {
  return task({ capabilityRefs: ["capability_channel_publish_xiaohongshu"] });
}

// ---------------------------------------------------------------------------
// F5 前半：约束⑥ 能力覆盖 + BLOCKED 员工不可引用（agent-workforce.md:254/:600）
// ---------------------------------------------------------------------------

describe("F5a · PlanSpec 引用校验（约束⑥）", () => {
  it("正例：全 COVERED + 被引用岗位裁决可上岗 → 通过", () => {
    const result = validatePlanSpecRefs(plan(), {
      dutyByRole: { content_editor: eligibleDecision() }
    });
    expect(result.ok, JSON.stringify(result.violations)).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missingRefs).toEqual([]);
    expect(result.blockedRoles).toEqual([]);
    expect(result.rolesChecked).toEqual(["content_editor"]);
    expect(result.rolesSkipped).toEqual([]);
    expect(result.inventoryFingerprint).toBe(INVENTORY_FINGERPRINT);
  });

  it("负例：引用未覆盖能力 + NEEDS_APPROVAL → 拒（:254 门控）", () => {
    const result = validatePlanSpecRefs(plan({ tasks: [uncoveredTask()] }));
    expect(result.ok).toBe(false);
    const violation = result.violations.find((item) => item.kind === "CAPABILITY_REF_NOT_COVERED");
    expect(violation?.taskId).toBe("task_generate");
    expect(violation?.capabilityRef).toBe("capability_channel_publish_xiaohongshu");
    expect(result.missingRefs).toEqual(["capability_channel_publish_xiaohongshu"]);
  });

  it("负例：引用未覆盖能力 + APPROVED → 拒（:254 门控）", () => {
    const result = validatePlanSpecRefs(plan({ status: "APPROVED", tasks: [uncoveredTask()] }));
    expect(result.ok).toBe(false);
    expect(result.violations.some((item) => item.kind === "CAPABILITY_REF_NOT_COVERED")).toBe(
      true
    );
  });

  it("门控语义：未覆盖 + DRAFT → 不拒，但 missingRefs 如实列出（:254 字面；:292 tier C 合法出 BLOCKED）", () => {
    const result = validatePlanSpecRefs(plan({ status: "DRAFT", tasks: [uncoveredTask()] }));
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.missingRefs).toEqual(["capability_channel_publish_xiaohongshu"]);
  });

  it("负例：引用 BLOCKED_BY_CAPABILITY 岗位 → 拒（:600）", () => {
    const blocked = blockedDecision();
    expect(blocked.verdict).toBe("BLOCKED_BY_CAPABILITY"); // 夹具自检
    const result = validatePlanSpecRefs(plan(), { dutyByRole: { content_editor: blocked } });
    expect(result.ok).toBe(false);
    const violation = result.violations.find(
      (item) => item.kind === "ASSIGNED_ROLE_BLOCKED_BY_CAPABILITY"
    );
    expect(violation?.taskId).toBe("task_generate");
    expect(violation?.role).toBe("content_editor");
    expect(result.blockedRoles).toEqual(["content_editor"]);
  });

  it("员工维度缺省：显式跳过（rolesSkipped），能力维度仍校验", () => {
    const skipped = validatePlanSpecRefs(plan());
    expect(skipped.ok).toBe(true);
    expect(skipped.rolesChecked).toEqual([]);
    expect(skipped.rolesSkipped).toEqual(["content_editor"]);

    const stillFails = validatePlanSpecRefs(
      plan({ tasks: [task({ capabilityRefs: ["capability_ratelimit_enforce"] })] })
    );
    expect(stillFails.ok).toBe(false);
  });

  it("负例：清单指纹不一致 → 拒（:213/:371 旧计划失效）", () => {
    const result = validatePlanSpecRefs(plan({ inventoryFingerprint: "c".repeat(64) }));
    expect(result.ok).toBe(false);
    expect(result.violations.some((item) => item.kind === "INVENTORY_FINGERPRINT_MISMATCH")).toBe(
      true
    );
  });

  it("确定性：同输入两次调用深等；inputFingerprint 稳定且为 sha256 形状", () => {
    const dutyByRole = { content_editor: eligibleDecision() };
    const first = validatePlanSpecRefs(plan(), { dutyByRole });
    const second = validatePlanSpecRefs(plan(), { dutyByRole });
    expect(second).toEqual(first);
    expect(first.inputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
