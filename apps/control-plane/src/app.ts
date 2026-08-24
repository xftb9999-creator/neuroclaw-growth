import { Hono } from "hono";
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
  savePlaybookInputSchema,
  templateTypeSchema,
  templateInputPayloadSchema,
  updateAgentInputSchema,
  updateMemoryInputSchema
} from "@neuroclaw/shared";
import { isMcpAvailable, getMcpRegistry } from "@neuroclaw/tooling-mcp";
import { ControlPlaneService, NotFoundError } from "./index.js";
import { requireAuth, requirePermission } from "./middleware/auth.js";
import { createAuditMiddleware } from "./middleware/audit.js";

export type AppEnv = {
  Variables: {
    authUserId: string;
    authRole: "admin" | "operator" | "viewer";
  };
};

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

export function createApp(service: ControlPlaneService, staticDir?: string) {
  const app = new Hono<AppEnv>();

  app.use("*", logger());
  app.use("*", secureHeaders());
  app.use("*", timeout(30_000));

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ready", (c) => c.json({ ok: true, service: "control-plane" }));

  const api = new Hono<AppEnv>();
  api.use("*", requireAuth());
  api.use("*", createAuditMiddleware(service.db));

  api.post(
    "/workspaces",
    requirePermission("workspace:create"),
    zodValidator("json", createWorkspaceInputSchema),
    async (c) => {
      const input = c.req.valid("json");
      const workspace = await service.createWorkspace(input);
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
    return c.json(await service.searchKnowledge(workspaceId, c.req.query("q")));
  });

  const refineSchema = z.object({ workspaceId: z.string().min(1) });
  api.post(
    "/knowledge/ai-refine",
    requirePermission("memory:write"),
    zodValidator("json", refineSchema),
    async (c) => {
      try {
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
        return c.json(await service.listArtifacts(c.req.param("workspaceId")));
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.delete("/artifacts/:artifactId", requirePermission("memory:delete"), async (c) => {
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
      return c.json(await service.createKnowledgeEntry(c.req.valid("json")), 201);
    }
  );

  api.get(
    "/workspaces/:workspaceId/knowledge",
    requirePermission("memory:read"),
    async (c) => {
      return c.json(await service.listKnowledgeEntries(c.req.param("workspaceId")));
    }
  );

  api.delete("/knowledge/:entryId", requirePermission("memory:delete"), async (c) => {
    await service.deleteKnowledgeEntry(c.req.param("entryId"));
    return c.json({ ok: true });
  });

  // -----------------------------------------------------------------------
  // Approval inbox + Schedules (J4)
  // -----------------------------------------------------------------------

  api.get("/approvals/pending", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
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
      return c.json(await service.createSchedule(c.req.valid("json")), 201);
    }
  );

  api.get("/schedules", requirePermission("run:read"), async (c) => {
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
    audience: z.string().optional()
  });

  api.post(
    "/teams/launch",
    requirePermission("run:create"),
    zodValidator("json", teamLaunchSchema),
    async (c) => {
      try {
        return c.json(await service.launchTeam(c.req.valid("json")), 201);
      } catch (error) {
        return handleError(error, c);
      }
    }
  );

  api.get("/teams", requirePermission("run:read"), async (c) => {
    const workspaceId = c.req.query("workspaceId");
    if (!workspaceId) {
      return c.json({ message: "workspaceId is required" }, 400);
    }
    return c.json(await service.listTeams(workspaceId));
  });

  api.get("/teams/:teamId", requirePermission("run:read"), async (c) => {
    try {
      return c.json(await service.getTeam(c.req.param("teamId")));
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
      return c.json(await service.getAnalyticsOverview(workspaceId, Math.min(60, Math.max(7, days))));
    } catch (error) {
      return handleError(error, c);
    }
  });

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
      const run = await service.createRun(input);
      return c.json(run, 201);
    }
  );

  api.get("/runs/:runId", requirePermission("run:read"), async (c) => {
    try {
      const run = await service.getRun(c.req.param("runId"));
      return c.json(run);
    } catch (error) {
      return handleError(error, c);
    }
  });

  api.get(
    "/workspaces/:workspaceId/runs",
    requirePermission("run:read"),
    async (c) => {
      try {
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
      const clone = await service.cloneRun(c.req.param("runId"));
      return c.json(clone);
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

  app.route("/api", api);

  if (staticDir) {
    app.use(
      "/assets/*",
      serveStatic({ root: staticDir, rewriteRequestPath: (p) => p.replace(/^\/assets/, "/assets") })
    );
    app.get("*", async (c) => {
      const { readFile } = await import("node:fs/promises");
      const path = await import("node:path");
      const url = new URL(c.req.url);
      const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
      const filePath = path.resolve(staticDir, `.${requestedPath}`);

      try {
        const content = await readFile(filePath);
        const mime = getMimeType(filePath);
        return new Response(content, {
          headers: { "Content-Type": mime }
        });
      } catch {
        try {
          const indexHtml = await readFile(path.join(staticDir, "index.html"));
          return new Response(indexHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" }
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
