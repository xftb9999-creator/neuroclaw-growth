/**
 * F5 前半 · PlanSpec 引用校验（约束⑥「能力覆盖」+「BLOCKED 员工不可被引用」）。
 *
 * 规格来源（`.artifacts/gm-report-20260922/agent-workforce.md`，E1 设计）：
 * - :233 TaskNode.capabilityRefs「必须全部 COVERED，否则该任务不得进入 DRAFT」；
 * - :254 结构硬约束 ⑥「每个 `task.capabilityRefs` 的每一项都必须在能力清单中解析为
 *   `COVERED` —— 否则 `PlanSpec.status` 不得为 `DRAFT` 以上」（本实现的正式口径）；
 * - :600「`BLOCKED_BY_CAPABILITY` 的员工不得被 PlanSpec 引用」（规划器 Step 4 校验 ③）；
 * - :281 可行域 = COVERED 的 capabilityRef 集合 + 可解析的 AgentRoleKey 集合；
 * - :213 / :371 `plan.inventoryFingerprint` 与规划所用清单一致；不匹配 ⇒ 旧计划须重新规划。
 *
 * 实现判读（E2；均不发明业务语义）：
 * 1. 覆盖门控按 :254 字面：仅当 `PlanSpec.status` ∈ {NEEDS_APPROVAL, APPROVED}（推进态，
 *    「DRAFT 以上」）且存在未覆盖引用时转为违规；DRAFT / REJECTED / BLOCKED / SUPERSEDED
 *    不拒——:292/:294 指出 tier C fail-closed 的合法产出即 `status=BLOCKED` + 缺能力回报，
 *    无条件拒会与该路径自相矛盾（:233 的门槛由规划期 Step 4 可行域保证，这里是事后兜底）。
 *    未覆盖明细无论是否触发违规都写入 `missingRefs`（供规划器修复/报告使用）。
 * 2. 「BLOCKED 员工」= `canAgentTakeDuty` 裁决 `verdict === "BLOCKED_BY_CAPABILITY"`
 *    （RG-3b 产物；本函数只消费裁决、不重复裁决逻辑，单一事实源）。NOT_ELIGIBLE
 *    （人工停用/无底座）不在 :600 字面内，未纳入；「首次上岗须 ACTIVE」（:531）依赖历史
 *    状态，属接线层，亦未纳入。
 * 3. `dutyByRole` 缺省或未提供某被引用岗位时，员工维度**显式跳过**（`rolesSkipped`
 *    记录，不静默假通过）；能力维度始终校验。
 * 4. 清单指纹不一致 ⇒ 违规（:371「必须重新规划」）：否则覆盖结论是对着错误的清单得出。
 *
 * 边界：纯函数、零 DB、零 I/O、零接线；不改 `planSpecSchema`（schema 无法携带清单/裁决
 * 上下文）；遵循 `duty-decision` / `executability-bridge` 非 barrel 先例，从本模块直接导出。
 */
import { createHash } from "node:crypto";

import {
  CAPABILITY_INVENTORY_V1,
  canonicalJson,
  capabilityInventoryFingerprint,
  capabilityInventorySchema,
  planSpecSchema,
  type AgentRoleKey,
  type CapabilityInventory,
  type PlanSpec,
  type PlanStatus
} from "./index.js";
import type { DutyDecision } from "./duty-decision.js";

/** 推进态（:254「DRAFT 以上」）：存在未覆盖引用时禁止出现的 status 集合。 */
const PLAN_STATUS_ABOVE_DRAFT: ReadonlySet<PlanStatus> = new Set(["NEEDS_APPROVAL", "APPROVED"]);

export type PlanRefViolationKind =
  | "CAPABILITY_REF_NOT_COVERED"
  | "ASSIGNED_ROLE_BLOCKED_BY_CAPABILITY"
  | "INVENTORY_FINGERPRINT_MISMATCH";

export interface PlanRefCheckViolation {
  kind: PlanRefViolationKind;
  /** task 级违规携带定位；清单指纹类违规为 plan 级（无 taskId）。 */
  taskId?: string;
  capabilityRef?: string;
  role?: AgentRoleKey;
  detail: string;
}

export interface PlanRefCheckOptions {
  /** 校验所用能力清单（默认 `CAPABILITY_INVENTORY_V1`）；须与 `plan.inventoryFingerprint` 一致。 */
  inventory?: CapabilityInventory;
  /** 被引用岗位的上岗裁决（RG-3b `canAgentTakeDuty` 产物）；缺省 = 员工维度跳过。 */
  dutyByRole?: Partial<Record<AgentRoleKey, DutyDecision>>;
}

export interface PlanRefCheckResult {
  ok: boolean;
  violations: PlanRefCheckViolation[];
  /** 未覆盖 capabilityRef（去重、排序；无论是否因 status 门控转为违规）。 */
  missingRefs: string[];
  /** 被引用且裁决为 BLOCKED_BY_CAPABILITY 的岗位（去重、排序）。 */
  blockedRoles: AgentRoleKey[];
  /** 本次实际做了裁决检查的被引用岗位（排序）。 */
  rolesChecked: AgentRoleKey[];
  /** 被引用但未提供裁决而显式跳过的岗位（排序）。 */
  rolesSkipped: AgentRoleKey[];
  /** 校验所用清单指纹（`capabilityInventoryFingerprint` 口径）。 */
  inventoryFingerprint: string;
  /** 输入指纹（plan + 清单指纹 + 被检查岗位裁决投影；canonical JSON + sha256）。 */
  inputFingerprint: string;
}

