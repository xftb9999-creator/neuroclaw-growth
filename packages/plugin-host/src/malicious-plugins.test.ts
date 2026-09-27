/**
 * P2-4 · 恶意插件负向测试套件（五类 · 「门禁不被侵蚀的唯一可验证保证」）。
 *
 * 判据源（先核实后动笔）：
 * - `plugin.md §5` 机制 6（`.artifacts/gm-report-20260922/plugin.md:189`）：
 *   五类用例＝声明 simulationOnly 却尝试写／声明空 writeScopes 却越权／伪造
 *   hostApiRange／依赖环／清单篡改；全 fail-closed。
 * - `plugin-roadmap.md:300`（P2-4）：5 类用例全部 fail-closed，且全部纳入 CI。
 * - `p2-readiness` §1 门禁 6 / §3 阶段 5。
 *
 * 证据形态（运行时优先）：每类使用真实动态 import 的恶意夹具，entry 模块会写
 * 金丝雀/收据文件；断言分两个可观察面：
 * ① 扫描期拒绝：金丝雀文件为空（import 从未发生）+ 不进入 registry + finding 码；
 * ② 调用边界拒绝：收据含精确错误码 + 零副作用文件 + 插件状态一致。
 *
 * 与 P2-1/2/3 已覆盖项去重（本套件的增补面）：
 * - 类1：P2-1 只有「sim×writeScopes 静态拦截」的单测；本套件补「真实 import 的
 *   运行期写尝试 → CAPABILITY_SIMULATION_ONLY_BLOCKED 收据 + 静态 SIMULATION_
 *   WRITE_ESCALATION 的宿主级金丝雀证据」。
 * - 类2：P2-2 为句柄单测；本套件补真实 import 的 `CAPABILITY_WRITE_NOT_DECLARED`
 *   / `CAPABILITY_WRITE_NOT_GRANTED` 收据（需宿主放行 live 的部署形态）。
 * - 类3：P2-1 已有不兼容区间装载前拒；本套件补「注册后清单漂移 → 激活前重入
 *   校验拒绝」。
 * - 类4：依赖环 finding 以环入口为 pluginKey；装载器在 P2-4 修为「环内全部成员
 *   一并拒绝」（此前仅拒入口成员，其余成员会被注册且 requires 悬空）。
 * - 类5：补「注入未知字段/篡改必填值 → MANIFEST_INVALID」宿主级金丝雀证据，以及
 *   「扫描后磁盘清单被篡改 → vetted 快照为权威、篡改 entryPoint 从不求值」。
 *
 * CI 覆盖：`vitest.config.ts` include 覆盖递归 `*.test.ts` / `*.test.tsx`（:58）
 * ⇒ `npm test`（`vitest run`）覆盖本文件；`.github/workflows/ci.yml` "Test
 * (on Postgres 16)" 步骤即 `npm test`（:56-57）。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PLUGIN_MANIFEST_SCHEMA_VERSION } from "@neuroclaw/plugin-contract";

import {
  DEFAULT_HOST_API_VERSION,
  PluginHost,
  type PluginHostInitReport,
  type PluginHostOptions
} from "./plugin-host.js";

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// §0 夹具工具
// ---------------------------------------------------------------------------

function manifest(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    pluginVersion: "1.0.0",
    pluginKind: "PACK",
    publisherRef: "neuroclaw.internal",
    hostApiRange: ">=1.0.0 <2.0.0",
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    riskClass: "LOW",
    simulationOnly: true,
    ...overrides
  };
}

async function makePluginsDir(label: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), `p2-4-${label}-`));
  tempDirs.push(root);
  const pluginsDir = path.join(root, "plugins");
  await mkdir(pluginsDir, { recursive: true });
  return pluginsDir;
}

async function writeManifest(
  pluginsDir: string,
  fileName: string,
  overrides: Record<string, unknown>
): Promise<string> {
  const filePath = path.join(pluginsDir, fileName);
  await writeFile(filePath, JSON.stringify(manifest(overrides), null, 2));
  return filePath;
}

/** 金丝雀 entry：模块被求值/钩子被调用即向金丝雀文件追加行（未 import ⇒ 文件不存在）。 */
function canaryEntrySource(canaryPath: string, prefix: string): string {
  return [
    'import { appendFileSync } from "node:fs";',
    `const CANARY = ${JSON.stringify(canaryPath)};`,
    `appendFileSync(CANARY, ${JSON.stringify(prefix + ":module-evaluated")} + "\\n");`,
    `export async function onLoad() { appendFileSync(CANARY, ${JSON.stringify(prefix + ":onLoad")} + "\\n"); }`,
    `export async function onEnable() { appendFileSync(CANARY, ${JSON.stringify(prefix + ":onEnable")} + "\\n"); }`,
    "export default { onLoad, onEnable };",
    ""
  ].join("\n");
}

