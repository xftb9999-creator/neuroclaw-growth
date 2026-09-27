import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";
import { validator } from "hono/validator";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";

import {
  streamGenerate,
  isAiAvailable,
  pickAgentWithLLM,
  pickAgentWithRules
} from "@neuroclaw/agent-core";
import {
  approvalDecisionSchema,
  createAgentInputSchema,
  agentStatusSchema,
  createRunInputSchema,
  createWorkspaceInputSchema,
  crewPositionSchema,
  crewTeamStatusSchema,
  hasPermission,
  savePlaybookInputSchema,
  simulationProjectIntegrationConfigSchema,
  templateTypeSchema,
  templateInputPayloadSchema,
  updateAgentInputSchema,
  updateMemoryInputSchema,
  workspacePlanSchema,
  rebuildRunFromEvents,
  type OutboxTransport,
  type Run
} from "@neuroclaw/shared";
import { isMcpAvailable, getMcpRegistry } from "@neuroclaw/tooling-mcp";
import { artifacts, knowledgeEntries, memoryRecords, MIGRATIONS } from "@neuroclaw/db";
import {
  ControlPlaneService,
  NotFoundError,
  QuotaExceededError,
  RegistryConflictError
} from "./index.js";
import { requireAuth, requirePermission } from "./middleware/auth.js";
import { createAuditMiddleware } from "./middleware/audit.js";
import {
  OutboxDeliveryStore,
  OutboxDispatcher,
  resolveOutboxDispatchConfig,
  type OutboxDispatchBatchResult
} from "./outbox-dispatcher.js";

export type AppEnv = {
  Variables: {
    authUserId: string;
    authRole: "admin" | "operator" | "viewer";
  };
};

// ---------------------------------------------------------------------------
// Workspace membership ACL (Round J, audit P0-C4)
// ---------------------------------------------------------------------------

type Context = Parameters<Parameters<Hono<AppEnv>["onError"]>[0]>[1];

/** 403 when the authenticated user has no access to the workspace. */
async function ensureWorkspaceAccess(
  service: ControlPlaneService,
  c: Context,
  workspaceId: string | undefined | null
): Promise<Response | null> {
  if (!workspaceId) return null;
  const allowed = await service.isWorkspaceMember(workspaceId, c.get("authUserId"));
  if (allowed) return null;
  return c.json(
    { message: "You do not have access to this workspace", code: "WORKSPACE_FORBIDDEN" },
    403
  );
}

/** Resolve the owning workspace of an ID-addressed resource and enforce ACL. */
async function ensureResourceAccess(
  service: ControlPlaneService,
  c: Context,
  kind: "artifact" | "knowledge" | "memory",
  resourceId: string
): Promise<Response | null> {
  let workspaceId: string | null = null;
  if (kind === "artifact") {
    const rows = await service.db.select().from(artifacts).where(eq(artifacts.id, resourceId));
    workspaceId = rows[0]?.workspaceId ?? null;
  } else if (kind === "knowledge") {
    const rows = await service.db.select().from(knowledgeEntries).where(eq(knowledgeEntries.id, resourceId));
    workspaceId = rows[0]?.workspaceId ?? null;
  } else {
    const rows = await service.db.select().from(memoryRecords).where(eq(memoryRecords.id, resourceId));
    workspaceId = rows[0]?.workspaceId ?? null;
  }
  return ensureWorkspaceAccess(service, c, workspaceId);
}

function zodValidator<T extends ReturnType<typeof import("zod").z.object>>(
  target: "json" | "param" | "query",
  schema: T
) {
  return validator(target, (value, c) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      return c.json(
        {
          message: "Validation failed",
          code: "VALIDATION_ERROR",
          issues: result.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        },
        422
      );
    }
    return result.data as ReturnType<T["parse"]>;
  });
}

const READINESS_TABLES = ["workspaces", "runs", "jobs"] as const;

export interface ReadinessHooks {
  /** Runtime-owned signal for components that live outside the database. */
  execution?: () => boolean;
}

/**
 * W2 §2.3 dead-letter replay seam. The server passes the same injected
 * transport that arms the dispatch driver; with no transport the replay is
 * still recorded and the response reports `dispatch: null` (this slice
 * authorizes no real network transport).
 */
export interface OutboxRouteSeam {
  /** Transport for the replay route's immediate delivery attempt. */
  transport?: OutboxTransport;
  /** Injectable clock for tests; defaults to the wall clock. */
  now?: () => Date;
}

/**
 * Readiness is deliberately stricter than liveness: a process can be alive
 * while its database is unavailable or migrations are incomplete. Keep the
 * response generic on failure so database/provider details do not leak.
 */
async function checkReadiness(
  service: ControlPlaneService,
  hooks: ReadinessHooks = {}
): Promise<{
  ok: boolean;
  checks: Record<string, "ok" | "failed">;
}> {
  const checks: Record<string, "ok" | "failed"> = {
    database: "failed",
    migrations: "failed",
    coreTables: "failed"
  };
  if (hooks.execution) checks.execution = "failed";

  try {
    await service.db.execute(sql`SELECT 1`);
    checks.database = "ok";

    const latestMigration = MIGRATIONS[MIGRATIONS.length - 1]?.id;
    if (!latestMigration) return { ok: false, checks };

    const migrationResult = (await service.db.execute(
      sql`SELECT id FROM schema_migrations WHERE id = ${latestMigration} LIMIT 1`
    )) as unknown as { rows?: unknown[] };
    if (!migrationResult.rows?.length) return { ok: false, checks };
    checks.migrations = "ok";

    for (const table of READINESS_TABLES) {
      await service.db.execute(sql`SELECT 1 FROM ${sql.identifier(table)} LIMIT 1`);
    }
    checks.coreTables = "ok";
    if (hooks.execution && !hooks.execution()) return { ok: false, checks };
    if (hooks.execution) checks.execution = "ok";
    return { ok: true, checks };
  } catch {
    return { ok: false, checks };
  }
}

