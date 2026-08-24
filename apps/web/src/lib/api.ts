export interface ApiErrorShape {
  message: string;
  code?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly status?: number
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({
      message: "Unknown request failure"
    }))) as ApiErrorShape;

    throw new ApiError(payload.message, payload.code, response.status);
  }

  return (await response.json()) as T;
}

export function createWorkspace(payload: { name: string; plan: "starter" | "growth" }) {
  return request("/api/workspaces", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listTemplates() {
  return request("/api/templates");
}

export function createRun(payload: {
  workspaceId: string;
  templateType: string;
  input: Record<string, unknown>;
}) {
  return request("/api/runs", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function getRun(runId: string) {
  return request(`/api/runs/${runId}`);
}

export function listRunHistory(workspaceId: string) {
  return request(`/api/workspaces/${workspaceId}/runs`);
}

export function cloneRun(runId: string) {
  return request(`/api/runs/${runId}/clone`, {
    method: "POST"
  });
}

export function listApprovals(runId: string) {
  return request(`/api/runs/${runId}/approvals`);
}

export function approveRun(
  runId: string,
  payload: { approved: boolean; reviewerId: string; note?: string }
) {
  return request(`/api/runs/${runId}/approval`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function listWorkspaceMemory(workspaceId: string) {
  return request(`/api/workspaces/${workspaceId}/memory`);
}

export function updateMemoryRecord(
  memoryId: string,
  payload: { summary?: string; isPinned?: boolean; isSuppressed?: boolean }
) {
  return request(`/api/memory/${memoryId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export function deleteMemoryRecord(memoryId: string) {
  return request(`/api/memory/${memoryId}`, {
    method: "DELETE"
  });
}

// ---------------------------------------------------------------------------
// Custom agents (J2) + MCP capability square
// ---------------------------------------------------------------------------

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  baseEngine: string;
  persona: string;
  description: string;
  outputStyle: string;
  status: string;
  createdAt: string;
}

export function listAgents() {
  return request("/api/agents");
}

export function createAgent(payload: {
  slug: string;
  name: string;
  baseEngine: string;
  persona: string;
  description?: string;
  focusAreas?: string[];
  outputStyle?: "structured" | "checklist" | "copy";
  toolNames?: string[];
}) {
  return request("/api/agents", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function updateAgentStatus(agentId: string, status: "active" | "inactive") {
  return request(`/api/agents/${agentId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

export function updateAgent(
  agentId: string,
  payload: {
    name?: string;
    persona?: string;
    description?: string;
    focusAreas?: string[];
    status?: "active" | "inactive";
  }
) {
  return request(`/api/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify(payload)
  });
}

export interface McpStatusResponse {
  available: boolean;
  servers: Array<{ name: string; connected: boolean; toolCount: number; lastError?: string }>;
  tools: Array<{ connection: string; name: string; description?: string }>;
}

export function fetchMcpStatus() {
  return request<McpStatusResponse>("/api/mcp/status");
}

// ---------------------------------------------------------------------------
// Artifacts library + Knowledge base (J3)
// ---------------------------------------------------------------------------

export interface ArtifactRecord {
  id: string;
  workspaceId: string;
  runId: string;
  agentType: string;
  kind: "note" | "copy" | "report" | "generic";
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export function listArtifacts(workspaceId: string) {
  return request(`/api/workspaces/${workspaceId}/artifacts`);
}

export function deleteArtifact(artifactId: string) {
  return request(`/api/artifacts/${artifactId}`, { method: "DELETE" });
}

export interface KnowledgeRecord {
  id: string;
  workspaceId: string;
  title: string;
  content: string;
  tags: string[];
  source: string;
  runId?: string;
  createdAt: string;
}

export function createKnowledgeEntry(payload: {
  workspaceId: string;
  title: string;
  content: string;
  tags?: string[];
}) {
  return request("/api/knowledge", { method: "POST", body: JSON.stringify(payload) });
}

export function listKnowledgeEntries(workspaceId: string) {
  return request(`/api/workspaces/${workspaceId}/knowledge`);
}

export function deleteKnowledgeEntry(entryId: string) {
  return request(`/api/knowledge/${entryId}`, { method: "DELETE" });
}

/** J8: 一行智能捕获 — LLM 自动结构化为 title/content/tags */
export function smartAddKnowledge(payload: { workspaceId: string; text: string }) {
  return request<{ id: string; title: string; tags: string[] }>("/api/knowledge/smart", {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function searchKnowledge(workspaceId: string, q?: string) {
  const query = q ? `&q=${encodeURIComponent(q)}` : "";
  return request(`/api/knowledge/search?workspaceId=${encodeURIComponent(workspaceId)}${query}`);
}

// ---------------------------------------------------------------------------
// Approval inbox + Schedules (J4)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  approvalId: string;
  actionType: string;
  reason: string;
  requestedAt: string;
  run: {
    id: string;
    workspaceId: string;
    templateType: string;
    status: string;
    businessSummary: string;
  };
}

export function listPendingApprovals(workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request(`/api/approvals/pending${query}`);
}

export interface ScheduleRecord {
  id: string;
  workspaceId: string;
  templateType: string;
  label: string;
  intervalMinutes: number;
  nextRunAt: string;
  lastRunId?: string;
  lastStatus?: string;
  status: string;
}

export function createSchedule(payload: {
  workspaceId: string;
  templateType: string;
  label: string;
  inputPayload: Record<string, unknown>;
  intervalMinutes: number;
}) {
  return request("/api/schedules", { method: "POST", body: JSON.stringify(payload) });
}

export function listSchedules(workspaceId?: string) {
  const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request(`/api/schedules${query}`);
}

export function deleteSchedule(scheduleId: string) {
  return request(`/api/schedules/${scheduleId}`, { method: "DELETE" });
}

// ---------------------------------------------------------------------------
// Team relay orchestration + LLM Planner (J5)
// ---------------------------------------------------------------------------

export interface TeamStepView {
  templateType: string;
  roleKey: string;
  feedFrom: string[];
  state: "done" | "running" | "waiting_approval" | "failed" | "pending";
  runId?: string;
  outputSummary?: string;
  startedAt?: string;
  completedAt?: string;
  durationSec?: number | null;
  outputFields?: Record<string, string>;
}

export interface TeamRunRecord {
  id: string;
  workspaceId: string;
  playbookKey: string;
  goal: string;
  audience: string;
  status: "running" | "waiting_approval" | "completed" | "failed";
  currentStep: number;
  steps: TeamStepView[];
  createdAt: string;
  updatedAt: string;
}

export interface TeamListItem {
  id: string;
  playbookKey: string;
  goal: string;
  status: string;
  currentStep: number;
  createdAt: string;
}

export function listTeams(workspaceId: string) {
  return request<TeamListItem[]>(`/api/teams?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function launchTeam(payload: {
  workspaceId: string;
  playbookKey: string;
  goal: string;
  audience?: string;
}) {
  return request("/api/teams/launch", { method: "POST", body: JSON.stringify(payload) });
}

export function getTeam(teamId: string) {
  return request<TeamRunRecord>(`/api/teams/${teamId}`);
}

export interface PlannerDecision {
  pickedType: string;
  reason: string;
  planner: "llm" | "rules";
}

export function pickPlanner(goal: string) {
  return request<PlannerDecision>("/api/planner/pick", {
    method: "POST",
    body: JSON.stringify({ goal })
  });
}

// ---------------------------------------------------------------------------
// Run analytics (J6)
// ---------------------------------------------------------------------------

export interface AnalyticsOverview {
  windowDays: number;
  series: Array<{ label: string; total: number; completed: number; failed: number }>;
  totals: { all: number; completed: number; failed: number; waiting: number };
  successRate: number | null;
  avgDurationSec: number | null;
  byAgent: Array<{ type: string; count: number }>;
}

export function getAnalyticsOverview(workspaceId: string, days = 14) {
  return request<AnalyticsOverview>(
    `/api/analytics/overview?workspaceId=${encodeURIComponent(workspaceId)}&days=${days}`
  );
}
