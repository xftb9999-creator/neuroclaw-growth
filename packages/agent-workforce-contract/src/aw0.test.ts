import { describe, expect, it } from "vitest";

import { workflowEdgeSchema } from "@neuroclaw/shared";

import {
  goalSpecFingerprint,
  goalSpecSchema,
  planSpecFingerprint,
  planSpecSchema,
  taskEdgeSchema,
  taskNodeSchema
} from "./index.js";
import type { AgentContractField, GoalSpec, PlanSpec, TaskNode } from "./index.js";

// ---------------------------------------------------------------------------
// AW-0 夹具：1 GoalSpec + 2 TaskNode DAG + 1 PlanSpec（来源 agent-workforce.md
// §2.2/§2.3 草案；字段值仅样例，不构成冻结数据）。
// ---------------------------------------------------------------------------

function f(name: string, type: AgentContractField["type"]): AgentContractField {
  return { name, type, required: true, description: `${name} field` };
}

function sampleGoal(): GoalSpec {
  return {
    goalId: "goal_1",
    goalVersion: "0.1.0",
    schemaVersion: "1.0",
    scope: { organizationId: "org_1", workspaceId: "ws_1", projectId: "proj_1" },
    title: "首月内容获取",
    objectiveKind: "growth",
    intent: "为首批线索产出内容草稿并安排审核",
    successCriteria: [
      {
        criterionId: "criterion_1",
        key: "draft_count",
        target: 12,
        unit: "篇",
        metricDefinitionRef: "metric_draft_count",
        evidenceLevelRequired: "E1",
        verifiability: "MEASURABLE"
      },
      {
        criterionId: "criterion_2",
        key: "conversion_rate",
        target: 0.05,
        unit: "ratio",
        evidenceLevelRequired: "E1",
        verifiability: "UNVERIFIED"
      }
    ],
    constraints: {
      budget: { unit: "run", limit: 100, windowDays: 30 },
      timeWindow: {},
      maxTasks: 8,
      maxAgents: 4,
      maxRiskClass: "MEDIUM"
    },
    compliance: {
      regimes: ["PIPL"],
      platformTosRefs: ["tos_wechat"],
      stopLineHits: []
    },
    channels: [{ channelKey: "wechat_group", accountStatus: "READY" }],
    installedInventoryFingerprint: "a".repeat(64),
    approvalMode: "human_in_the_loop",
    requestedOutcome: "draft",
    createdBy: "user_1",
    createdAt: "2026-09-27T00:00:00Z"
  };
}

function generateTask(): TaskNode {
  return {
    taskId: "task_generate",
    kind: "generate",
    title: "生成内容角度",
    capabilityRefs: ["cap_template_content_acquisition"],
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
    failurePolicy: "explicit_failure"
  };
}

function reviewTask(): TaskNode {
  return {
    taskId: "task_review",
    kind: "review",
    title: "合规审查",
    capabilityRefs: ["cap_template_compliance_review"],
    assignedRole: "compliance_reviewer",
    inputs: [{ fromTask: "task_generate", field: "contentAngles" }],
    outputs: [{ field: "complianceVerdict", contract: [f("complianceVerdict", "string")] }],
    acceptanceCriteria: [
      {
        criterionId: "ac_2",
        key: "verdict_present",
        target: 1,
        unit: "bool",
        evidenceLevelRequired: "E2"
      }
    ],
    riskClass: "MEDIUM",
    timeoutMs: 30000,
    approvalPoint: true,
    retryPolicy: { maxAttempts: 0 },
    failurePolicy: "escalate"
  };
}

function samplePlan(): PlanSpec {
  return {
    planId: "plan_1",
    planVersion: "0.1.0",
    schemaVersion: "1.0",
    goalSpecRef: { goalId: "goal_1", goalVersion: "0.1.0", goalFingerprint: "b".repeat(64) },
    plannerVersion: "rules-v1",
    plannerKind: "rules",
    status: "NEEDS_APPROVAL",
    tasks: [generateTask(), reviewTask()],
    edges: [{ from: "task_generate", to: "task_review" }],
    approvalPoints: ["task_review"],
    approvalPolicy: { mode: "manual" },
    inventoryFingerprint: "c".repeat(64),
    executabilityTier: "A",
    executabilityReportRef: "report_1",
    missingCapabilities: [],
    degradations: [],
    riskClass: "MEDIUM",
    estimatedCost: { unit: "run", amount: 2 },
    planFingerprint: "d".repeat(64)
  };
}

