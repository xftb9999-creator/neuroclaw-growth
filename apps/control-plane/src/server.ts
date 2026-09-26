import { createAdaptorServer, serve, type ServerType } from "@hono/node-server";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flushOtel, initOtel, shutdownOtel } from "@neuroclaw/observability";

import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";
import { getApiKeys } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolves to <repo>/apps/web/dist both from src (vitest) and from compiled
// apps/control-plane/dist (production `npm start`).
export function resolveStaticDir(explicit?: string): string {
  return explicit
    ?? process.env.NEUROCLAW_STATIC_DIR
    ?? path.resolve(__dirname, "../../web/dist");
}

/**
 * Production safety gate (Round J, audit P0-C2):
 * - DATABASE_URL must point at a persistent PostgreSQL database (never
 *   `:memory:` or local-file PGlite)
 * - At least one API key must be configured (auth must not fail-open)
 * Enforced only when NODE_ENV=production so local/dev/test flows stay intact.
 */
export function assertProductionReadiness(): void {
  if (process.env.NODE_ENV !== "production") return;

  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl || dbUrl === ":memory:") {
    throw new Error(
      "Refusing to start in production: DATABASE_URL must be set to a persistent PostgreSQL URL."
    );
  }
  if (!dbUrl.startsWith("postgres://") && !dbUrl.startsWith("postgresql://")) {
    throw new Error(
      "Refusing to start in production: DATABASE_URL must use postgres:// or postgresql://; local-file PGlite is for non-production use."
    );
  }
  if (getApiKeys().length === 0) {
    throw new Error(
      "Refusing to start in production: NEUROCLAW_API_KEYS is empty; auth would fail open. Configure at least one key (`<key>:<userId>:<role>`)."
    );
  }
}

/**
 * A production process must not start if the browser artifact is missing.
 * This prevents a healthy API from receiving traffic while the user-facing
 * application can only return a static-asset error.
 */
export function assertProductionStaticAssets(staticDir: string): void {
  if (process.env.NODE_ENV !== "production") return;

  const indexPath = path.join(staticDir, "index.html");
  const manifestPath = path.join(staticDir, "release-manifest.json");
  try {
    if (!statSync(staticDir).isDirectory() || !existsSync(indexPath) || !existsSync(manifestPath)) {
      throw new Error("missing static artifact");
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      schemaVersion?: number;
      buildId?: string;
      assets?: unknown;
    };
    if (
      manifest.schemaVersion !== 1 ||
      typeof manifest.buildId !== "string" ||
      manifest.buildId.length !== 64 ||
      !Array.isArray(manifest.assets)
    ) {
      throw new Error("invalid release manifest");
    }
  } catch {
    throw new Error(
      "Refusing to start in production: the web build artifact is missing or invalid (expected index.html and release-manifest.json)."
    );
  }
}

export function createHttpServer(
  service: ControlPlaneService,
  staticDir = resolveStaticDir()
): ServerType {
  const app = createApp(service, staticDir);
  return createAdaptorServer({
    fetch: app.fetch
  });
}

// ---------------------------------------------------------------------------
// Main entry — graceful shutdown + OTel bootstrap
// ---------------------------------------------------------------------------

export interface ServerRuntime {
  service: ControlPlaneService;
  httpServer: ServerType;
  shutdown: () => Promise<void>;
}

