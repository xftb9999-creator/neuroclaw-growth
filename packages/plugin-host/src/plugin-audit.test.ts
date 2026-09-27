/**
 * P2-3 · 插件审计事件单测（宿主侧）。
 * 判据源：plugin-roadmap.md:299、plugin.md §5 机制 5、p2-readiness §1 门禁 5。
 * 覆盖：六类事件码（registered/loaded/enabled/disabled/denied/rolled_back）、
 * 负向拒绝携带明确错误码、激活回滚、sink 故障永不反噬生命周期。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  pluginManifestSchema,
  type PluginManifest
} from "@neuroclaw/plugin-contract";

import {
  PluginCapabilityError,
  createPluginCapabilityHandle
} from "./capability-handle.js";
import { DEFAULT_HOST_API_VERSION, PluginHost, PluginHostError } from "./plugin-host.js";
import { emitPluginAudit, type PluginAuditEvent, type PluginAuditSink } from "./plugin-audit.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-audit-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeManifest(
  dir: string,
  fileName: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const manifest = {
    pluginKey: "audit_pack",
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    hostApiRange: ">=1.0.0 <2.0.0",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    entryPoint: "./entry.mjs",
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  };
  await writeFile(path.join(dir, fileName), JSON.stringify(manifest, null, 2));
}

function recorder(): { events: PluginAuditEvent[]; sink: PluginAuditSink } {
  const events: PluginAuditEvent[] = [];
  return {
    events,
    sink: (event) => {
      events.push(event);
    }
  };
}

function baseManifest(overrides: Record<string, unknown> = {}): PluginManifest {
  return pluginManifestSchema.parse({
    pluginKey: "audit_pack",
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    hostApiRange: ">=1.0.0 <2.0.0",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    entryPoint: "./entry.mjs",
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  });
}

const silent = { logger: () => {} };

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("P2-3 · 宿主生命周期审计", () => {
  it("装载→启用→禁用：registered/loaded/enabled/disabled 按序落审计且身份齐全", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json");
    const { events, sink } = recorder();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["audit_pack"],
      auditSink: sink,
      importer: async () => ({ async onLoad(): Promise<void> {}, async onEnable(): Promise<void> {} }),
      ...silent
    });

    await host.init();
    await host.disable("audit_pack");

    expect(events.map((event) => event.eventType)).toEqual([
      "plugin.registered",
      "plugin.loaded",
      "plugin.enabled",
      "plugin.disabled"
    ]);
    for (const event of events) {
      expect(event.pluginKey).toBe("audit_pack");
      expect(event.pluginVersion).toBe("1.0.0");
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
  });

  it("扫描期拒绝：denied 携带 findings 码（stage=scan；import 从未发生）", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "bad.plugin.json", {
      pluginKey: "bad_pack",
      hostApiRange: ">=2.0.0 <3.0.0"
    });
    const { events, sink } = recorder();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["bad_pack"],
      auditSink: sink,
      ...silent
    });

    const report = await host.init();

    expect(report.rejected).toBe(1);
    const denied = events.find((event) => event.eventType === "plugin.denied");
    expect(denied?.code).toContain("HOST_API_RANGE_UNSATISFIED");
    expect(denied?.detail).toMatchObject({ stage: "scan" });
  });

  it("能力授予门拒绝：denied 携带 CAPABILITY_GRANT_EMPTY（声明 live 而宿主要求 simulation-only）", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "live.plugin.json", { pluginKey: "live_pack", simulationOnly: false });
    const { events, sink } = recorder();
    let imports = 0;
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["live_pack"],
      auditSink: sink,
      importer: async () => {
        imports += 1;
        return {};
      },
      ...silent
    });

    const report = await host.init();

    expect(report.registered).toBe(1);
    expect(report.activated).toBe(0);
    expect(imports).toBe(0);
    const denied = events.find((event) => event.eventType === "plugin.denied");
    expect(denied?.code).toBe("CAPABILITY_GRANT_EMPTY");
    expect(denied?.detail).toMatchObject({ stage: "capability-gate", importAttempted: false });
  });

  it("激活失败回滚：rolled_back（import 失败）且无 enabled 事件", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json");
    const { events, sink } = recorder();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["audit_pack"],
      auditSink: sink,
      importer: async () => {
        throw new Error("import boom");
      },
      ...silent
    });
    await host.init();

    await expect(host.enable("audit_pack")).rejects.toBeInstanceOf(PluginHostError);
    const rolled = events.find((event) => event.eventType === "plugin.rolled_back");
    expect(rolled?.code).toBe("PLUGIN_ACTIVATION_FAILED");
    expect(rolled?.detail).toMatchObject({ stage: "import" });
    expect(events.some((event) => event.eventType === "plugin.enabled")).toBe(false);
  });
});

describe("P2-3 · 能力句柄拒绝审计（负向码）", () => {
  it("read/network/filesystem 与 revoked：denied 逐类携带明确错误码", () => {
    const { events, sink } = recorder();
    const handle = createPluginCapabilityHandle({
      manifest: baseManifest(),
      policy: { requireSimulationOnly: true, allowedReadScopes: [], allowedWriteScopes: [] },
      auditSink: sink
    });

    expect(() => handle.read("nope:read")).toThrow(PluginCapabilityError);
    expect(() => handle.network.request("https://example.com")).toThrow(PluginCapabilityError);
    expect(() => handle.filesystem.access("/etc/passwd")).toThrow(PluginCapabilityError);
    handle.revoke();
    expect(() => handle.read("nope:read")).toThrow(PluginCapabilityError);

    expect(events.map((event) => event.code)).toEqual([
      "CAPABILITY_READ_NOT_DECLARED",
      "CAPABILITY_NETWORK_NOT_GRANTED",
      "CAPABILITY_FILESYSTEM_NOT_GRANTED",
      "CAPABILITY_HANDLE_REVOKED"
    ]);
    expect(events.every((event) => event.eventType === "plugin.denied")).toBe(true);
    expect(events[1]?.detail).toMatchObject({ operation: "network", descriptor: "https://example.com" });
    expect(events[2]?.detail).toMatchObject({ operation: "filesystem", target: "/etc/passwd" });
  });

  it("写路径负向：simulation-only 阻断 / no-evidence / 链拒绝逐类携带对应 cause", async () => {
    const writeManifestInput = baseManifest({
      simulationOnly: false,
      readScopes: ["content:read"],
      writeScopes: ["content:write"]
    });
    const policy = {
      requireSimulationOnly: false,
      allowedReadScopes: ["content:read"],
      allowedWriteScopes: ["content:write"]
    };
    const request = { scope: "content:write", actionRef: "action:1", resourceRef: "resource:1" };
    const { events, sink } = recorder();

    // 1) simulation-only 阻断（宿主要求收紧；声明不能放宽）
    const simHandle = createPluginCapabilityHandle({
      manifest: writeManifestInput,
      policy: { ...policy, requireSimulationOnly: true },
      auditSink: sink
    });
    await expect(simHandle.write(request)).rejects.toThrow(PluginCapabilityError);

    // 2) no-evidence：resolver 返回 null
    const noEvidenceHandle = createPluginCapabilityHandle({
      manifest: writeManifestInput,
      policy,
      authorizeControlledWrite: async () => null,
      auditSink: sink
    });
    await expect(noEvidenceHandle.write(request)).rejects.toThrow(PluginCapabilityError);

    // 3) 链拒绝：resolver 有证据但链求值失败
    const chainHandle = createPluginCapabilityHandle({
      manifest: writeManifestInput,
      policy,
      authorizeControlledWrite: async () => ({}) as never,
      assertControlledWrite: () => {
        throw new Error("binding mismatch");
      },
      auditSink: sink
    });
    await expect(chainHandle.write(request)).rejects.toThrow(PluginCapabilityError);

    expect(events.map((event) => event.code)).toEqual([
      "CAPABILITY_SIMULATION_ONLY_BLOCKED",
      "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED",
      "CAPABILITY_CONTROLLED_WRITE_NOT_AUTHORIZED"
    ]);
    expect(events[1]?.detail).toMatchObject({ cause: "no-evidence" });
    expect(events[2]?.detail).toMatchObject({ cause: "binding mismatch" });
  });
});

describe("P2-3 · sink 故障永不反噬", () => {
  it("同步抛错与异步拒绝均降级为日志，启用/禁用状态机不受影响", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json");
    const syncFailures: string[] = [];
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["audit_pack"],
      auditSink: () => {
        throw new Error("sink down (sync)");
      },
      importer: async () => ({ async onLoad(): Promise<void> {}, async onEnable(): Promise<void> {} }),
      logger: (event) => {
        if (event.event === "audit") syncFailures.push(event.message);
      }
    });

    const report = await host.init();
    expect(report.activated).toBe(1);
    expect(host.getEntry("audit_pack")).toMatchObject({ state: "enabled", enabled: true });
    await expect(host.disable("audit_pack")).resolves.toMatchObject({ state: "disabled" });
    expect(syncFailures.length).toBeGreaterThan(0);

    const asyncFailures: string[] = [];
    const asyncHost = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["audit_pack"],
      auditSink: async () => {
        throw new Error("sink down (async)");
      },
      importer: async () => ({ async onLoad(): Promise<void> {}, async onEnable(): Promise<void> {} }),
      logger: (event) => {
        if (event.event === "audit") asyncFailures.push(event.message);
      }
    });
    const asyncReport = await asyncHost.init();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asyncReport.activated).toBe(1);
    expect(asyncHost.getEntry("audit_pack")).toMatchObject({ state: "enabled", enabled: true });
    expect(asyncFailures.length).toBeGreaterThan(0);
  });

  it("句柄侧：sink 抛错不改变拒绝语义（仍抛能力错误而非 sink 错误）", () => {
    const failures: string[] = [];
    const handle = createPluginCapabilityHandle({
      manifest: baseManifest(),
      policy: { requireSimulationOnly: true, allowedReadScopes: [], allowedWriteScopes: [] },
      auditSink: () => {
        throw new Error("sink down");
      },
      onAuditError: (message) => failures.push(message)
    });

    expect(() => handle.read("nope:read")).toThrow(PluginCapabilityError);
    expect(failures).toEqual(["sink down"]);
  });

  it("sink 缺省＝不落审计且不抛错（emitPluginAudit 直接语义）", () => {
    expect(() =>
      emitPluginAudit(undefined, {
        eventType: "plugin.registered",
        pluginKey: "audit_pack",
        pluginVersion: "1.0.0",
        occurredAt: new Date().toISOString()
      })
    ).not.toThrow();
  });
});
