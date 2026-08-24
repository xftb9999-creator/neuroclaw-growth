import { trace, context, SpanStatusCode, type Tracer, type Span } from "@opentelemetry/api";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceEvent {
  scope: string;
  action: string;
  timestamp: string;
  metadata?: Record<string, string>;
}

export interface TraceLog {
  record(event: Omit<TraceEvent, "timestamp">): TraceEvent;
  list(): TraceEvent[];
  startSpan(scope: string, action: string, metadata?: Record<string, string>): ActiveSpan;
}

export interface ActiveSpan {
  setAttribute(key: string, value: string): void;
  recordError(error: Error | string): void;
  end(): void;
}

// ---------------------------------------------------------------------------
// InMemoryTraceLog — development fallback, no external dependencies
// ---------------------------------------------------------------------------

export class InMemoryTraceLog implements TraceLog {
  private readonly events: TraceEvent[] = [];

  record(event: Omit<TraceEvent, "timestamp">): TraceEvent {
    const enriched = {
      ...event,
      timestamp: new Date().toISOString()
    };
    this.events.push(enriched);
    return enriched;
  }

  list(): TraceEvent[] {
    return [...this.events];
  }

  startSpan(scope: string, action: string, metadata?: Record<string, string>): ActiveSpan {
    const event = this.record({ scope, action, metadata });
    return {
      setAttribute(key: string, value: string) {
        event.metadata = { ...(event.metadata ?? {}), [key]: value };
      },
      recordError(error: Error | string) {
        event.metadata = {
          ...(event.metadata ?? {}),
          error: error instanceof Error ? error.message : String(error)
        };
      },
      end() {
        // no-op for in-memory
      }
    };
  }
}

// ---------------------------------------------------------------------------
// OTelTraceLog — production-grade OpenTelemetry-backed tracing
// ---------------------------------------------------------------------------

export class OTelTraceLog implements TraceLog {
  private readonly tracer: Tracer;
  private readonly events: TraceEvent[] = [];
  private readonly activeSpans = new Map<string, Span>();

  constructor(tracerName = "neuroclaw") {
    this.tracer = trace.getTracer(tracerName);
  }

  record(event: Omit<TraceEvent, "timestamp">): TraceEvent {
    const enriched = {
      ...event,
      timestamp: new Date().toISOString()
    };
    this.events.push(enriched);

    // Also emit as a span event for distributed tracing
    const currentSpan = trace.getSpan(context.active());
    if (currentSpan) {
      currentSpan.addEvent(event.action, {
        scope: event.scope,
        ...event.metadata
      });
    }

    return enriched;
  }

  list(): TraceEvent[] {
    return [...this.events];
  }

  startSpan(scope: string, action: string, metadata?: Record<string, string>): ActiveSpan {
    const span = this.tracer.startSpan(`${scope}.${action}`);

    span.setAttributes({
      "neuroclaw.scope": scope,
      "neuroclaw.action": action,
      ...(metadata ?? {})
    });

    const spanId = `${scope}.${action}.${Date.now()}`;
    this.activeSpans.set(spanId, span);

    return {
      setAttribute(key: string, value: string) {
        span.setAttribute(key, value);
      },
      recordError(error: Error | string) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error)
        });
        if (error instanceof Error) {
          span.recordException(error);
        }
      },
      end() {
        span.end();
      }
    };
  }
}

// ---------------------------------------------------------------------------
// Factory — picks the right implementation based on configuration
// ---------------------------------------------------------------------------

let singleton: TraceLog | null = null;

export function getTraceLog(): TraceLog {
  if (!singleton) {
    const useOTel = process.env.NEUROCLAW_OTEL_ENABLED === "1" ||
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;

    singleton = useOTel ? new OTelTraceLog() : new InMemoryTraceLog();
  }
  return singleton;
}

export function resetTraceLog(): void {
  singleton = null;
}

export function isOTelEnabled(): boolean {
  return process.env.NEUROCLAW_OTEL_ENABLED === "1" ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT !== undefined;
}

// Re-export OTel SDK bootstrap for optional production tracing
export {
  initOtel,
  shutdownOtel,
  flushOtel,
  type OtelHandle
} from "./otel-sdk.js";