export async function startServer(options: {
  port?: number;
  hostname?: string;
  staticDir?: string;
} = {}): Promise<ServerRuntime> {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const hostname = options.hostname ?? process.env.HOST ?? "0.0.0.0";
  const staticDir = resolveStaticDir(options.staticDir);

  assertProductionReadiness();
  assertProductionStaticAssets(staticDir);

  if (!process.env.DATABASE_URL || process.env.DATABASE_URL === ":memory:") {
    console.warn(
      "[startup] WARNING: DATABASE_URL is not set — the server will run on an in-memory database and ALL DATA WILL BE LOST on restart."
    );
  }

  // Initialize OTel SDK first so traces are captured from the start.
  // Returns null in development / test environments (no OTLP endpoint).
  await initOtel({ serviceName: "neuroclaw-control-plane" });

  // Durable mode (Round J): Run execution is decoupled from HTTP requests.
  const service = await ControlPlaneService.create(undefined, undefined, undefined, undefined, {
    durable: true
  });
  let shuttingDown = false;
  let jobLoopHealthy = true;
  let lastJobLoopTickAt = Date.now();
  const app = createApp(service, staticDir, {
    execution: () =>
      !shuttingDown &&
      jobLoopHealthy &&
      Date.now() - lastJobLoopTickAt <= 5_000
  });

  // Warm up hot statement paths BEFORE accepting traffic (Round O): with
  // embedded Postgres the first executes pay a one-shot JIT/WASM cost that
  // can exceed client timeouts under parallel load.
  try {
    for (const table of ["workspaces", "workspace_members", "subscriptions", "knowledge_entries", "product_events", "runs", "jobs"]) {
      await service.db.execute((await import("drizzle-orm")).sql.raw(`SELECT 1 FROM ${table} LIMIT 1`));
    }
  } catch (warmError) {
    console.warn(
      `[startup] warmup skipped: ${warmError instanceof Error ? warmError.message : String(warmError)}`
    );
  }

  // Background job loop (audit P0-C1): claim → execute → persist, draining
  // up to N jobs per tick; plus periodic stale-job recovery (audit P1-9).
  let jobLoopRunning = false;
  const jobLoopTimer = setInterval(async () => {
    if (jobLoopRunning) return;
    jobLoopRunning = true;
    try {
      for (let processed = 0; processed < 5; processed += 1) {
        const didProcess = await service.processNextJob();
        if (!didProcess) break;
      }
      jobLoopHealthy = true;
    } catch (error) {
      jobLoopHealthy = false;
      console.warn(
        `[job-loop] tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (jobLoopHealthy) lastJobLoopTickAt = Date.now();
      jobLoopRunning = false;
    }
  }, 750);
  jobLoopTimer.unref?.();

  const recoveryTimer = setInterval(() => {
    void service
      .recoverStaleJobs()
      .then((recovered) => {
        if (recovered > 0) {
          console.log(`[job-loop] recovered ${recovered} stale job(s)`);
        }
      })
      .catch((error) => {
        console.warn(
          `[job-loop] stale recovery failed: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }, 60_000);
  recoveryTimer.unref?.();

  // Scheduler tick — due recurring schedules → new runs (J4)
  const schedulerTimer = setInterval(() => {
    void service.processDueSchedules().catch((error) => {
      console.warn(
        `[scheduler] tick failed: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }, 30_000);
  schedulerTimer.unref?.();

  const httpServer = serve(
    {
      fetch: app.fetch,
      port,
      hostname
    },
    (info) => {
      console.log(`NeuroClaw control-plane listening on http://${info.address}:${info.port}`);
    }
  );

  const shutdown = async (reason: string = "manual") => {
    if (shuttingDown) return;
    shuttingDown = true;
    jobLoopHealthy = false;
    console.log(`[shutdown] Graceful shutdown initiated (${reason})...`);
    clearInterval(schedulerTimer);
    clearInterval(jobLoopTimer);
    clearInterval(recoveryTimer);

    // 1. Stop accepting new connections (drain in-flight requests with a timeout)
    await new Promise<void>((resolve) => {
      const forceExit = setTimeout(() => {
        console.warn("[shutdown] HTTP drain timed out after 10s, forcing close");
        resolve();
      }, 10_000);

      httpServer.close((err) => {
        clearTimeout(forceExit);
        if (err) {
          console.warn(`[shutdown] HTTP close error: ${err.message}`);
        }
        resolve();
      });
    });
    console.log("[shutdown] HTTP server closed");

    // 2. Stop temporal worker + close database connection
    try {
      await service.shutdown();
      console.log("[shutdown] Service shut down");
    } catch (err) {
      console.warn(
        `[shutdown] Service shutdown error: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // 3. Flush + shutdown OTel SDK so pending spans are exported
    try {
      await flushOtel();
      await shutdownOtel();
      console.log("[shutdown] OTel SDK shut down");
    } catch (err) {
      console.warn(
        `[shutdown] OTel shutdown error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  // Register signal handlers for graceful shutdown
  const signalHandler = (signal: string) => {
    shutdown(signal).finally(() => process.exit(0));
  };
  process.on("SIGINT", () => signalHandler("SIGINT"));
  process.on("SIGTERM", () => signalHandler("SIGTERM"));

  return { service, httpServer, shutdown };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch((error) => {
    console.error(
      `Failed to start server: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  });
}
