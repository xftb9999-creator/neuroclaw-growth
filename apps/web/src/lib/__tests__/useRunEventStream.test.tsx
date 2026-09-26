// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

import { useRunEventStream } from "../useRunEventStream.js";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: unknown) => void>>();
  closed = false;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, cb: (e: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(cb);
    this.listeners.set(type, list);
  }

  emit(type: string, data: string) {
    for (const cb of this.listeners.get(type) ?? []) {
      cb({ data });
    }
  }

  fail() {
    this.onerror?.();
  }

  close() {
    this.closed = true;
  }
}

const wrapper = ({ children }: { children: React.ReactNode }) => <>{children}</>;

describe("useRunEventStream", () => {
  beforeAll(() => {
    vi.stubGlobal("EventSource", FakeEventSource);
  });

  it("parses run frames into onUpdate and closes on bye", async () => {
    FakeEventSource.instances = [];
    const onUpdate = vi.fn();
    const { result } = renderHook(
      () => useRunEventStream({ runId: "run_1", enabled: true, onUpdate }),
      { wrapper }
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe("/api/runs/run_1/events");
    expect(result.current).toBe("live");

    es.emit("run", JSON.stringify({ id: "run_1", status: "running" }));
    expect(onUpdate).toHaveBeenCalledWith({ id: "run_1", status: "running" });

    es.emit("bye", "done");
    expect(es.closed).toBe(true);
  });

  it("falls back after three consecutive failures", async () => {
    FakeEventSource.instances = [];
    const onUpdate = vi.fn();
    const { result } = renderHook(
      () => useRunEventStream({ runId: "run_2", enabled: true, onUpdate }),
      { wrapper }
    );

    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];

    es.fail();
    es.fail();
    await waitFor(() => expect(result.current).toBe("live")); // still holding at 2
    es.fail();
    await waitFor(() => expect(result.current).toBe("fallback"));
    expect(es.closed).toBe(true);
  });

  it("reports off when disabled", () => {
    FakeEventSource.instances = [];
    const { result } = renderHook(
      () => useRunEventStream({ runId: "run_3", enabled: false, onUpdate: () => {} }),
      { wrapper }
    );
    expect(result.current).toBe("off");
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