export function createApp(
  service: ControlPlaneService,
  staticDir?: string,
  readinessHooks: ReadinessHooks = {},
  outboxSeam: OutboxRouteSeam = {}
) {
  const app = new Hono<AppEnv>();

  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use("*", timeout(30_000));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ready", async (c) => {
    const readiness = await checkReadiness(service, readinessHooks);
    if (!readiness.ok) {
      return c.json(
        { ok: false, service: "control-plane", checks: readiness.checks, code: "NOT_READY" },
        503
      );
    }
    return c.json({ ok: true, service: "control-plane", checks: readiness.checks });
  });

  const api = new Hono<AppEnv>();
  api.use("*", requireAuth());
  api.use("*", createAuditMiddleware(service.db));

  api.post(
    "/workspaces",
    requirePermission("workspace:create"),
    zodValidator("json", createWorkspaceInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      // Seed the authenticated caller as workspace admin (multi-tenant ACL).
      const workspace = await service.createWorkspace(input, c.get("authUserId"));
      return c.json(workspace, 201);
    }
  );

  api.get("/templates", requirePermission("template:read"), (c) => {
    return c.json(service.listTemplates());
  });

  // -----------------------------------------------------------------------
  // Custom agents (J2) + MCP capability square
  // -----------------------------------------------------------------------

  api.post(
    "/agents",
    requirePermission("agent:create"),
    zodValidator("json", createAgentInputSchema),
    async (c) => {
      try {
        const agent = await service.createAgent(c.req.valid("json"));
        return c.json(agent, 201);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/agents", requirePermission("template:read"), async (c) => {
    return c.json(await service.listAgents());
  });

  api.patch(
    "/agents/:agentId/status",
    requirePermission("agent:create"),
    zodValidator("json", z.object({ status: agentStatusSchema })),
    async (c) => {
      try {
        await service.updateAgentStatus(c.req.param("agentId"), c.req.valid("json").status);
        return c.json({ ok: true });
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  // J7: full agent editing
  api.patch(
    "/agents/:agentId",
    requirePermission("agent:create"),
    zodValidator("json", updateAgentInputSchema),
    async (c) => {
      try {
        await service.updateAgent(c.req.param("agentId"), c.req.valid("json"));
        return c.json({ ok: true });
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/knowledge/search", requirePermission("memory:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ message: "workspaceId is required" }, 400);
    const denied = await ensureWorkspaceAccess(service, c, workspaceId);
    if (denied) return denied;
    return c.json(await service.searchKnowledge(workspaceId, c.req.query("q")));
  });

  const refineSchema = z.object({ workspaceId: z.string().min(1) });
  api.post(
    "/knowledge/ai-refine",
    requirePermission("memory:write"),
    zodValidator("json", refineSchema),
    async (c) => {
      try {
        const denied = await ensureWorkspaceAccess(service, c, c.req.valid("json").workspaceId);
        if (denied) return denied;
        return c.json(await service.refineKnowledgeWithAI(c.req.valid("json").workspaceId));
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  // J8: one-line smart capture
  const smartCaptureSchema = z.object({
    workspaceId: z.string().min(1),
    text: z.string().min(2)
  });
  api.post(
    "/knowledge/smart",
    requirePermission("memory:write"),
    zodValidator("json", smartCaptureSchema),
    async (c) => {
      try {
        const { workspaceId, text } = c.req.valid("json");
        const denied = await ensureWorkspaceAccess(service, c, workspaceId);
        if (denied) return denied;
        return c.json(await service.smartAddKnowledge(workspaceId, text), 201);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  // J7: playbooks — editable workflows
  api.get("/playbooks", requirePermission("template:read"), async (c) => {
    return c.json(await service.getPlaybooks());
  });

  api.put(
    "/playbooks/:key",
    requirePermission("agent:create"),
    zodValidator("json", savePlaybookInputSchema),
    async (c) => {
      try {
        await service.savePlaybook(c.req.param("key"), c.req.valid("json"));
        return c.json({ ok: true });
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/mcp/status", requirePermission("template:read"), (c) => {
    const available = isMcpAvailable();
    if (!available) {
      return c.json({ available: false, servers: [], tools: [] });
    }
    const registry = getMcpRegistry();
    return c.json({
      available: true,
      servers: registry.getStatuses(),
      tools: registry.listAllTools().map(({ connection, tool }) => ({
        connection,
        name: tool.name,
        description: tool.description
      }))
    });
  });

  // -----------------------------------------------------------------------
  // Artifacts library + Knowledge base (J3)
  // -----------------------------------------------------------------------

  api.get(
    "/workspaces/:workspaceId/artifacts",
    requirePermission("run:read"),
    async (c) => {
      try {
        const denied = await ensureWorkspaceAccess(service, c, c.req.param("workspaceId"));
        if (denied) return denied;
        return c.json(await service.listArtifacts(c.req.param("workspaceId")));
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.delete("/artifacts/:artifactId", requirePermission("memory:delete"), async (c) => {
    const denied = await ensureResourceAccess(service, c, "artifact", c.req.param("artifactId"));
    if (denied) return denied;
    await service.deleteArtifact(c.req.param("artifactId"));
    return c.json({ ok: true });
  });

  const knowledgeInputSchema = z.object({
    workspaceId: z.string().min(1),
    title: z.string().min(1),
    content: z.string().min(1),
    tags: z.array(z.string()).optional()
  });

  api.post(
    "/knowledge",
    requirePermission("memory:write"),
    zodValidator("json", knowledgeInputSchema),
    async (c) => {
      const denied = await ensureWorkspaceAccess(service, c, c.req.valid("json").workspaceId);
      if (denied) return denied;
      return c.json(await service.createKnowledgeEntry(c.req.valid("json")), 201);
    }
  );

  api.get(
    "/workspaces/:workspaceId/knowledge",
    requirePermission("memory:read"),
    async (c) => {
      const denied = await ensureWorkspaceAccess(service, c, c.req.param("workspaceId"));
      if (denied) return denied;
      return c.json(await service.listKnowledgeEntries(c.req.param("workspaceId")));
    }
  );

  api.delete("/knowledge/:entryId", requirePermission("memory:delete"), async (c) => {
    const denied = await ensureResourceAccess(service, c, "knowledge", c.req.param("entryId"));
    if (denied) return denied;
    await service.deleteKnowledgeEntry(c.req.param("entryId"));
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Approval inbox + Schedules (J4)
  // -----------------------------------------------------------------------

  api.get("/approvals/pending", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    const denied = await ensureWorkspaceAccess(service, c, workspaceId);
    if (denied) return denied;
    return c.json(await service.listPendingApprovals(workspaceId));
  });

  const scheduleInputSchema = z.object({
    workspaceId: z.string().min(1),
    templateType: templateTypeSchema,
    label: z.string().min(1),
    inputPayload: templateInputPayloadSchema,
    intervalMinutes: z.number().int().min(5)
  });

  api.post(
    "/schedules",
    requirePermission("run:create"),
    zodValidator("json", scheduleInputSchema),
    async (c) => {
      const denied = await ensureWorkspaceAccess(service, c, c.req.valid("json").workspaceId);
      if (denied) return denied;
      return c.json(await service.createSchedule(c.req.valid("json")), 201);
    }
  );

  api.get("/schedules", requirePermission("run:read"), async (c) => {
    const denied = await ensureWorkspaceAccess(service, c, c.req.query("workspaceId"));
    if (denied) return denied;
    return c.json(await service.listSchedules(c.req.query("workspaceId")));
  });

  api.delete("/schedules/:scheduleId", requirePermission("run:create"), async (c) => {
    await service.deleteSchedule(c.req.param("scheduleId"));
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Team relay orchestration (J5)
  // -----------------------------------------------------------------------

  const teamLaunchSchema = z.object({
    workspaceId: z.string().min(1),
    playbookKey: z.string().min(1),
    goal: z.string().min(1),
    audience: z.string().optional(),
    // P1 Crew (Round W): link the relay to a persistent crew team.
    crewTeamId: z.string().optional()
  });

  // -----------------------------------------------------------------------
  // P1 Crew — persistent teams (Round U, deliverable 60)
  // -----------------------------------------------------------------------

  const crewTeamInputSchema = z.object({
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    goal: z.string().optional()
  });

  api.post(
    "/teams",
    requirePermission("workspace:create"),
    zodValidator("json", crewTeamInputSchema),
    async (c) => {
      const { workspaceId, ...rest } = c.req.valid("json");
      const denied = await ensureWorkspaceAccess(service, c, workspaceId);
      if (denied) return denied;
      const team = await service.createCrewTeam(workspaceId, rest, c.get("authUserId"));
      return c.json(team, 201);
    }
  );

  api.get("/teams", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ message: "workspaceId is required" }, 400);
    const denied = await ensureWorkspaceAccess(service, c, workspaceId);
    if (denied) return denied;
    return c.json(await service.listCrewTeams(workspaceId));
  });

  api.get("/teams/:teamId", requirePermission("run:read"), async (c) => {
    try {
      const team = await service.getCrewTeam(c.req.param("teamId"));
      const workspaceId = (team as { workspaceId: string }).workspaceId;
      const denied = await ensureWorkspaceAccess(service, c, workspaceId);
      if (denied) return denied;
      return c.json(team);
    } catch (error) {
      return handleError(error, c);
    }
  });

  const crewStatusSchema = z.object({
    teamId: z.string().min(1),
    status: crewTeamStatusSchema
  });
  api.patch(
    "/teams/:teamId/status",
    requirePermission("workspace:create"),
    zodValidator("json", crewStatusSchema),
    async (c) => {
      try {
        const teamId = c.req.param("teamId");
        const team = await service.getCrewTeam(teamId);
        const denied = await ensureWorkspaceAccess(service, c, (team as { workspaceId: string }).workspaceId);
        if (denied) return denied;
        await service.setCrewTeamStatus(teamId, c.req.valid("json").status);
        return c.json({ ok: true });
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  const crewMemberInputSchema = z.object({
    agentId: z.string().min(1),
    position: crewPositionSchema
  });
  api.post(
    "/teams/:teamId/members",
    requirePermission("agent:create"),
    zodValidator("json", crewMemberInputSchema),
    async (c) => {
      try {
        const teamId = c.req.param("teamId");
        const team = await service.getCrewTeam(teamId);
        const denied = await ensureWorkspaceAccess(service, c, (team as { workspaceId: string }).workspaceId);
        if (denied) return denied;
        const member = await service.addCrewMember(
          teamId,
          c.req.valid("json").agentId,
          c.req.valid("json").position
        );
        return c.json(member, 201);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.delete("/teams/:teamId/members/:memberId", requirePermission("agent:create"), async (c) => {
    try {
      const teamId = c.req.param("teamId");
      const team = await service.getCrewTeam(teamId);
      const denied = await ensureWorkspaceAccess(service, c, (team as { workspaceId: string }).workspaceId);
      if (denied) return denied;
      await service.removeCrewMember(teamId, c.req.param("memberId"));
      return c.json({ ok: true });
    } catch (error) {
      return handleError(error, c);
    }
  });

  // R2-D — industry benchmarks (Round Y, deliverable 62)
  const benchmarkSchema = z.object({ industry: z.string().min(1) });
  api.post("/benchmarks/compute", requirePermission("workspace:create"), zodValidator("json", benchmarkSchema), async (c) => {
    try {
      const count = await service.computeIndustryBenchmarks();
      return c.json({ computed: count });
    } catch (error) {
      return handleError(error, c);
    }
  });

  api.get("/benchmarks/:industry", requirePermission("run:read"), async (c) => {
    return c.json(await service.getIndustryBenchmarks(c.req.param("industry")));
  });

  // R2-D v1 (Round AA) — workspace industry read/write for the benchmark card.
  api.get("/workspaces/:workspaceId/industry", requirePermission("run:read"), async (c) => {
    try {
      const workspaceId = c.req.param("workspaceId");
      const denied = await ensureWorkspaceAccess(service, c, workspaceId);
      if (denied) return denied;
      return c.json({ industry: await service.getWorkspaceIndustry(workspaceId) });
    } catch (error) {
      return handleError(error, c);
    }
  });

  const workspaceIndustrySchema = z.object({ industry: z.string() });
  api.patch(
    "/workspaces/:workspaceId/industry",
    requirePermission("workspace:create"),
    zodValidator("json", workspaceIndustrySchema),
    async (c) => {
      try {
        const workspaceId = c.req.param("workspaceId");
        const denied = await ensureWorkspaceAccess(service, c, workspaceId);
        if (denied) return denied;
        await service.setWorkspaceIndustry(workspaceId, c.req.valid("json").industry);
        return c.json({ ok: true });
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  // -----------------------------------------------------------------------
  // Team relay orchestration (J5) — renamed to /relay-runs in Round U so that
  // /teams belongs to persistent Crew teams.
  // -----------------------------------------------------------------------

  api.post(
    "/relay-runs/launch",
    requirePermission("run:create"),
    zodValidator("json", teamLaunchSchema),
    async (c) => {
      try {
        const denied = await ensureWorkspaceAccess(service, c, c.req.valid("json").workspaceId);
        if (denied) return denied;
        return c.json(await service.launchTeam(c.req.valid("json")), 201);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/relay-runs", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ message: "workspaceId is required" }, 400);
    }
    const denied = await ensureWorkspaceAccess(service, c, workspaceId);
    if (denied) return denied;
    return c.json(await service.listTeams(workspaceId));
  });

  api.get("/relay-runs/:teamId", requirePermission("run:read"), async (c) => {
    try {
      const team = await service.getTeam(c.req.param("teamId"));
      const denied = await ensureWorkspaceAccess(service, c, team.workspaceId);
      if (denied) return denied;
      return c.json(team);
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Relay-level control (Round V): pause / resume / cancel with cascade.
  const relayStatusSchema = z.object({
    status: z.enum(["running", "paused", "cancelled"])
  });
  api.patch("/relay-runs/:relayId/status", requirePermission("run:create"), async (c) => {
    try {
      const relayId = c.req.param("relayId");
      const body = (await c.req.json()) as { status?: string };
      const parsed = relayStatusSchema.safeParse(body);
      if (!parsed.success) {
        return c.json({ message: "Invalid status", code: "VALIDATION_ERROR" }, 422);
      }
      const relay = await service.getTeam(relayId);
      const denied = await ensureWorkspaceAccess(service, c, relay.workspaceId);
      if (denied) return denied;
      return c.json(await service.updateRelayRunStatus(relayId, parsed.data.status));
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Team-visible memory aggregation (Round V).
  api.get("/teams/:teamId/memory", requirePermission("memory:read"), async (c) => {
    try {
      const teamId = c.req.param("teamId");
      const team = await service.getCrewTeam(teamId);
      const workspaceId = (team as { workspaceId: string }).workspaceId;
      const denied = await ensureWorkspaceAccess(service, c, workspaceId);
      if (denied) return denied;
      return c.json(await service.getTeamMemory(teamId));
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Run analytics (J6)
  api.get("/analytics/overview", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ message: "workspaceId is required" }, 400);
    }
    const days = Number(c.req.query("days") ?? 14);
    try {
      const denied = await ensureWorkspaceAccess(service, c, workspaceId);
      if (denied) return denied;
      return c.json(await service.getAnalyticsOverview(workspaceId, Math.min(60, Math.max(7, days))));
    } catch (error) {
      return handleError(error, c);
    }
  });

  // North-star funnel metrics (Round K, audit P1-07). Global scope is
  // admin-only; workspace scope is available to members.
  api.get("/analytics/northstar", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    const days = Number(c.req.query("days") ?? 30);
    try {
      if (workspaceId) {
        const denied = await ensureWorkspaceAccess(service, c, workspaceId);
        if (denied) return denied;
      } else if (!hasPermission(c.get("authRole"), "workspace:create")) {
        return c.json(
          { message: "Global north-star view requires an admin role", code: "AUTH_FORBIDDEN" },
          403
        );
      }
      return c.json(await service.getNorthStarOverview({ workspaceId, days }));
    } catch (error) {
      return handleError(error, c);
    }
  });

  // -----------------------------------------------------------------------
  // Billing — subscription summary + plan change (Round K, audit P0-B3)
  // -----------------------------------------------------------------------

  api.get("/billing/summary", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) return c.json({ message: "workspaceId is required" }, 400);
    const denied = await ensureWorkspaceAccess(service, c, workspaceId);
    if (denied) return denied;
    return c.json(await service.getBillingSummary(workspaceId));
  });

  const changePlanSchema = z.object({
    workspaceId: z.string().min(1),
    plan: workspacePlanSchema
  });
  api.post(
    "/billing/plan",
    requirePermission("workspace:create"),
    zodValidator("json", changePlanSchema),
    async (c) => {
      try {
        const { workspaceId, plan } = c.req.valid("json");
        const denied = await ensureWorkspaceAccess(service, c, workspaceId);
        if (denied) return denied;
        await service.changePlan(workspaceId, plan);
        return c.json(await service.getBillingSummary(workspaceId));
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  // LLM Planner — route a goal to the best-fit agent (J5-B)
  const plannerSchema = z.object({ goal: z.string().min(1) });

  api.post(
    "/planner/pick",
    requirePermission("run:create"),
    zodValidator("json", plannerSchema),
    async (c) => {
      const { goal } = c.req.valid("json");
      const catalog = service.registry
        .list()
        .filter((template) => template.status !== "inactive")
        .map((template) => ({
          type: template.type,
          name: template.name,
          description: template.description ?? ""
        }));

      const llm = await pickAgentWithLLM(catalog, goal);
      if (llm) return c.json(llm);

      const rules = pickAgentWithRules(catalog, goal);
      if (rules) return c.json(rules);

      return c.json({ pickedType: "content_acquisition", reason: "default", planner: "rules" });
    }
  );

  api.post(
    "/runs",
    requirePermission("run:create"),
    zodValidator("json", createRunInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const denied = await ensureWorkspaceAccess(service, c, input.workspaceId);
      if (denied) return denied;
      const run = await service.createRun(input);
      // 202 Accepted in durable mode: execution continues in the background
      // job loop; the client polls GET /runs/:id for progress.
      return c.json(run, service.durable ? 202 : 201);
    }
  );

  api.get("/runs/:runId", requirePermission("run:read"), async (c) => {
    try {
      const run = await service.getRun(c.req.param("runId"));
      const denied = await ensureWorkspaceAccess(service, c, run.workspaceId);
      if (denied) return denied;
      return c.json(run);
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Live run stream (Round P, audit P1-2 → W1b): `run_events` is the read
  // source. Load the full history, then tail `sequence > cursor` and project
  // each new batch through `rebuildRunFromEvents`; every `run` frame carries
  // the SSE `id` = cursor so `Last-Event-ID` resumes the tail after a
  // reconnect. Terminal paths that append no event (cancelRun, permanent job
  // failure) are caught by a row fallback read — no vocabulary extension.
  // EventSource cannot send Authorization headers — this endpoint is for the
  // same-origin web app (dev-mode auth now; session cookie at R2-B RBAC).
  api.get("/runs/:runId/events", requirePermission("run:read"), async (c) => {
    try {
      const runId = c.req.param("runId");
      const targetRun = await service.getRun(runId);
      const denied = await ensureWorkspaceAccess(service, c, targetRun.workspaceId);
      if (denied) return denied;

      const terminal = new Set(["completed", "failed", "cancelled"]);
      // Resume cursor: EventSource reconnects send the last seen frame id.
      const resumeHeader = c.req.header("last-event-id");
      let cursor =
        resumeHeader !== undefined && /^\d+$/.test(resumeHeader)
          ? Number(resumeHeader)
          : 0;
      let ticks = 0;
      let history = await service.listRunEventHistory(runId);

      return streamSSE(c, async (stream) => {
        // Immediate byte flush probe/comment — some adapters buffer until
        // first payload arrives.
        await stream.writeSSE({ event: "open", data: "ok" });

        const emitRun = async (frame: Run) => {
          await stream.writeSSE({
            event: "run",
            data: JSON.stringify(frame),
            id: String(cursor)
          });
        };

        // A cursor beyond the log (foreign or rotated id) restarts from the
        // full history instead of silently streaming nothing.
        const maxSequence = history.length > 0 ? history[history.length - 1].sequence : 0;
        if (cursor > maxSequence) cursor = 0;

        if (history.length === 0) {
          // Nothing appended yet (queued run, or a terminal path that writes
          // no event): the mutable row is the only available state.
          const row = await service.getRun(runId);
          await emitRun(row);
          if (terminal.has(row.status)) return;
        } else if (cursor === 0 || maxSequence > cursor) {
          cursor = maxSequence;
          const projected = rebuildRunFromEvents(history);
          await emitRun(projected);
          if (terminal.has(projected.status)) return;
        }

        while (ticks < 900) {
          ticks += 1;
          const tail = await service.listRunEventsAfter(runId, cursor);
          if (tail.length > 0) {
            history = [...history, ...tail];
            cursor = history[history.length - 1].sequence;
            const projected = rebuildRunFromEvents(history);
            await emitRun(projected);
            if (terminal.has(projected.status)) return;
          } else {
            // Row fallback: closes terminal states the log never records
            // (cancelRun / permanent job failure append no event).
            const row = await service.getRun(runId);
            if (terminal.has(row.status)) {
              await emitRun(row);
              return;
            }
          }
          if (ticks % 30 === 0) {
            await stream.writeSSE({ event: "ping", data: String(ticks) });
          }
          await stream.sleep(400);
        }
        await stream.writeSSE({ event: "bye", data: "timeout" });
      });
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Wave 1 (W1a): the durable, ordered Run event log. The SSE route above
  // streams a projection of the mutable `runs` row; this returns the
  // append-only `run_events` log itself — the source of truth for replay and
  // the single export source for incident fixtures.
  api.get("/runs/:runId/events/history", requirePermission("run:read"), async (c) => {
    try {
      const runId = c.req.param("runId");
      const targetRun = await service.getRun(runId);
      const denied = await ensureWorkspaceAccess(service, c, targetRun.workspaceId);
      if (denied) return denied;
      const events = await service.listRunEventHistory(runId);
      return c.json({ runId, count: events.length, events });
    } catch (error) {
      return handleError(error, c);
    }
  });

  api.get(
    "/workspaces/:workspaceId/runs",
    requirePermission("run:read"),
    async (c) => {
      try {
        const denied = await ensureWorkspaceAccess(service, c, c.req.param("workspaceId"));
        if (denied) return denied;
        const runs = await service.listRunsByWorkspace(c.req.param("workspaceId"));
        return c.json(runs);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get(
    "/workspaces/:workspaceId/memory",
    requirePermission("memory:read"),
    async (c) => {
      try {
        const denied = await ensureWorkspaceAccess(service, c, c.req.param("workspaceId"));
        if (denied) return denied;
        const memory = await service.listWorkspaceMemory(c.req.param("workspaceId"));
        return c.json(memory);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/runs/:runId/approvals", requirePermission("run:read"), async (c) => {
    const approvals = await service.listApprovalRequests(c.req.param("runId"));
    return c.json(approvals);
  });

  api.post(
    "/runs/:runId/approval",
    requirePermission("approval:decide"),
    zodValidator("json", approvalDecisionSchema),
    async (c) => {
      try {
        const targetRun = await service.getRun(c.req.param("runId"));
        const denied = await ensureWorkspaceAccess(service, c, targetRun.workspaceId);
        if (denied) return denied;
        const decision = c.req.valid("json");
        const run = await service.updateApproval(c.req.param("runId"), decision);
        return c.json(run);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.post("/runs/:runId/clone", requirePermission("run:create"), async (c) => {
    try {
      const sourceRun = await service.getRun(c.req.param("runId"));
      const denied = await ensureWorkspaceAccess(service, c, sourceRun.workspaceId);
      if (denied) return denied;
      const clone = await service.cloneRun(c.req.param("runId"));
      return c.json(clone);
    } catch (error) {
      return handleError(error, c);
    }
  });

  // Undo window (Round L): cancel a queued/waiting/running execution.
  api.post("/runs/:runId/cancel", requirePermission("run:create"), async (c) => {
    try {
      const targetRun = await service.getRun(c.req.param("runId"));
      const denied = await ensureWorkspaceAccess(service, c, targetRun.workspaceId);
      if (denied) return denied;
      const cancelled = await service.cancelRun(c.req.param("runId"));
      return c.json(cancelled);
    } catch (error) {
      return handleError(error, c);
    }
  });

  // I-042 D2: explicit checkpoint resume — admin-only (`run:resume`, GM ruling
  // 2026-09-27). Origin selection, fail-closed handling and the
  // (runId, origin checkpoint) idempotency key live in the durable queue.
  // 404 unknown run (NotFoundError via getRun); 409 + code `resume_unavailable`
  // when fail-closed (no causally defined origin — never a silent full
  // replay); 200 with the resume outcome (`enqueued` / `already_enqueued` /
  // `noop`) otherwise. No RunStatus is introduced: the run row is untouched.
  api.post("/runs/:runId/resume", requirePermission("run:resume"), async (c) => {
    try {
      const targetRun = await service.getRun(c.req.param("runId"));
      const denied = await ensureWorkspaceAccess(service, c, targetRun.workspaceId);
      if (denied) return denied;
      const { run, result } = await service.resumeRunFromCheckpoint(c.req.param("runId"));
      if (result.status === "rejected") {
        return c.json(
          {
            message: `Checkpoint resume unavailable for run '${run.id}' (${result.reason ?? "no_origin"})`,
            code: "resume_unavailable",
            result
          },
          409
        );
      }
      return c.json({ run, result });
    } catch (error) {
      return handleError(error, c);
    }
  });

  api.patch(
    "/memory/:memoryId",
    requirePermission("memory:write"),
    zodValidator("json", updateMemoryInputSchema),
    async (c) => {
      try {
        const denied = await ensureResourceAccess(service, c, "memory", c.req.param("memoryId"));
        if (denied) return denied;
        const input = c.req.valid("json");
        const updated = await service.updateMemoryRecord(c.req.param("memoryId"), input);
        return c.json(updated);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.delete("/memory/:memoryId", requirePermission("memory:delete"), async (c) => {
    try {
      const denied = await ensureResourceAccess(service, c, "memory", c.req.param("memoryId"));
      if (denied) return denied;
      await service.deleteMemoryRecord(c.req.param("memoryId"));
      return c.json({ ok: true });
    } catch (error) {
      return handleError(error, c);
    }
  });

  const streamSchema = z.object({
    templateType: templateTypeSchema,
    input: templateInputPayloadSchema
  });

  api.post(
    "/ai/stream",
    requirePermission("run:create"),
    zodValidator("json", streamSchema),
    async (c) => {
      const { templateType, input } = c.req.valid("json");

      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "status",
          data: JSON.stringify({ aiEnabled: isAiAvailable(), templateType })
        });

        // Custom agents — persona-driven structured generation over SSE
        if (!["content_acquisition", "private_conversion", "weekly_review"].includes(templateType)) {
          const definition = service.registry.get(templateType);
          try {
            const { generateStructuredForAgent } = await import("@neuroclaw/agent-core");
            const result = definition?.persona
              ? await generateStructuredForAgent({
                  persona: definition.persona,
                  instruction: `Live preview for ${definition.name}.`,
                  fields: definition.outputContract.fields,
                  input
                })
              : { notice: `Preview for ${templateType} is generated inside the run pipeline.` };

            await stream.writeSSE({
              event: "partial",
              data: JSON.stringify({ ...(result as Record<string, unknown>), _mock: !isAiAvailable() })
            });
          } catch (streamError) {
            await stream.writeSSE({
              event: "error",
              data: JSON.stringify({
                message: streamError instanceof Error ? streamError.message : String(streamError)
              })
            });
          }
          await stream.writeSSE({ event: "done", data: "{}" });
          return;
        }

        try {
          const { result, isMock } = await streamGenerate(
            templateType as "content_acquisition" | "private_conversion" | "weekly_review",
            input
          );

          await stream.writeSSE({
            event: "partial",
            data: JSON.stringify({ ...(result as Record<string, unknown>), _mock: isMock })
          });

          await stream.writeSSE({
            event: "complete",
            data: JSON.stringify(result)
          });
        } catch (error) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({
              message: error instanceof Error ? error.message : "Generation failed"
            })
          });
        }
      });
    }
  );

  // -------------------------------------------------------------------------
  // W3 · simulation project-integration surface — fail-closed, simulation-only.
  // These routes accept simulation configs only; an adapter manifest is never
  // accepted as caller input (that would bypass assertSimulationOnlyAdapter).
  // Responses are simulation contracts, not capability or health claims.
  // -------------------------------------------------------------------------

  api.post(
    "/integration/validate",
    requirePermission("integration:validate"),
    zodValidator("json", simulationProjectIntegrationConfigSchema),
    (c) => {
      try {
        return c.json(service.validateSimulationIntegration(c.req.valid("json")));
      } catch (error) {
        // Kernel validation messages are the evidence — relay them untouched.
        return c.json(
          {
            message: error instanceof Error ? error.message : String(error),
            code: "INTEGRATION_VALIDATION_FAILED"
          },
          422
        );
      }
    }
  );

  api.get("/integration/projects", requirePermission("integration:read"), (c) => {
    const { contractVersion, integrations } = service.listSimulationIntegrations();
    return c.json({
      contractVersion,
      projects: integrations.map((integration) => integration.summary)
    });
  });

  api.get("/integration/projects/:projectKey", requirePermission("integration:read"), (c) => {
    const projectKey = c.req.param("projectKey");
    const { contractVersion, integrations } = service.listSimulationIntegrations();
    const match = integrations.find((integration) => integration.summary.projectKey === projectKey);
    if (!match) {
      return c.json(
        {
          message: `Unknown simulation integration project: ${projectKey}`,
          code: "INTEGRATION_PROJECT_NOT_FOUND"
        },
        404
      );
    }
    return c.json({ contractVersion, bundle: match.bundle });
  });

  api.get("/integration/adapters", requirePermission("integration:read"), (c) => {
    const { contractVersion, integrations } = service.listSimulationIntegrations();
    return c.json({
      contractVersion,
      adapters: integrations.map((integration) => integration.adapterInput)
    });
  });

  // -------------------------------------------------------------------------
  // W4 · 0008 registry HTTP surface (B1 §4).
  //
  // Reads: dual source by default; NEUROCLAW_REGISTRY_SOURCE=db selects the DB
  // single-read path with truthful per-item `source`. A DB read failure is a
  // 503 — the registry never silently falls back to fixtures.
  // Writes: thin envelopes only; the kernel owns the deep manifest parse.
  // -------------------------------------------------------------------------

  const registrySourceMode = (): "db" | "dual" =>
    process.env.NEUROCLAW_REGISTRY_SOURCE === "db" ? "db" : "dual";

  const registryReadFailure = (c: Context, error: unknown) =>
    c.json(
      {
        message: error instanceof Error ? error.message : String(error),
        code: "REGISTRY_SOURCE_UNAVAILABLE"
      },
      503
    );

  const registryPackWriteRequestSchema = z
    .object({
      pack: z.unknown(),
      options: z.unknown().optional()
    })
    .strict();

  const registryAdapterWriteRequestSchema = z
    .object({
      pack: z.unknown(),
      adapter: z.unknown(),
      options: z.unknown().optional()
    })
    .strict();

  api.post(
    "/registry/packs",
    requirePermission("registry:write"),
    zodValidator("json", registryPackWriteRequestSchema),
    async (c) => {
      const body = c.req.valid("json");
      try {
        const saved = await service.persistRegistryPack(
          body.pack as Parameters<ControlPlaneService["persistRegistryPack"]>[0],
          body.options as Parameters<ControlPlaneService["persistRegistryPack"]>[1] | undefined
        );
        return c.json({ pack: saved }, 201);
      } catch (error) {
        if (error instanceof RegistryConflictError) {
          // Immutable identity: this packId@version is already persisted.
          return c.json({ message: error.message, code: "REGISTRY_CONFLICT" }, 409);
        }
        throw error;
      }
    }
  );

  api.get("/registry/packs", requirePermission("registry:read"), async (c) => {
    const { projectId, limit } = c.req.query();
    try {
      const data = await service.listRegistryPacks();
      const mode = registrySourceMode();
      let items = data.items;
      if (mode === "db") {
        items = items.filter((item) => item.source === "db");
      }
      if (projectId) {
        items = items.filter(
          (item) => item.projectId === projectId || item.projectKey === projectId
        );
      }
      const max = Number.parseInt(limit ?? "", 10);
      if (Number.isFinite(max) && max >= 0) {
        items = items.slice(0, max);
      }
      return c.json({ ...data, source: mode, items });
    } catch (error) {
      return registryReadFailure(c, error);
    }
  });

  api.get(
    "/registry/packs/:packId/:version",
    requirePermission("registry:read"),
    async (c) => {
      const packId = c.req.param("packId");
      const version = c.req.param("version");
      try {
        const data = await service.listRegistryPacks();
        const mode = registrySourceMode();
        const entry = data.items.find(
          (item) =>
            item.packId === packId &&
            item.version === version &&
            (mode === "dual" || item.source === "db")
        );
        if (!entry) {
          return c.json(
            {
              message: `Unknown registry pack: ${packId}@${version}`,
              code: "REGISTRY_PACK_NOT_FOUND"
            },
            404
          );
        }
        return c.json({ contractVersion: data.contractVersion, source: mode, pack: entry });
      } catch (error) {
        return registryReadFailure(c, error);
      }
    }
  );

  api.post(
    "/registry/adapters",
    requirePermission("registry:write"),
    zodValidator("json", registryAdapterWriteRequestSchema),
    async (c) => {
      const body = c.req.valid("json");
      const adapterValue = body.adapter as { simulationOnly?: unknown } | null;
      if (
        typeof adapterValue !== "object" ||
        adapterValue === null ||
        adapterValue.simulationOnly !== true
      ) {
        // Fail-closed: only simulation-only adapters may enter the registry.
        return c.json(
          {
            message: "Registry adapter write rejected: simulationOnly must be true",
            code: "REGISTRY_ADAPTER_NOT_SIMULATION_ONLY"
          },
          422
        );
      }
      const saved = await service.persistSimulationOnlyAdapter(
        body.adapter as Parameters<ControlPlaneService["persistSimulationOnlyAdapter"]>[0],
        {
          // Minimal usable assembly: the adapter registry entry needs its pack.
          ...(body.options as
            | Parameters<ControlPlaneService["persistSimulationOnlyAdapter"]>[1]
            | undefined),
          pack: body.pack as Parameters<ControlPlaneService["persistRegistryPack"]>[0]
        }
      );
      return c.json({ adapter: saved }, 201);
    }
  );

  api.get("/registry/adapters", requirePermission("registry:read"), async (c) => {
    const { packId, packVersion } = c.req.query();
    try {
      const data = await service.listRegistryAdapters();
      const mode = registrySourceMode();
      let items = data.items;
      if (mode === "db") {
        items = items.filter((item) => item.source === "db");
      }
      if (packId) {
        items = items.filter((item) => item.packId === packId);
      }
      if (packVersion) {
        items = items.filter((item) => item.packVersion === packVersion);
      }
      return c.json({ ...data, source: mode, items });
    } catch (error) {
      return registryReadFailure(c, error);
    }
  });

  api.post(
    "/registry/projects/simulate",
    requirePermission("registry:write"),
    zodValidator("json", simulationProjectIntegrationConfigSchema),
    async (c) => {
      const result = await service.persistSimulationIntegrationConfig(c.req.valid("json"));
      return c.json(result, 201);
    }
  );

  api.get("/registry/coverage", requirePermission("registry:read"), async (c) => {
    try {
      return c.json(await service.getRegistryCoverage());
    } catch (error) {
      return registryReadFailure(c, error);
    }
  });

  api.get("/registry/projects", requirePermission("registry:read"), async (c) => {
    try {
      const data = await service.listRegistryProjects();
      const mode = registrySourceMode();
      if (mode === "dual") {
        return c.json(data);
      }
      const items = data.items
        .map((project) => ({
          ...project,
          packs: project.packs.filter((pack) => pack.source === "db")
        }))
        .filter((project) => project.packs.length > 0);
      return c.json({ ...data, source: mode, items });
    } catch (error) {
      return registryReadFailure(c, error);
    }
  });

  // -------------------------------------------------------------------------
  // W2 §2.3 · dead-letter replay — append-only, admin-only, fail-closed.
  //
  // Kill switch off → 503 before touching the store (fail-closed). On: append
  // a new event (`:replay:{nonce}` key, causationId = old eventId; FAILED rows
  // are never resurrected) and attempt immediate delivery through the injected
  // transport. No real transport exists in this slice: without one, the replay
  // is recorded and `dispatch` is null — never a fake send.
  // -------------------------------------------------------------------------

  api.post(
    "/outbox/:eventId/replay",
    requirePermission("outbox:replay"),
    async (c) => {
      const dispatchConfig = resolveOutboxDispatchConfig();
      if (!dispatchConfig.enabled) {
        return c.json(
          {
            message:
              'Outbox dispatch is not enabled (NEUROCLAW_OUTBOX_DISPATCH_ENABLED must be "1"); replay is refused.',
            code: "OUTBOX_DISPATCH_DISABLED"
          },
          503
        );
      }

      const eventId = c.req.param("eventId");
      const store = new OutboxDeliveryStore(service.db);
      const existing = await store.getEvent(eventId);
      if (!existing) {
        return c.json(
          { message: `Outbox event not found: ${eventId}`, code: "OUTBOX_EVENT_NOT_FOUND" },
          404
        );
      }
      if (existing.status !== "FAILED") {
        // FAILED is the only replayable terminal state (append-only: no
        // resurrection, no duplicate send of a live or completed event).
        return c.json(
          {
            message: `Only FAILED outbox events can be replayed; '${eventId}' is ${existing.status}`,
            code: "OUTBOX_REPLAY_CONFLICT"
          },
          409
        );
      }

      const replayed = await store.replay(eventId, outboxSeam.now?.() ?? new Date());

      let dispatch: OutboxDispatchBatchResult | null = null;
      if (outboxSeam.transport) {
        dispatch = await new OutboxDispatcher({
          db: service.db,
          transport: outboxSeam.transport,
          enabled: true,
          maxAttempts: dispatchConfig.maxAttempts,
          now: outboxSeam.now
        }).dispatchEvent(replayed.eventId);
      }
      const finalEvent = dispatch
        ? ((await store.getEvent(replayed.eventId)) ?? replayed)
        : replayed;

      return c.json(
        {
          replayed: {
            eventId: finalEvent.eventId,
            idempotencyKey: finalEvent.idempotencyKey,
            causationId: finalEvent.causationId,
            status: finalEvent.status
          },
          dispatch
        },
        200
      );
    }
  );

  app.route("/api", api);

  if (staticDir) {
    app.use(
      "/assets/*",
      async (c, next) => {
        await next();
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
      serveStatic({ root: staticDir, rewriteRequestPath: (p) => p.replace(/^\/assets/, "/assets") })
    );
    app.get("*", async (c) => {
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const url = new URL(c.req.url);
      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.resolve(staticDir, `.${requestedPath}`);

      // 防陈旧:index.html 永远协商缓存(重建后立即生效);
      // 带哈希的 assets 内容不变可长缓存。
      const isHtml = requestedPath === "/index.html" || !path.extname(requestedPath);
      const cacheControl = isHtml
        ? "no-cache, must-revalidate"
        : "public, max-age=31536000, immutable";

      try {
        const content = await readFile(filePath);
        const mime = getMimeType(filePath);
        return new Response(content, {
          headers: { "Content-Type": mime, "Cache-Control": cacheControl }
        });
      } catch {
        try {
          const indexHtml = await readFile(path.join(staticDir, "index.html"));
          return new Response(indexHtml, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Cache-Control": "no-cache, must-revalidate"
            }
          });
        } catch {
          return c.json({ message: "Static asset not found", code: "STATIC_NOT_FOUND" }, 404);
        }
      }
    });
  }

  app.notFound((c) => c.json({ message: "Not found", code: "NOT_FOUND" }, 404));

  app.onError((err, c) => handleError(err, c));

  return app;
}

function handleError(error: unknown, c: Parameters<Parameters<Hono<AppEnv>["onError"]>[0]>[1]) {
  if (error instanceof NotFoundError) {
    return c.json({ message: error.message, code: error.code }, 404);
  }

  if (error instanceof QuotaExceededError) {
    return c.json(
      { message: error.message, code: error.code, detail: error.detail },
      402
    );
  }

  const pgCode = (error as { code?: string } | null)?.code;
  if (pgCode === "23505") {
    return c.json({ message: "Duplicate resource", code: "DUPLICATE" }, 409);
  }

  const message = error instanceof Error ? error.message : "Unknown failure";
  return c.json({ message, code: "BAD_REQUEST" }, 400);
}

function getMimeType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "application/javascript";
  if (filePath.endsWith(".css")) return "text/css";
  if (filePath.endsWith(".json")) return "application/json";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  return "text/plain; charset=utf-8";
}

export type App = ReturnType<typeof createApp>;
