import type {
  AdapterActionType,
  PolicyDecision,
  Run,
  Template
} from "@neuroclaw/shared";

export interface PolicyContext {
  approvedActions?: AdapterActionType[];
}

export function evaluateRunPolicy(run: Run): PolicyDecision {
  const summary = String(run.input.businessSummary ?? "").toLowerCase();

  if (summary.includes("forbidden")) {
    return {
      decision: "deny",
      reason: "Business summary contains a blocked keyword",
      requiresApproval: false,
      riskLevel: "high"
    };
  }

  return {
    decision: "allow",
    reason: "Run passed round-2 preflight",
    requiresApproval: false,
    riskLevel: "low"
  };
}

export function evaluateActionPolicy(
  run: Run,
  template: Template,
  actionType: AdapterActionType,
  context: PolicyContext = {}
): PolicyDecision {
  const summary = String(run.input.businessSummary ?? "").toLowerCase();
  const approvedActions = context.approvedActions ?? [];

  if (summary.includes("forbidden")) {
    return {
      decision: "deny",
      reason: "The run contains a blocked keyword",
      requiresApproval: false,
      riskLevel: "high",
      appliesToAction: actionType
    };
  }

  if (
    actionType === "mcp_generate_brief" &&
    Array.isArray(run.input.preferredChannels) &&
    run.input.preferredChannels.length > 3
  ) {
    return {
      decision: "degrade",
      reason: "Too many channels for the content brief stub, using degraded mode",
      requiresApproval: false,
      riskLevel: "medium",
      appliesToAction: actionType
    };
  }

  const approvalRule = template.requiresApprovalRules.find(
    (rule: Template["requiresApprovalRules"][number]) => rule.actionType === actionType
  );

  if (approvalRule && !approvedActions.includes(actionType)) {
    return {
      decision: "require_approval",
      reason: approvalRule.reason,
      requiresApproval: true,
      riskLevel: "high",
      appliesToAction: actionType
    };
  }

  return {
    decision: "allow",
    reason: "Action allowed under round-2 policy",
    requiresApproval: false,
    riskLevel: "low",
    appliesToAction: actionType
  };
}
