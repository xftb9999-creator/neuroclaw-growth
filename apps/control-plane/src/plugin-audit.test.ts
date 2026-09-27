/**
 * P2-3 · 插件审计 E2E（control-plane 侧，in-memory PGlite）。
 * 链路：写清单 → init（registered/loaded/enabled）→ 越权拒绝（denied）→ disable
 * （disabled）→ 检索面查询（waitFor 收口 fire-and-forget sink 的异步落盘）。
 * 验收（plugin-roadmap.md:299）：审计记录可查且含 pluginId；负向用例产生拒绝事件。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { closeDatabase, createInMemoryDb, type Database } from "@neuroclaw/db";
import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "@neuroclaw/plugin-contract";
import { DEFAULT_HOST_API_VERSION, PluginHost } from "@neuroclaw/plugin-host";

import { listPluginAuditEvents, type PluginAuditEventRecord } from "./index.js";
import { createPluginAuditSink } from "./plugin-audit.js";

const tempDirs: string[] = [];
let db: Database | undefined;

afterEach(async () => {
  if (db) {
    await closeDatabase(db);
    db = undefined;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function waitFor(
  probe: () => Promise<PluginAuditEventRecord[] | null>,
  timeoutMs = 3000
): Promise<PluginAuditEventRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timeout: plugin audit events not persisted");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("P2-3 · 插件审计端到端", () => {
  it("init→enable→越权拒绝→disable：事件落 audit_events 且含 pluginId 可查", async () => {
    const database = await createInMemoryDb();
    db = database;

    const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-audit-e2e-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "audit_pack.plugin.json"),
      JSON.stringify(
        {
          pluginKey: "audit_pack",
          pluginVersion: "1.2.3",
          pluginKind: "PACK",
          publisherRef: "neuroclaw.internal",
          hostApiRange: ">=1.0.0 <2.0.0",
          schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
          entryPoint: "./entry.mjs",
          riskClass: "LOW",
          simulationOnly: true
        },
        null,
        2
      )
    );

    type CapturedCapabilities = {
      network: { request(descriptor: string): never };
      read(scope: string): unknown;
    };
    let captured: CapturedCapabilities | null = null;
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["audit_pack"],
      auditSink: createPluginAuditSink(database),
      logger: () => {},
      importer: async () => ({
        async onLoad(): Promise<void> {},
        async onEnable(ctx: {
          capabilities: { network: { request(descriptor: string): never }; read(scope: string): unknown };
        }): Promise<void> {
          captured = ctx.capabilities;
        }
      })
    });

    const report = await host.init();
    expect(report).toMatchObject({ registered: 1, rejected: 0, activated: 1 });
    expect(captured).not.toBeNull();

    // 负向用例：调用边界越权（网络桩 + 未声明读范围）→ denied 事件。
    const capabilities = captured as unknown as CapturedCapabilities;
    expect(() => capabilities.network.request("https://example.com")).toThrow();
    expect(() => capabilities.read("undeclared:read")).toThrow();

    await host.disable("audit_pack");

    const events = await waitFor(async () => {
      const rows = await listPluginAuditEvents(database, { pluginKey: "audit_pack" });
      return rows.length >= 6 ? rows : null;
    });

    const actions = events.map((event) => event.action);
    expect(actions).toContain("plugin.registered");
    expect(actions).toContain("plugin.loaded");
    expect(actions).toContain("plugin.enabled");
    expect(actions).toContain("plugin.denied");
    expect(actions).toContain("plugin.disabled");

    // 验收：审计记录可按 pluginKey 查询；metadata 双键含 pluginId（文档别名）。
    for (const event of events) {
      expect(event.resourceType).toBe("plugin");
      expect(event.pluginKey).toBe("audit_pack");
      expect(event.pluginId).toBe("audit_pack");
      expect(event.resourceId).toBe("audit_pack");
      expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
    }
    // 两个 denied 事件（网络桩/未声明读）可能同毫秒落盘，检索的倒序不构成稳定序：
    // 按集合断言，不依赖事件相对顺序。
    const denials = events.filter((event) => event.action === "plugin.denied");
    expect(denials.map((event) => event.code).sort()).toEqual([
      "CAPABILITY_NETWORK_NOT_GRANTED",
      "CAPABILITY_READ_NOT_DECLARED"
    ]);
    expect(
      denials.find((event) => event.code === "CAPABILITY_NETWORK_NOT_GRANTED")?.detail
    ).toMatchObject({ operation: "network" });

    // stdout 收据（人工可核证据）。
    console.log(
      "[p2-3-receipt] " +
        JSON.stringify({
          pluginId: "audit_pack",
          actions,
          codes: events.map((event) => event.code ?? null)
        })
    );
  });
});