/** 越权写尝试 entry：调 capabilities.write；拒绝即写收据（精确错误码），成功则写副作用文件。 */
function writeAttemptEntrySource(options: {
  receiptPath: string;
  sideEffectPath: string;
  scope: string;
}): string {
  return [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    `const RECEIPT = ${JSON.stringify(options.receiptPath)};`,
    `const SIDE_EFFECT = ${JSON.stringify(options.sideEffectPath)};`,
    `const SCOPE = ${JSON.stringify(options.scope)};`,
    "async function attempt(ctx) {",
    "  try {",
    "    const grant = await ctx.capabilities.write({",
    "      scope: SCOPE,",
    '      actionRef: "act://p2-4/escalation",',
    '      resourceRef: "res://p2-4/record"',
    "    });",
    '    appendFileSync(SIDE_EFFECT, "WRITE-EXECUTED " + JSON.stringify(grant) + "\\n");',
    '    writeFileSync(RECEIPT, JSON.stringify({ denied: false, code: null }));',
    "  } catch (error) {",
    '    writeFileSync(RECEIPT, JSON.stringify({ denied: true, code: error && error.code ? error.code : String(error) }));',
    "  }",
    "}",
    "export async function onEnable(ctx) { await attempt(ctx); }",
    "export default { onEnable };",
    ""
  ].join("\n");
}

async function readLines(file: string): Promise<string[]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function makeHost(pluginsDir: string, overrides: Partial<PluginHostOptions> = {}): PluginHost {
  return new PluginHost({
    hostApiVersion: DEFAULT_HOST_API_VERSION,
    pluginsDir,
    logger: () => {},
    ...overrides
  });
}

function codesByFile(report: PluginHostInitReport): Record<string, string[]> {
  return Object.fromEntries(
    report.rejections.map((rejection) => [
      rejection.file,
      rejection.findings.map((finding) => finding.code)
    ])
  );
}

