import { createAdaptorServer, serve, type ServerType } from "@hono/node-server";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { flushOtel, initOtel, shutdownOtel } from "@neuroclaw/observability";

import { ControlPlaneService } from "./index.js";
import { createApp } from "./app.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Resolves to <repo>/apps/web/dist both from src (vitest) and from compiled
// apps/control-plane/dist (production `npm start`).
export function resolveStaticDir(explicit?: string): string {
  return explicit
    ?? process.env.NEUROCLAW_STATIC_DIR
    ?? path.resolve(__dirname, "../../web/dist");
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

  // Initialize OTel SDK first so traces are captured from the start.
  // Returns null in development / test environments (no OTLP endpoint).
  await initOtel({ serviceName: "neuroclaw-control-plane" });

  const service = await ControlPlaneService.create();
  const app = createApp(service, staticDir);

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

  let shuttingDown = false;

  const shutdown = async (reason: string = "manual") => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] Graceful shutdown initiated (${reason})...`);
    clearInterval(schedulerTimer);

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
