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

/** Round L 撤回窗口:撤销排队中/待审批/执行中的运行。 */
export function cancelRun(runId: string) {
  return request(`/api/runs/${runId}/cancel`, { method: "POST" });
}

// ---------------------------------------------------------------------------
// Billing & north-star (Round K backend / Round L frontend)
// ---------------------------------------------------------------------------

export interface BillingSummary {
  plan: string;
  status: string;
  monthlyRunQuota: number;
  startedAt: string;
  renewsAt?: string;
  usage: {
    month: string;
    runsCreated: number;
    runsCompleted: number;
    tokensUsed: number;
    quotaRemaining: number | null;
  };
}

export function getBillingSummary(workspaceId: string) {
  return request<BillingSummary>(
    `/api/billing/summary?workspaceId=${encodeURIComponent(workspaceId)}`
  );
}

export function changePlan(workspaceId: string, plan: string) {
  return request<BillingSummary>("/api/billing/plan", {
    method: "POST",
    body: JSON.stringify({ workspaceId, plan })
  });
}

export interface NorthStarOverview {
  windowDays: number;
  scope: string;
  series: Array<Record<string, number | string>>;
  totals: Record<string, number>;
  activationRate: number | null;
  day7SuccessRate: number | null;
  workspacesCreatedInWindow: number;
}

export function getNorthStarOverview(workspaceId: string, days = 30) {
  return request<NorthStarOverview>(
    `/api/analytics/northstar?workspaceId=${encodeURIComponent(workspaceId)}&days=${days}`
  );
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
  return request<ArtifactRecord[]>(`/api/workspaces/${workspaceId}/artifacts`);
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
  return request<PendingApproval[]>(`/api/approvals/pending${query}`);
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
  status: "running" | "waiting_approval" | "paused" | "cancelled" | "completed" | "failed";
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
  // Round U: relay-run instances moved off /teams (now persistent Crew teams).
  return request<TeamListItem[]>(`/api/relay-runs?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function launchTeam(payload: {
  workspaceId: string;
  playbookKey: string;
  goal: string;
  audience?: string;
  crewTeamId?: string;
}) {
  return request("/api/relay-runs/launch", { method: "POST", body: JSON.stringify(payload) });
}

// ---------------------------------------------------------------------------
// P1 Crew — persistent teams (Round W UI)
// ---------------------------------------------------------------------------

export interface CrewMember {
  id: string;
  teamId: string;
  workspaceId: string;
  agentId: string;
  position: string;
  createdAt: string;
}

export interface CrewTeam {
  id: string;
  workspaceId: string;
  name: string;
  goal: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  members?: CrewMember[];
}

export function createCrewTeam(payload: { workspaceId: string; name: string; goal?: string }) {
  return request<CrewTeam>("/api/teams", { method: "POST", body: JSON.stringify(payload) });
}

export function listCrewTeams(workspaceId: string) {
  return request<CrewTeam[]>(`/api/teams?workspaceId=${encodeURIComponent(workspaceId)}`);
}

export function getCrewTeamDetail(teamId: string) {
  return request<CrewTeam>(`/api/teams/${teamId}`);
}

export function updateCrewTeamStatus(teamId: string, status: string) {
  return request<{ ok: boolean }>(`/api/teams/${teamId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ teamId, status })
  });
}

export function addCrewMember(teamId: string, payload: { agentId: string; position: string }) {
  return request<{ id: string }>(`/api/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export function removeCrewMember(teamId: string, memberId: string) {
  return request<{ ok: boolean }>(`/api/teams/${teamId}/members/${memberId}`, { method: "DELETE" });
}
export function getTeam(teamId: string) {
  return request<TeamRunRecord>(`/api/relay-runs/${teamId}`);
}

/** Round V: relay-level control — pause / resume / cancel (cascade). */
export function updateRelayRunStatus(relayId: string, status: "running" | "paused" | "cancelled") {
  return request<TeamRunRecord>(`/api/relay-runs/${relayId}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status })
  });
}

export interface TeamMemoryResponse {
  team: { id: string; name: string; status: string };
  memories: Array<{
    id: string;
    summary: string;
    templateType: string;
    sourceRunId: string;
    isPinned: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
}

export function getTeamMemory(teamId: string) {
  return request<TeamMemoryResponse>(`/api/teams/${teamId}/memory`);
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

// ---------------------------------------------------------------------------
// Industry benchmarks (R2-D, Round Y/AA — deliverable 62)
// ---------------------------------------------------------------------------

export interface BenchmarkEntry {
  industry: string;
  templateType: string;
  totalRuns: number;
  completedRuns: number;
  successRate: number | null;
  p50DurationSec: number | null;
  p90DurationSec: number | null;
  sampleSize: number;
  period: string;
}

export function getBenchmarks(industry: string) {
  return request<BenchmarkEntry[]>(`/api/benchmarks/${encodeURIComponent(industry)}`);
}

export function getWorkspaceIndustry(workspaceId: string) {
  return request<{ industry: string | null }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/industry`
  );
}

export function setWorkspaceIndustry(workspaceId: string, industry: string) {
  return request<{ ok: boolean }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/industry`,
    { method: "PATCH", body: JSON.stringify({ industry }) }
  );
}
