// Domain primitives now come from the single source of truth (Round J, audit
// P0-D2): the web app re-exports @neuroclaw/shared instead of hand-copying.
import type { ApprovalStatus, RunStatus, RunStepResult, TemplateType } from "@neuroclaw/shared";

export type { ApprovalStatus, RunStatus, RunStepResult, TemplateType };

export type WorkspacePlan = "starter" | "growth";

export interface TemplateRecord {
  id: string;
  type: TemplateType;
  name: string;
  version: string;
  status: string;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  actionType: string;
  reason: string;
  status: string;
}

export interface RunRecord {
  id: string;
  workspaceId: string;
  templateType: TemplateType;
  status: RunStatus;
  input: Record<string, unknown>;
  outputPayload?: Record<string, unknown>;
  outputSummary?: string;
  failureReason?: string;
  currentStep: string | null;
  approvalStatus: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  stepResults?: Array<{
    stepId: string;
    status: string;
    summary: string;
    actionType: string;
  }>;
}

export interface MemoryRecord {
  id: string;
  workspaceId: string;
  templateType: TemplateType;
  type: string;
  summary: string;
  sourceRunId: string;
  isPinned: boolean;
  isSuppressed: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ClonedRunPayload {
  templateType: TemplateType;
  input: Record<string, unknown>;
  sourceRunId: string;
}

export type Route =
  | { name: "onboarding" }
  | { name: "home" }
  | { name: "cockpit" }
  | { name: "templates" }
  | { name: "profile" }
  | { name: "launch"; query?: string }
  | { name: "agents" }
  | { name: "agent-new" }
  | { name: "workflows" }
  | { name: "library" }
  | { name: "knowledge" }
  | { name: "team" }
  | { name: "team-results"; teamId: string }
  | { name: "team-detail"; teamId: string }
  | { name: "inbox" }
  | { name: "schedule" }
  | { name: "analytics" }
  | { name: "billing" }
  | { name: "crews" }
  | { name: "history" }
  | { name: "memory" }
  | { name: "run-setup"; templateType: TemplateType }
  | { name: "result"; runId: string }
  | { name: "run-status"; runId: string };
