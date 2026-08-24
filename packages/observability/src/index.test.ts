import { afterEach, describe, expect, it } from "vitest";

import {
  InMemoryTraceLog,
  OTelTraceLog,
  getTraceLog,
  resetTraceLog,
  isOTelEnabled,
  initOtel,
  shutdownOtel,
  flushOtel
} from "./index.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  // Reset env vars and singleton between tests
  for (const key of [
    "NEUROCLAW_OTEL_ENABLED",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_SERVICE_NAME"
  ]) {
    delete process.env[key];
  }
  for (const key of Object.keys(ORIGINAL_ENV)) {
    process.env[key] = ORIGINAL_ENV[key];
  }
  resetTraceLog();
});

describe("observability trace log", () => {
  it("uses InMemoryTraceLog by default in development", () => {
    resetTraceLog();
    const traceLog = getTraceLog();
    expect(traceLog).toBeInstanceOf(InMemoryTraceLog);
  });

  it("uses OTelTraceLog when OTLP endpoint is configured", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    resetTraceLog();
    const traceLog = getTraceLog();
    expect(traceLog).toBeInstanceOf(OTelTraceLog);
  });

  it("uses OTelTraceLog when NEUROCLAW_OTEL_ENABLED is set", () => {
    process.env.NEUROCLAW_OTEL_ENABLED = "1";
    resetTraceLog();
    const traceLog = getTraceLog();
    expect(traceLog).toBeInstanceOf(OTelTraceLog);
  });

  it("returns the same singleton across calls", () => {
    resetTraceLog();
    const a = getTraceLog();
    const b = getTraceLog();
    expect(a).toBe(b);
  });

  it("records trace events with timestamp", () => {
    const traceLog = new InMemoryTraceLog();
    const event = traceLog.record({
      scope: "test",
      action: "unit_test"
    });
    expect(event.scope).toBe("test");
    expect(event.action).toBe("unit_test");
    expect(event.timestamp).toBeDefined();
    expect(traceLog.list()).toHaveLength(1);
  });

  it("starts and ends spans with attributes", () => {
    const traceLog = new InMemoryTraceLog();
    const span = traceLog.startSpan("test", "span_action", { foo: "bar" });
    span.setAttribute("baz", "qux");
    span.end();
    expect(traceLog.list()).toHaveLength(1);
    expect(traceLog.list()[0].metadata).toMatchObject({
      foo: "bar",
      baz: "qux"
    });
  });

  it("records errors on spans", () => {
    const traceLog = new InMemoryTraceLog();
    const span = traceLog.startSpan("test", "failing_action");
    span.recordError(new Error("boom"));
    span.end();
    expect(traceLog.list()[0].metadata?.error).toBe("boom");
  });
});

describe("observability isOTelEnabled", () => {
  it("returns false when no env vars are set", () => {
    delete process.env.NEUROCLAW_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    expect(isOTelEnabled()).toBe(false);
  });

  it("returns true when NEUROCLAW_OTEL_ENABLED=1", () => {
    process.env.NEUROCLAW_OTEL_ENABLED = "1";
    expect(isOTelEnabled()).toBe(true);
  });

  it("returns true when OTLP endpoint is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel:4318";
    expect(isOTelEnabled()).toBe(true);
  });
});

describe("observability otel-sdk", () => {
  it("initOtel returns null when OTLP is not configured", async () => {
    delete process.env.NEUROCLAW_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const handle = await initOtel();
    expect(handle).toBeNull();
  });

  it("initOtel is idempotent — returns the same handle on subsequent calls", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const first = await initOtel();
    const second = await initOtel();
    expect(first).toBe(second);
    await shutdownOtel();
  });

  it("shutdownOtel is safe to call when no SDK is active", async () => {
    delete process.env.NEUROCLAW_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });

  it("flushOtel is safe to call when no SDK is active", async () => {
    delete process.env.NEUROCLAW_OTEL_ENABLED;
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    await expect(flushOtel()).resolves.toBeUndefined();
  });

  it("gracefully falls back when SDK package is not installed", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    // SDK packages are not installed in the test environment, so initOtel
    // should catch the dynamic import failure and return null.
    const handle = await initOtel();
    expect(handle).toBeNull();
  });
});
