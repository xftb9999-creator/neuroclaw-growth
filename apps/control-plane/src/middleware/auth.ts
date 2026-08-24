import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "node:crypto";

import type { Role } from "@neuroclaw/shared";

export interface AuthContext {
  Variables: {
    authUserId: string;
    authRole: Role;
  };
}

interface ApiKeyEntry {
  key: string;
  userId: string;
  role: Role;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

function parseApiKeys(env: string | undefined): ApiKeyEntry[] {
  if (!env) return [];
  return env
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [key, userId, role] = entry.split(":");
      if (!key || !userId || !role) return null;
      const validRoles: Role[] = ["admin", "operator", "viewer"];
      if (!validRoles.includes(role as Role)) return null;
      return { key, userId, role: role as Role };
    })
    .filter((entry): entry is ApiKeyEntry => entry !== null);
}

let cachedKeys: ApiKeyEntry[] = [];
let cachedEnvHash: string | null = null;

function getApiKeys(): ApiKeyEntry[] {
  const envValue = process.env.NEUROCLAW_API_KEYS ?? "";
  if (cachedEnvHash !== envValue) {
    cachedKeys = parseApiKeys(envValue);
    cachedEnvHash = envValue;
  }
  return cachedKeys;
}

export function requireAuth() {
  return createMiddleware<AuthContext>(async (c, next) => {
    const keys = getApiKeys();

    if (keys.length === 0) {
      c.set("authUserId", "dev");
      c.set("authRole", "admin");
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    const xApiKey = c.req.header("x-api-key");

    const presentedKey = match?.[1] ?? xApiKey;
    if (!presentedKey) {
      return c.json(
        { message: "Missing API key. Use Authorization: Bearer <key> or X-API-Key header.", code: "AUTH_MISSING" },
        401
      );
    }

    const matched = keys.find((entry) => safeEqual(entry.key, presentedKey));
    if (!matched) {
      return c.json({ message: "Invalid API key", code: "AUTH_INVALID" }, 401);
    }

    c.set("authUserId", matched.userId);
    c.set("authRole", matched.role);
    await next();
  });
}

export function requirePermission(permission: string) {
  return createMiddleware<AuthContext>(async (c, next) => {
    const role = c.get("authRole");
    const { hasPermission } = await import("@neuroclaw/shared");
    if (!hasPermission(role, permission)) {
      return c.json(
        { message: `Role '${role}' does not have permission: ${permission}`, code: "AUTH_FORBIDDEN" },
        403
      );
    }
    await next();
  });
}

export function maskApiKey(key: string): string {
  if (key.length <= 8) return "***";
  return key.slice(0, 4) + "…" + key.slice(-4);
}

export { getApiKeys };
