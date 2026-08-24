// ---------------------------------------------------------------------------
// Minimal type stubs for optional OpenTelemetry SDK packages.
//
// These packages are dynamically imported by `otel-sdk.ts` so the runtime
// dependency is optional (the SDK activates only when an OTLP endpoint is
// configured AND the packages are installed). These stubs let TypeScript
// type-check the call sites without requiring the packages to be installed.
//
// If you install the real packages, TypeScript will pick up their bundled
// .d.ts files instead of these stubs (declaration merging / ambient module
// override rules).
// ---------------------------------------------------------------------------

declare module "@opentelemetry/sdk-node" {
  export interface NodeSDKConfiguration {
    resource?: unknown;
    traceExporter?: unknown;
    instrumentations?: unknown[];
  }
  export class NodeSDK {
    constructor(config: NodeSDKConfiguration);
    start(): void;
    shutdown(): Promise<void>;
    flush?(): Promise<void>;
  }
}

declare module "@opentelemetry/resources" {
  export class Resource {
    constructor(attributes: Record<string, string>);
  }
}

declare module "@opentelemetry/semantic-conventions" {
  export const ATTR_SERVICE_NAME: string;
}

declare module "@opentelemetry/exporter-trace-otlp-http" {
  export interface OTLPTraceExporterConfig {
    url?: string;
    headers?: Record<string, string>;
  }
  export class OTLPTraceExporter {
    constructor(config?: OTLPTraceExporterConfig);
  }
}