/**
 * PlanSpec 引用校验（确定性纯函数）：
 * - 覆盖：按 §7 同口径（清单 `AVAILABLE` ⇒ COVERED；MISSING / 不在清单 ⇒ 未覆盖）；
 * - 门控：存在未覆盖且 status ∈ {NEEDS_APPROVAL, APPROVED} ⇒ 逐条违规（:254）；
 * - 员工：被引用岗位裁决 BLOCKED_BY_CAPABILITY ⇒ 逐任务违规（:600）；
 * - 前提：`plan.inventoryFingerprint` 必须与校验清单一致（:371），否则追加违规。
 */
export function validatePlanSpecRefs(
  plan: PlanSpec,
  options: PlanRefCheckOptions = {}
): PlanRefCheckResult {
  const parsedPlan = planSpecSchema.parse(plan);
  const parsedInventory = capabilityInventorySchema.parse(
    options.inventory ?? CAPABILITY_INVENTORY_V1
  );
  const inventoryFingerprint = capabilityInventoryFingerprint(parsedInventory);

  const violations: PlanRefCheckViolation[] = [];

  // 前提（:213/:371）：plan 声明的清单身份必须与校验清单一致。
  if (parsedPlan.inventoryFingerprint !== inventoryFingerprint) {
    violations.push({
      kind: "INVENTORY_FINGERPRINT_MISMATCH",
      detail:
        "plan.inventoryFingerprint 与校验清单指纹不一致；清单变化后旧计划须重新规划（:371）"
    });
  }

  // 覆盖解析（§7 同口径，fail-closed：MISSING / NOT_IN_INVENTORY 均视为未覆盖）。
  const entryByRef = new Map(parsedInventory.entries.map((entry) => [entry.capabilityRef, entry]));
  const missingRefs = new Set<string>();
  const uncovered: Array<{ taskId: string; capabilityRef: string }> = [];
  for (const task of parsedPlan.tasks) {
    for (const capabilityRef of task.capabilityRefs) {
      const entry = entryByRef.get(capabilityRef);
      if (entry?.status !== "AVAILABLE") {
        missingRefs.add(capabilityRef);
        uncovered.push({ taskId: task.taskId, capabilityRef });
      }
    }
  }

  // 门控（:254）：未覆盖 ⇒ status 不得为 DRAFT 以上（推进态）。
  if (missingRefs.size > 0 && PLAN_STATUS_ABOVE_DRAFT.has(parsedPlan.status)) {
    for (const item of uncovered) {
      violations.push({
        kind: "CAPABILITY_REF_NOT_COVERED",
        taskId: item.taskId,
        capabilityRef: item.capabilityRef,
        detail: `task ${item.taskId} 引用未覆盖能力 ${item.capabilityRef}；plan.status=${parsedPlan.status} 高于 DRAFT（:254）`
      });
    }
  }

  // 员工维度（:600）：被引用岗位裁决 BLOCKED_BY_CAPABILITY ⇒ 拒；缺裁决显式跳过。
  const dutyByRole = options.dutyByRole ?? {};
  const rolesChecked = new Set<AgentRoleKey>();
  const rolesSkipped = new Set<AgentRoleKey>();
  const blockedRoles = new Set<AgentRoleKey>();
  for (const task of parsedPlan.tasks) {
    const decision = dutyByRole[task.assignedRole];
    if (!decision) {
      rolesSkipped.add(task.assignedRole);
      continue;
    }
    rolesChecked.add(task.assignedRole);
    if (decision.verdict === "BLOCKED_BY_CAPABILITY") {
      blockedRoles.add(task.assignedRole);
      violations.push({
        kind: "ASSIGNED_ROLE_BLOCKED_BY_CAPABILITY",
        taskId: task.taskId,
        role: task.assignedRole,
        detail: `task ${task.taskId} 引用 BLOCKED_BY_CAPABILITY 岗位 ${task.assignedRole}（:600）`
      });
    }
  }

  // 输入指纹（口径同 RG-3b DutyDecision.inputFingerprint：canonical JSON + sha256）。
  const dutyVerdictByRole = [...rolesChecked]
    .sort()
    .map((role) => [role, dutyByRole[role]?.verdict] as const);
  const inputFingerprint = createHash("sha256")
    .update(canonicalJson({ plan: parsedPlan, inventoryFingerprint, dutyVerdictByRole }))
    .digest("hex");

  return {
    ok: violations.length === 0,
    violations,
    missingRefs: [...missingRefs].sort(),
    blockedRoles: [...blockedRoles].sort(),
    rolesChecked: [...rolesChecked].sort(),
    rolesSkipped: [...rolesSkipped].sort(),
    inventoryFingerprint,
    inputFingerprint
  };
}