// ---------------------------------------------------------------------------
// GoalSpec
// ---------------------------------------------------------------------------

describe("AW-0 · GoalSpec", () => {
  it("正例通过；stopLineHits 非空为合法输入（规划侧转 BLOCKED，schema 不拒）", () => {
    const parsed = goalSpecSchema.safeParse(sampleGoal());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);

    const spec = sampleGoal();
    const blocked = { ...spec, compliance: { ...spec.compliance, stopLineHits: ["credentials"] } };
    expect(goalSpecSchema.safeParse(blocked).success).toBe(true);
  });

  it(".strict() 拒绝未知字段", () => {
    expect(goalSpecSchema.safeParse({ ...sampleGoal(), unknownField: 1 }).success).toBe(false);
  });

  it("缺必填 goalId 被拒", () => {
    const { goalId: _removed, ...rest } = sampleGoal();
    expect(goalSpecSchema.safeParse(rest).success).toBe(false);
  });

  it("approvalMode 不接受 none（G1 不可关闭）", () => {
    expect(goalSpecSchema.safeParse({ ...sampleGoal(), approvalMode: "none" }).success).toBe(false);
  });

  it("budget.limit 必须 > 0", () => {
    const spec = sampleGoal();
    spec.constraints.budget.limit = 0;
    expect(goalSpecSchema.safeParse(spec).success).toBe(false);
  });

  it("successCriteria 至少 1 条", () => {
    expect(goalSpecSchema.safeParse({ ...sampleGoal(), successCriteria: [] }).success).toBe(false);
  });

  it("MEASURABLE 判据必须带 metricDefinitionRef；UNVERIFIED 可无", () => {
    const measurableNoRef = {
      ...sampleGoal(),
      successCriteria: [
        {
          criterionId: "criterion_1",
          key: "draft_count",
          target: 12,
          unit: "篇",
          evidenceLevelRequired: "E1",
          verifiability: "MEASURABLE"
        }
      ]
    };
    expect(goalSpecSchema.safeParse(measurableNoRef).success).toBe(false);

    const unverifiedNoRef = {
      ...sampleGoal(),
      successCriteria: [
        {
          criterionId: "criterion_2",
          key: "conversion_rate",
          target: 0.05,
          unit: "ratio",
          evidenceLevelRequired: "E1",
          verifiability: "UNVERIFIED"
        }
      ]
    };
    expect(goalSpecSchema.safeParse(unverifiedNoRef).success).toBe(true);
  });

  it("goalSpecFingerprint 确定且随内容变化", () => {
    const first = goalSpecFingerprint(sampleGoal());
    expect(goalSpecFingerprint(sampleGoal())).toBe(first);
    expect(goalSpecFingerprint({ ...sampleGoal(), title: "另一目标" })).not.toBe(first);
  });
});

// ---------------------------------------------------------------------------
// TaskNode / TaskEdge
// ---------------------------------------------------------------------------