function logReceipt(payload: Record<string, unknown>): void {
  console.log("[p2-4-receipt] " + JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// 类1 · 声明 simulationOnly 却尝试写
// ---------------------------------------------------------------------------

describe("类1 · 声明 simulationOnly 却尝试写", () => {
  it("1a 运行期：simulationOnly 插件调用 write → CAPABILITY_SIMULATION_ONLY_BLOCKED，零副作用", async () => {
    const pluginsDir = await makePluginsDir("sim-write");
    const root = path.dirname(pluginsDir);
    const receiptPath = path.join(root, "receipt.json");
    const sideEffectPath = path.join(root, "side-effect.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    // 注意：不声明 writeScopes/sideEffects——否则先触发 1b 的扫描期静态门。
    await writeManifest(pluginsDir, "sim-writer.plugin.json", {
      pluginKey: "sim_writer",
      entryPoint: "./entries/sim-writer.mjs"
    });
    await writeFile(
      path.join(pluginsDir, "entries", "sim-writer.mjs"),
      writeAttemptEntrySource({ receiptPath, sideEffectPath, scope: "growth.notes" })
    );

    const host = makeHost(pluginsDir, { enabledPluginKeys: ["sim_writer"] });
    const report = await host.init();
    const receipt = await readJson<{ denied: boolean; code: string | null }>(receiptPath);
    const sideEffect = await readLines(sideEffectPath);

    expect(report).toMatchObject({ discovered: 1, registered: 1, rejected: 0, activated: 1 });
    expect(receipt).toMatchObject({ denied: true, code: "CAPABILITY_SIMULATION_ONLY_BLOCKED" });
    expect(sideEffect).toEqual([]);
    expect(host.getEntry("sim_writer")).toMatchObject({
      state: "enabled",
      importAttempted: true
    });
    logReceipt({ class: "1a", scenario: "simulationOnly-runtime-write", ...receipt, sideEffect: sideEffect.length });
  });

  it("1b 扫描期：simulationOnly 且 writeScopes 非空 → SIMULATION_WRITE_ESCALATION，import 从未发生", async () => {
    const pluginsDir = await makePluginsDir("sim-escalation");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "sim-escalator.plugin.json", {
      pluginKey: "sim_escalator",
      entryPoint: "./entries/sim-escalator.mjs",
      writeScopes: ["growth.notes"]
    });
    await writeFile(
      path.join(pluginsDir, "entries", "sim-escalator.mjs"),
      canaryEntrySource(canaryPath, "sim_escalator")
    );

    const host = makeHost(pluginsDir, { enabledPluginKeys: ["sim_escalator"] });
    const report = await host.init();
    const canary = await readLines(canaryPath);
    const codes = codesByFile(report);

    expect(report).toMatchObject({ discovered: 1, registered: 0, rejected: 1, activated: 0 });
    expect(codes["sim-escalator.plugin.json"]).toContain("SIMULATION_WRITE_ESCALATION");
    expect(canary).toEqual([]);
    expect(host.getEntry("sim_escalator")).toBeNull();
    logReceipt({ class: "1b", scenario: "simulationOnly-static-escalation", codes: codes["sim-escalator.plugin.json"], canary: canary.length });
  });
});

// ---------------------------------------------------------------------------
// 类2 · 声明空 writeScopes 却越权
// ---------------------------------------------------------------------------

describe("类2 · 声明空 writeScopes 却越权", () => {
  it("2a 运行期：空 writeScopes 调用 write → CAPABILITY_WRITE_NOT_DECLARED，零副作用", async () => {
    const pluginsDir = await makePluginsDir("empty-write");
    const root = path.dirname(pluginsDir);
    const receiptPath = path.join(root, "receipt.json");
    const sideEffectPath = path.join(root, "side-effect.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    // 需要宿主放行 live 部署（requireSimulationOnly=false）才能到达运行期声明检查
    // ——这正是「空 writeScopes 越权」被调用边界拦住的场景。
    await writeManifest(pluginsDir, "empty-writer.plugin.json", {
      pluginKey: "empty_writer",
      entryPoint: "./entries/empty-writer.mjs",
      simulationOnly: false
    });
    await writeFile(
      path.join(pluginsDir, "entries", "empty-writer.mjs"),
      writeAttemptEntrySource({ receiptPath, sideEffectPath, scope: "growth.notes" })
    );

    const host = makeHost(pluginsDir, {
      enabledPluginKeys: ["empty_writer"],
      capabilityPolicy: { requireSimulationOnly: false }
    });
    const report = await host.init();
    const receipt = await readJson<{ denied: boolean; code: string | null }>(receiptPath);
    const sideEffect = await readLines(sideEffectPath);

    expect(report).toMatchObject({ discovered: 1, registered: 1, rejected: 0, activated: 1 });
    expect(receipt).toMatchObject({ denied: true, code: "CAPABILITY_WRITE_NOT_DECLARED" });
    expect(sideEffect).toEqual([]);
    logReceipt({ class: "2a", scenario: "empty-writeScopes-runtime", ...receipt, sideEffect: sideEffect.length });
  });

  it("2b 运行期：已声明但宿主未授予 → CAPABILITY_WRITE_NOT_GRANTED（求交）", async () => {
    const pluginsDir = await makePluginsDir("ungranted-write");
    const root = path.dirname(pluginsDir);
    const receiptPath = path.join(root, "receipt.json");
    const sideEffectPath = path.join(root, "side-effect.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "declared-ungranted.plugin.json", {
      pluginKey: "declared_ungranted",
      entryPoint: "./entries/declared-ungranted.mjs",
      simulationOnly: false,
      writeScopes: ["growth.notes"]
    });
    await writeFile(
      path.join(pluginsDir, "entries", "declared-ungranted.mjs"),
      writeAttemptEntrySource({ receiptPath, sideEffectPath, scope: "growth.notes" })
    );

    const host = makeHost(pluginsDir, {
      enabledPluginKeys: ["declared_ungranted"],
      capabilityPolicy: { requireSimulationOnly: false, allowedWriteScopes: [] }
    });
    const report = await host.init();
    const receipt = await readJson<{ denied: boolean; code: string | null }>(receiptPath);
    const sideEffect = await readLines(sideEffectPath);

    expect(report).toMatchObject({ discovered: 1, registered: 1, rejected: 0, activated: 1 });
    expect(receipt).toMatchObject({ denied: true, code: "CAPABILITY_WRITE_NOT_GRANTED" });
    expect(sideEffect).toEqual([]);
    logReceipt({ class: "2b", scenario: "declared-but-not-granted", ...receipt, sideEffect: sideEffect.length });
  });
});

// ---------------------------------------------------------------------------
// 类3 · 伪造 hostApiRange
// ---------------------------------------------------------------------------

describe("类3 · 伪造 hostApiRange", () => {
  it("3a 扫描期：伪造兼容区间（^99.0.0）→ HOST_API_RANGE_UNSATISFIED，import 从未发生", async () => {
    const pluginsDir = await makePluginsDir("forged-range");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "forged-range.plugin.json", {
      pluginKey: "forged_range",
      entryPoint: "./entries/forged-range.mjs",
      hostApiRange: "^99.0.0"
    });
    await writeFile(
      path.join(pluginsDir, "entries", "forged-range.mjs"),
      canaryEntrySource(canaryPath, "forged_range")
    );

    const host = makeHost(pluginsDir, { enabledPluginKeys: ["forged_range"] });
    const report = await host.init();
    const canary = await readLines(canaryPath);
    const codes = codesByFile(report);

    expect(report).toMatchObject({ discovered: 1, registered: 0, rejected: 1, activated: 0 });
    expect(codes["forged-range.plugin.json"]).toContain("HOST_API_RANGE_UNSATISFIED");
    expect(canary).toEqual([]);
    expect(host.getEntry("forged_range")).toBeNull();
    logReceipt({ class: "3a", scenario: "forged-hostApiRange", codes: codes["forged-range.plugin.json"], canary: canary.length });
  });

  it("3b 注册后漂移：清单 hostApiRange 被改为伪造区间 → 激活前重入校验拒绝，import 从未发生", async () => {
    const pluginsDir = await makePluginsDir("drift-range");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "drift-pack.plugin.json", {
      pluginKey: "drift_pack",
      entryPoint: "./entries/drift-pack.mjs"
    });
    await writeFile(
      path.join(pluginsDir, "entries", "drift-pack.mjs"),
      canaryEntrySource(canaryPath, "drift_pack")
    );

    const host = makeHost(pluginsDir);
    const report = await host.init();
    expect(report).toMatchObject({ registered: 1, activated: 0 });

    // 模拟注册后清单漂移/被篡改（宿主快照暴露同一清单引用；装载器承诺激活前重入校验）。
    const registered = host.getEntry("drift_pack");
    expect(registered).toMatchObject({ state: "registered", importAttempted: false });
    registered!.manifest!.hostApiRange = "^99.0.0";

    await expect(host.enable("drift_pack")).rejects.toMatchObject({
      code: "HOST_API_RANGE_UNSATISFIED"
    });
    const canary = await readLines(canaryPath);
    expect(host.getEntry("drift_pack")).toMatchObject({
      state: "rejected",
      enabled: false,
      importAttempted: false
    });
    expect(canary).toEqual([]);
    logReceipt({ class: "3b", scenario: "post-registration-drift", importAttempted: false, canary: canary.length });
  });
});

