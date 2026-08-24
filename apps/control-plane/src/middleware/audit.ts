import { createMiddleware } from "hono/factory";
import { randomUUID } from "node:crypto";

import { type Database, auditEvents } from "@neuroclaw/db";
import type { AuthContext } from "./auth.js";

export interface AuditContext {
  Variables: {
    authUserId: string;
    authRole: string;
  };
}

interface AuditEntry {
  action: string;
  resourceType: string;
  resourceId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

function categorizeRequest(method: string, pathname: string): { action: string; resourceType: string } | null {
  if (pathname === "/api/workspaces" && method === "POST") {
    return { action: "workspace.create", resourceType: "workspace" };
  }
  if (pathname === "/api/runs" && method === "POST") {
    return { action: "run.create", resourceType: "run" };
  }
  if (pathname.match(/^\/api\/runs\/[^/]+\/approval$/) && method === "POST") {
    return { action: "run.approve", resourceType: "run" };
  }
  if (pathname.match(/^\/api\/runs\/[^/]+\/clone$/) && method === "POST") {
    return { action: "run.clone", resourceType: "run" };
  }
  if (pathname.match(/^\/api\/memory\/[^/]+$/) && method === "PATCH") {
    return { action: "memory.update", resourceType: "memory" };
  }
  if (pathname.match(/^\/api\/memory\/[^/]+$/) && method === "DELETE") {
    return { action: "memory.delete", resourceType: "memory" };
  }
  if (pathname.startsWith("/api/")) {
    return { action: `${method.toLowerCase()}.api`, resourceType: "api" };
  }
  return null;
}

export function createAuditMiddleware(db: Database) {
  return createMiddleware<AuthContext & AuditContext>(async (c, next) => {
    await next();

    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const method = c.req.method;

    if (pathname === "/health" || pathname === "/ready") return;

    const category = categorizeRequest(method, pathname);
    if (!category) return;

    const actorId = c.get("authUserId") ?? "anonymous";
    const status = c.res.status;
    const responseClone = c.res.clone();
    let resourceId: string | undefined;
    let workspaceId: string | undefined;

    if (status >= 200 && status < 300) {
      try {
        const body = await responseClone.json();
        resourceId = body?.id;
        workspaceId = body?.workspaceId;
        if (!workspaceId && body?.workspaceId) {
          workspaceId = body.workspaceId;
        }
      } catch {
        // Not JSON or empty body
      }
    }

    const entry: AuditEntry = {
      action: category.action,
      resourceType: category.resourceType,
      resourceId,
      workspaceId,
      metadata: {
        method,
        path: pathname,
        status,
        actorRole: c.get("authRole") ?? "anonymous"
      }
    };

    const row: typeof auditEvents.$inferInsert = {
      id: `audit_${randomUUID()}`,
      workspaceId: entry.workspaceId ?? null,
      actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      metadata: JSON.stringify(entry.metadata),
      createdAt: new Date().toISOString()
    };

    try {
      await db.insert(auditEvents).values(row);
    } catch {
      // Audit logging should never break the response
    }
  });
}