describe("AW-0 · TaskNode / TaskEdge", () => {
  it("TaskNode 正例通过（含交接输入 / 输出契约 / 验收判据）", () => {
    for (const task of [generateTask(), reviewTask()]) {
      const parsed = taskNodeSchema.safeParse(task);
      expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    }
  });

  it("TaskNode .strict() 拒绝未知字段", () => {
    expect(taskNodeSchema.safeParse({ ...generateTask(), unknownField: 1 }).success).toBe(false);
  });

  it("kind / assignedRole 枚举外被拒", () => {
    expect(taskNodeSchema.safeParse({ ...generateTask(), kind: "invalid" }).success).toBe(false);
    expect(taskNodeSchema.safeParse({ ...generateTask(), assignedRole: "cto" }).success).toBe(
      false
    );
  });

  it("timeoutMs 必须正整数；approvalPoint 必须布尔", () => {
    expect(taskNodeSchema.safeParse({ ...generateTask(), timeoutMs: 0 }).success).toBe(false);
    expect(taskNodeSchema.safeParse({ ...generateTask(), approvalPoint: "yes" }).success).toBe(
      false
    );
  });

  it("TaskEdge 直接复用 workflowEdgeSchema（零方言）", () => {
    expect(taskEdgeSchema).toBe(workflowEdgeSchema);
    expect(
      taskEdgeSchema.safeParse({
        from: "task_generate",
        to: "task_review",
        condition: "always",
        failureRoute: "task_review"
      }).success
    ).toBe(true);
    expect(taskEdgeSchema.safeParse({ from: "a", to: "b", unknownField: 1 }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PlanSpec（结构硬约束；能力覆盖校验属后续批）
// ---------------------------------------------------------------------------

describe("AW-0 · PlanSpec 结构硬约束", () => {
  it("正例通过（2 节点 DAG + 审批点 + 交接字段 + riskClass 取最大）", () => {
    const parsed = planSpecSchema.safeParse(samplePlan());
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it(".strict() 拒绝未知字段", () => {
    expect(planSpecSchema.safeParse({ ...samplePlan(), unknownField: 1 }).success).toBe(false);
  });

  it("tasks 非空", () => {
    const plan = structuredClone(samplePlan());
    plan.tasks = [];
    expect(planSpecSchema.safeParse(plan).success).toBe(false);
  });

  it("taskId 唯一", () => {
    const plan = structuredClone(samplePlan());
    plan.tasks = [generateTask(), generateTask()];
    expect(planSpecSchema.safeParse(plan).success).toBe(false);
  });

  it("含环 TaskDAG 被拒（复用 validateWorkflowGraph 的 Kahn 实现）", () => {
    const plan = structuredClone(samplePlan());
    plan.edges = [
      { from: "task_generate", to: "task_review" },
      { from: "task_review", to: "task_generate" }
    ];
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /acyclic/.test(issue.message))).toBe(true);
    }
  });

  it("edges 引用不存在的 taskId 被拒", () => {
    const plan = structuredClone(samplePlan());
    plan.edges = [{ from: "task_generate", to: "task_missing" }];
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /unknown node/.test(issue.message))).toBe(true);
    }
  });

  it("failureRoute 引用不存在被拒", () => {
    const plan = structuredClone(samplePlan());
    plan.edges = [
      { from: "task_generate", to: "task_review", failureRoute: "task_missing" }
    ];
    expect(planSpecSchema.safeParse(plan).success).toBe(false);
  });

  it("approvalPoints 引用不存在的 taskId 被拒", () => {
    const plan = structuredClone(samplePlan());
    plan.approvalPoints = ["task_missing"];
    expect(planSpecSchema.safeParse(plan).success).toBe(false);
  });

  it("task.approvalPoint 与 approvalPoints 集合必须一致", () => {
    const plan = structuredClone(samplePlan());
    plan.approvalPoints = [];
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /approval point/.test(issue.message))).toBe(true);
    }
  });

  it("approvalPoints 非空而 approvalPolicy 为空被拒", () => {
    const plan = structuredClone(samplePlan());
    plan.approvalPolicy = {};
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /approval policy/.test(issue.message))).toBe(
        true
      );
    }
  });

  it("riskClass 必须 ≥ 所有任务风险档最大值", () => {
    const plan = structuredClone(samplePlan());
    plan.riskClass = "LOW"; // reviewTask = MEDIUM
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /riskClass/.test(issue.message))).toBe(true);
    }
  });

  it("交接 fromTask 必须存在", () => {
    const plan = structuredClone(samplePlan());
    plan.tasks[1]!.inputs = [{ fromTask: "task_missing", field: "contentAngles" }];
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /fromTask/.test(issue.message))).toBe(true);
    }
  });

  it("交接 field 必须在上游 outputs 中声明", () => {
    const plan = structuredClone(samplePlan());
    plan.tasks[1]!.inputs = [{ fromTask: "task_generate", field: "notDeclared" }];
    const parsed = planSpecSchema.safeParse(plan);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => /notDeclared/.test(issue.message))).toBe(true);
    }
  });

  it("planSpecFingerprint 排除内嵌 planFingerprint 字段；内容变化即变", () => {
    const plan = samplePlan();
    const fingerprint = planSpecFingerprint(plan);
    expect(planSpecFingerprint({ ...plan, planFingerprint: fingerprint })).toBe(fingerprint);
    expect(planSpecFingerprint({ ...plan, status: "APPROVED" })).not.toBe(fingerprint);
  });
});
