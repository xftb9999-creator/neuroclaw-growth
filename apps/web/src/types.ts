export type WorkspacePlan = "starter" | "growth";

export type RunStatus =
  | "draft"
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";

export type TemplateType = "content_acquisition" | "private_conversion" | "weekly_review";

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
  | { name: "templates" }
  | { name: "profile" }
  | { name: "history" }
  | { name: "memory" }
  | { name: "run-setup"; templateType: TemplateType }
  | { name: "run-status"; runId: string }
  | { name: "result"; runId: string };
