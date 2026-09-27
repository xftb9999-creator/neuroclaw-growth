/**
 * P2-1 · PluginHost 集成证据（真实动态 import + 金丝雀文件）。
 *
 * 与单测（spy importer 计数）互补：本套件让装载器执行**真实** `import(entryPoint)`，
 * entry 模块在被求值时写入金丝雀文件。由此得到可观察的运行时证据：
 *   ① 不兼容插件 → 装载器在 import 前拒绝：其 entry 文件的金丝雀行**不存在**；
 *   ② 兼容且 allowlist → 正常装载：module-evaluated → onLoad → onEnable 依序落盘。
 *
 * 该证据对应 P1-2 验收建议（`.artifacts/impl/2026-09-27-p1-2-3.md` §4.1）：
 * 「负向用例须演示『不兼容 → import 从未发生』」。
 */
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "@neuroclaw/plugin-contract";

import { DEFAULT_HOST_API_VERSION, PluginHost, type PluginHostLogEvent } from "./plugin-host.js";

const originalCanaryEnv = process.env.PLUGIN_HOST_CANARY_FILE;
let tempRoot: string | null = null;

afterAll(async () => {
  if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  if (originalCanaryEnv === undefined) delete process.env.PLUGIN_HOST_CANARY_FILE;
  else process.env.PLUGIN_HOST_CANARY_FILE = originalCanaryEnv;
});

async function readCanary(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  };
}

function entrySource(prefix: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(process.env.PLUGIN_HOST_CANARY_FILE, "${prefix}:module-evaluated\\n");`,
    `export async function onLoad() { appendFileSync(process.env.PLUGIN_HOST_CANARY_FILE, "${prefix}:onLoad\\n"); }`,
    `export async function onEnable() { appendFileSync(process.env.PLUGIN_HOST_CANARY_FILE, "${prefix}:onEnable\\n"); }`,
    "export default { onLoad, onEnable };",
    ""
  ].join("\n");
}

describe("PluginHost · 真实 import 金丝雀（运行时证据）", () => {
  it("不兼容 → import 前拒（无金丝雀）；兼容 → 正常装载（金丝雀依序）", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "plugin-host-it-"));
    const pluginsDir = path.join(tempRoot, "plugins");
    const entriesDir = path.join(pluginsDir, "entries");
    await mkdir(entriesDir, { recursive: true });

    await writeFile(
      path.join(pluginsDir, "good.plugin.json"),
      JSON.stringify(
        manifest({
          pluginKey: "good_pack",
          hostApiRange: ">=1.0.0 <2.0.0",
          entryPoint: "./entries/good-entry.mjs"
        }),
        null,
        2
      )
    );
    await writeFile(
      path.join(pluginsDir, "bad.plugin.json"),
      JSON.stringify(
        manifest({
          pluginKey: "bad_pack",
          hostApiRange: ">=2.0.0 <3.0.0",
          entryPoint: "./entries/bad-entry.mjs"
        }),
        null,
        2
      )
    );
    await writeFile(path.join(entriesDir, "good-entry.mjs"), entrySource("good"));
    await writeFile(path.join(entriesDir, "bad-entry.mjs"), entrySource("bad"));

    const canary1 = path.join(tempRoot, "canary-1.log");
    process.env.PLUGIN_HOST_CANARY_FILE = canary1;

    const events: PluginHostLogEvent[] = [];
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir,
      enabledPluginKeys: ["good_pack", "bad_pack"],
      logger: (event) => events.push(event)
    });

    const report = await host.init();
    const goodCanary = await readCanary(canary1);
    // bad-entry 若被 import，会向同一金丝雀文件写入 "bad:" 行——精确相等即证明其从未求值。
    const badCanary = goodCanary.filter((line) => line.startsWith("bad:"));

    // ① 兼容 → 正常装载：真实 import + 两条生命周期钩子依序落盘。
    expect(goodCanary).toEqual(["good:module-evaluated", "good:onLoad", "good:onEnable"]);
    expect(host.getEntry("good_pack")).toMatchObject({ state: "enabled", enabled: true, importAttempted: true });

    // ② 不兼容 → import 前拒：无金丝雀、importAttempted=false、不进入 registry。
    expect(report).toMatchObject({ discovered: 2, registered: 1, rejected: 1, activated: 1 });
    expect(badCanary).toEqual([]);
    expect(host.getEntry("bad_pack")).toBeNull();
    expect(report.rejections.map((rejection) => rejection.pluginKey)).toEqual(["bad_pack"]);
    expect(report.rejections[0].findings.map((finding) => finding.code)).toContain(
      "HOST_API_RANGE_UNSATISFIED"
    );

    // ③ 默认关闭：空 allowlist 的新实例只注册、零 import（模块缓存下再启用才装载）。
    const canary2 = path.join(tempRoot, "canary-2.log");
    process.env.PLUGIN_HOST_CANARY_FILE = canary2;
    const host2 = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir,
      logger: (event) => events.push(event)
    });
    const report2 = await host2.init();
    expect(report2).toMatchObject({ registered: 1, activated: 0 });
    expect(host2.getEntry("good_pack")).toMatchObject({ state: "registered", enabled: false, importAttempted: false });
    expect(await readCanary(canary2)).toEqual([]);

    // 显式 enable（模块缓存命中 → 不重复求值，钩子仍执行）。
    await host2.enable("good_pack");
    expect(await readCanary(canary2)).toEqual(["good:onLoad", "good:onEnable"]);

    // 供验收线程复核的运行时证据行（stdout）。
    console.log(
      "[p2-1-evidence] " +
        JSON.stringify({
          scenario: "real-import-canary",
          goodCanary,
          badCanary,
          report: {
            discovered: report.discovered,
            registered: report.registered,
            rejected: report.rejected,
            activated: report.activated
          },
          badRejectionCodes: report.rejections[0].findings.map((finding) => finding.code),
          defaultDisabledCanary: ["good:onLoad", "good:onEnable"]
        })
    );
  });
});