// ---------------------------------------------------------------------------
// 类4 · 依赖环
// ---------------------------------------------------------------------------

describe("类4 · 依赖环", () => {
  it("4a 扫描期：两节点环 → 环内全部成员拒绝（DEPENDENCY_CYCLE），零 import", async () => {
    const pluginsDir = await makePluginsDir("cycle");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "cycle-a.plugin.json", {
      pluginKey: "cycle_a",
      entryPoint: "./entries/cycle-a.mjs",
      requires: [{ pluginKey: "cycle_b", versionRange: "^1.0.0" }]
    });
    await writeManifest(pluginsDir, "cycle-b.plugin.json", {
      pluginKey: "cycle_b",
      entryPoint: "./entries/cycle-b.mjs",
      requires: [{ pluginKey: "cycle_a", versionRange: "^1.0.0" }]
    });
    await writeFile(path.join(pluginsDir, "entries", "cycle-a.mjs"), canaryEntrySource(canaryPath, "cycle_a"));
    await writeFile(path.join(pluginsDir, "entries", "cycle-b.mjs"), canaryEntrySource(canaryPath, "cycle_b"));

    const host = makeHost(pluginsDir, { enabledPluginKeys: ["cycle_a", "cycle_b"] });
    const report = await host.init();
    const canary = await readLines(canaryPath);
    const codes = codesByFile(report);

    expect(report).toMatchObject({ discovered: 2, registered: 0, rejected: 2, activated: 0 });
    // 环 finding 由集合门产出（以环入口为 pluginKey）；装载器必须把环内**全部**
    // 成员一并拒绝——只拒入口成员会让其余成员带悬空 requires 进入 registry。
    expect(codes["cycle-a.plugin.json"]).toContain("DEPENDENCY_CYCLE");
    expect(codes["cycle-b.plugin.json"]).toContain("DEPENDENCY_CYCLE");
    expect(report.findings.filter((finding) => finding.code === "DEPENDENCY_CYCLE").length).toBeGreaterThanOrEqual(1);
    expect(host.getEntry("cycle_a")).toBeNull();
    expect(host.getEntry("cycle_b")).toBeNull();
    expect(canary).toEqual([]);
    logReceipt({ class: "4a", scenario: "two-node-cycle", codes, canary: canary.length });
  });

  it("4b 扫描期：自环（requires 自身）→ DEPENDENCY_CYCLE，零 import", async () => {
    const pluginsDir = await makePluginsDir("self-cycle");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    await writeManifest(pluginsDir, "self-loop.plugin.json", {
      pluginKey: "self_loop",
      entryPoint: "./entries/self-loop.mjs",
      requires: [{ pluginKey: "self_loop", versionRange: "^1.0.0" }]
    });
    await writeFile(path.join(pluginsDir, "entries", "self-loop.mjs"), canaryEntrySource(canaryPath, "self_loop"));

    const host = makeHost(pluginsDir, { enabledPluginKeys: ["self_loop"] });
    const report = await host.init();
    const canary = await readLines(canaryPath);

    expect(report).toMatchObject({ discovered: 1, registered: 0, rejected: 1, activated: 0 });
    expect(codesByFile(report)["self-loop.plugin.json"]).toContain("DEPENDENCY_CYCLE");
    expect(canary).toEqual([]);
    expect(host.getEntry("self_loop")).toBeNull();
    logReceipt({ class: "4b", scenario: "self-cycle", canary: canary.length });
  });
});

