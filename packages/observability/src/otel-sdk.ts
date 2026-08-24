// ---------------------------------------------------------------------------
// OTel SDK bootstrap — optional, only activates when OTLP endpoint is configured
// and @opentelemetry/sdk-node is installed. Uses dynamic import to avoid
// hard dependency for development and test environments.
// ---------------------------------------------------------------------------

import { isOTelEnabled } from "./index.js";

export interface OtelHandle {
  /** Flush pending spans/batches to the exporter. */
  flush(): Promise<void>;
  /** Shutdown the SDK — should be called during graceful shutdown. */
  shutdown(): Promise<void>;
}

let activeHandle: OtelHandle | null = null;
let initPromise: Promise<OtelHandle | null> | null = null;

/**
 * Initialize the OpenTelemetry SDK if OTLP is configured and the SDK package
 * is installed. Returns null in development / test environments, where the
 * NoopTracer from @opentelemetry/api is sufficient.
 *
 * Idempotent: subsequent calls return the same handle.
 */
export function initOtel(options: { serviceName?: string } = {}): Promise<OtelHandle | null> {
  if (activeHandle) return Promise.resolve(activeHandle);
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!isOTelEnabled()) return null;

    try {
      const sdkModule = await import("@opentelemetry/sdk-node");
      const resourceModule = await import("@opentelemetry/resources");
      const semconvModule = await import("@opentelemetry/semantic-conventions");
      const exporterModule = await import("@opentelemetry/exporter-trace-otlp-http");

      const NodeSDK = sdkModule.NodeSDK;
      const Resource = resourceModule.Resource;
      const OTLPTraceExporter = exporterModule.OTLPTraceExporter;
      const ATTR_SERVICE_NAME = semconvModule.ATTR_SERVICE_NAME;

      const serviceName = options.serviceName ??
        process.env.OTEL_SERVICE_NAME ??
        "neuroclaw-control-plane";

      const exporter = new OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
        headers: process.env.OTEL_EXPORTER_OTLP_HEADERS
          ? parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
          : undefined
      });

      const sdk = new NodeSDK({
        resource: new Resource({
          [ATTR_SERVICE_NAME]: serviceName
        }),
        traceExporter: exporter,
        instrumentations: []
      });

      sdk.start();

      activeHandle = {
        async flush() {
          await new Promise<void>((resolve) => {
            // sdk.flush is not always available; use a defensive call
            const maybeSdk = sdk as unknown as { flush?: () => Promise<void> };
            if (typeof maybeSdk.flush === "function") {
              maybeSdk.flush().then(resolve).catch(resolve);
            } else {
              resolve();
            }
          });
        },
        async shutdown() {
          await new Promise<void>((resolve) => {
            sdk.shutdown().then(resolve).catch(resolve);
          });
        }
      };

      // eslint-disable-next-line no-console
      console.log(`[otel] SDK started (service=${serviceName}, endpoint=${process.env.OTEL_EXPORTER_OTLP_ENDPOINT})`);
      return activeHandle;
    } catch (error) {
      // SDK not installed or misconfigured — fall back to noop tracing.
      // eslint-disable-next-line no-console
      console.warn(
        `[otel] SDK initialization skipped: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  })();

  return initPromise;
}

/** Shutdown the active OTel SDK, if any. Safe to call unconditionally. */
export async function shutdownOtel(): Promise<void> {
  if (activeHandle) {
    await activeHandle.shutdown();
    activeHandle = null;
    initPromise = null;
  }
}

/** Flush pending telemetry. Useful before process exit. */
export async function flushOtel(): Promise<void> {
  if (activeHandle) {
    await activeHandle.flush();
  }
}

function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const key = pair.slice(0, idx).trim();
      const value = pair.slice(idx + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}
