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