// ---------------------------------------------------------------------------
// 类5 · 清单篡改
// ---------------------------------------------------------------------------

describe("类5 · 清单篡改", () => {
  it("5a 扫描期：注入未知字段/篡改必填值 → MANIFEST_INVALID，import 从未发生", async () => {
    const pluginsDir = await makePluginsDir("tampered-shape");
    const root = path.dirname(pluginsDir);
    const canaryPath = path.join(root, "canary.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    // (i) 注入未知字段（.strict() 拒收）；(ii) 篡改 pluginVersion 为非法 semver。
    await writeManifest(pluginsDir, "tampered-unknown.plugin.json", {
      pluginKey: "tampered_unknown",
      entryPoint: "./entries/tampered-unknown.mjs",
      hiddenWrite: true
    });
    await writeManifest(pluginsDir, "tampered-version.plugin.json", {
      pluginKey: "tampered_version",
      entryPoint: "./entries/tampered-version.mjs",
      pluginVersion: "not-semver"
    });
    await writeFile(
      path.join(pluginsDir, "entries", "tampered-unknown.mjs"),
      canaryEntrySource(canaryPath, "tampered_unknown")
    );
    await writeFile(
      path.join(pluginsDir, "entries", "tampered-version.mjs"),
      canaryEntrySource(canaryPath, "tampered_version")
    );

    const host = makeHost(pluginsDir, {
      enabledPluginKeys: ["tampered_unknown", "tampered_version"]
    });
    const report = await host.init();
    const canary = await readLines(canaryPath);
    const codes = codesByFile(report);

    expect(report).toMatchObject({ discovered: 2, registered: 0, rejected: 2, activated: 0 });
    expect(codes["tampered-unknown.plugin.json"]).toContain("MANIFEST_INVALID");
    expect(codes["tampered-version.plugin.json"]).toContain("MANIFEST_INVALID");
    expect(canary).toEqual([]);
    expect(host.getEntry("tampered_unknown")).toBeNull();
    expect(host.getEntry("tampered_version")).toBeNull();
    logReceipt({ class: "5a", scenario: "schema-tamper", codes, canary: canary.length });
  });

  it("5b 扫描后磁盘篡改：vetted 快照为权威，篡改的 entryPoint 从不求值", async () => {
    const pluginsDir = await makePluginsDir("disk-tamper");
    const root = path.dirname(pluginsDir);
    const goodCanary = path.join(root, "good.log");
    const evilCanary = path.join(root, "evil.log");
    await mkdir(path.join(pluginsDir, "entries"), { recursive: true });
    const manifestPath = await writeManifest(pluginsDir, "disk-tamper.plugin.json", {
      pluginKey: "disk_tamper",
      entryPoint: "./entries/good.mjs"
    });
    await writeFile(path.join(pluginsDir, "entries", "good.mjs"), canaryEntrySource(goodCanary, "disk_tamper"));
    await writeFile(path.join(pluginsDir, "entries", "evil.mjs"), canaryEntrySource(evilCanary, "evil"));

    const host = makeHost(pluginsDir);
    const report = await host.init();
    expect(report).toMatchObject({ registered: 1, activated: 0 });

    // 扫描后篡改磁盘清单：entryPoint 改指恶意模块（保持 schema 合法）。
    // 快照权威语义 ⇒ 篡改不改变运行路径；签名级篡改检测属 P5-1 边界（不在本批）。
    await writeFile(
      manifestPath,
      JSON.stringify(
        manifest({
          pluginKey: "disk_tamper",
          entryPoint: "./entries/evil.mjs"
        }),
        null,
        2
      )
    );

    const entry = await host.enable("disk_tamper");
    const good = await readLines(goodCanary);
    const evil = await readLines(evilCanary);

    expect(entry).toMatchObject({ state: "enabled", enabled: true, importAttempted: true });
    expect(entry.manifest!.entryPoint).toBe("./entries/good.mjs");
    expect(good).toEqual(["disk_tamper:module-evaluated", "disk_tamper:onLoad", "disk_tamper:onEnable"]);
    expect(evil).toEqual([]);
    logReceipt({ class: "5b", scenario: "disk-tamper-snapshot-authority", good, evil, entryPoint: entry.manifest!.entryPoint });
  });
});
