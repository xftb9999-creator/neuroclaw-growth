/**
 * P2-1 · PluginHost 装载器单测。
 * 核心判据（P1-2 下传义务）：不兼容清单在动态 import 之前被拒——本套件以
 * spy importer 计数证明「import 从未发生」（集成套件再以真实 import 金丝雀复核）。
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  PluginCompatibilityError,
  type CompatibilityFindingCode,
  type PluginManifest
} from "@neuroclaw/plugin-contract";

import {
  DEFAULT_HOST_API_VERSION,
  PluginHost,
  PluginHostError,
  resolvePluginHostConfig
} from "./plugin-host.js";

const tempDirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "plugin-host-test-"));
  tempDirs.push(dir);
  return dir;
}

async function writeManifest(
  dir: string,
  fileName: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const manifest = {
    pluginKey: "good_pack",
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

function spyImporter(): { imports: string[]; importer: (specifier: string) => Promise<unknown> } {
  const imports: string[] = [];
  return {
    imports,
    importer: async (specifier: string) => {
      imports.push(specifier);
      return {
        async onLoad(): Promise<void> {},
        async onEnable(): Promise<void> {}
      };
    }
  };
}

const silent = { logger: () => {} };

function findingCodes(host: PluginHost, file: string): CompatibilityFindingCode[] {
  const rejection = host.getReport()?.rejections.find((entry) => entry.file === file);
  return (rejection?.findings ?? []).map((finding) => finding.code);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PluginHost · 扫描与门序", () => {
  it("不兼容 hostApiRange：拒绝装载，import 从未发生（负向核心）", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "bad.plugin.json", { pluginKey: "bad_pack", hostApiRange: ">=2.0.0 <3.0.0" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["bad_pack"],
      importer,
      ...silent
    });

    const report = await host.init();

    expect(report.discovered).toBe(1);
    expect(report.registered).toBe(0);
    expect(report.rejected).toBe(1);
    expect(report.activated).toBe(0);
    expect(findingCodes(host, "bad.plugin.json")).toContain("HOST_API_RANGE_UNSATISFIED");
    // import 前拒：未经门通过的插件不得进入 registry，也不得触达 import。
    expect(host.list()).toEqual([]);
    expect(imports).toHaveLength(0);
  });

  it("兼容 + allowlist：完成 import → onLoad/onEnable，registry.list() 可见", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["good_pack"],
      importer,
      ...silent
    });

    const report = await host.init();

    expect(report).toMatchObject({ discovered: 1, registered: 1, rejected: 0, activated: 1 });
    expect(imports).toHaveLength(1);
    expect(imports[0].startsWith("file://")).toBe(true);
    expect(imports[0].endsWith("entry.mjs")).toBe(true);
    const entry = host.getEntry("good_pack");
    expect(entry).toMatchObject({ state: "enabled", enabled: true, importAttempted: true });
    expect(host.list().map((item) => item.pluginKey)).toEqual(["good_pack"]);
  });

  it("兼容但未 allowlist：只注册（enabled=false），import 不发生（默认关闭）", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      importer,
      ...silent
    });

    const report = await host.init();

    expect(report).toMatchObject({ registered: 1, rejected: 0, activated: 0 });
    expect(host.getEntry("good_pack")).toMatchObject({
      state: "registered",
      enabled: false,
      importAttempted: false
    });
    expect(imports).toHaveLength(0);
  });

  it("enable() 的单件门失败：在 import 之前抛出且 import 从未发生", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      importer,
      // 注入门接缝：模拟「注册后求值失败」——证明门在 import 之前且 fail-closed。
      verifyManifest: (): PluginManifest => {
        throw new PluginCompatibilityError("HOST_API_RANGE_UNSATISFIED", "stub gate failure");
      },
      ...silent
    });
    await host.init();

    await expect(host.enable("good_pack")).rejects.toBeInstanceOf(PluginCompatibilityError);
    expect(imports).toHaveLength(0);
    expect(host.getEntry("good_pack")).toMatchObject({
      state: "rejected",
      enabled: false,
      importAttempted: false
    });
  });

  it("损坏 JSON 文件被拒且不影响合法清单注册", async () => {
    const dir = await makeDir();
    await writeFile(path.join(dir, "broken.plugin.json"), "{ not json");
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["good_pack"],
      importer,
      ...silent
    });

    const report = await host.init();

    expect(report.discovered).toBe(2);
    expect(report.registered).toBe(1);
    expect(report.rejected).toBe(1);
    expect(findingCodes(host, "broken.plugin.json")).toContain("MANIFEST_INVALID");
    expect(imports).toHaveLength(1);
  });

  it("simulationOnly + writeScopes 越权：集合门拒绝，即使 allowlist 也不 import", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "risky.plugin.json", {
      pluginKey: "risky_pack",
      simulationOnly: true,
      writeScopes: ["content:publish"]
    });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["risky_pack"],
      importer,
      ...silent
    });

    const report = await host.init();

    expect(report.rejected).toBe(1);
    expect(findingCodes(host, "risky.plugin.json")).toContain("SIMULATION_WRITE_ESCALATION");
    expect(imports).toHaveLength(0);
  });

  it("disable → enable 状态机：onDisable 调用、模块缓存不重复 import", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const calls: string[] = [];
    const imports: string[] = [];
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["good_pack"],
      importer: async (specifier: string) => {
        imports.push(specifier);
        return {
          async onLoad(): Promise<void> {
            calls.push("onLoad");
          },
          async onEnable(): Promise<void> {
            calls.push("onEnable");
          },
          async onDisable(): Promise<void> {
            calls.push("onDisable");
          }
        };
      },
      ...silent
    });
    await host.init();

    await host.disable("good_pack");
    expect(host.getEntry("good_pack")).toMatchObject({ state: "disabled", enabled: false });

    await host.enable("good_pack");
    expect(host.getEntry("good_pack")).toMatchObject({ state: "enabled", enabled: true });
    expect(calls).toEqual(["onLoad", "onEnable", "onDisable", "onEnable"]);
    expect(imports).toHaveLength(1);

    await expect(host.disable("missing_pack")).rejects.toBeInstanceOf(PluginHostError);
  });

  it("init 幂等：重复调用不重扫、不重复 import", async () => {
    const dir = await makeDir();
    await writeManifest(dir, "good.plugin.json", { pluginKey: "good_pack" });
    const { imports, importer } = spyImporter();
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: dir,
      enabledPluginKeys: ["good_pack"],
      importer,
      ...silent
    });

    const first = await host.init();
    const second = await host.init();

    expect(second).toBe(first);
    expect(imports).toHaveLength(1);
  });

  it("目录缺失：fail-safe 空报告（dirExists=false，不抛错）", async () => {
    const host = new PluginHost({
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      pluginsDir: path.join(os.tmpdir(), "plugin-host-missing-dir-does-not-exist"),
      ...silent
    });
    const report = await host.init();
    expect(report).toMatchObject({ dirExists: false, discovered: 0, registered: 0, rejected: 0 });
  });
});

describe("resolvePluginHostConfig · 显式、默认关闭", () => {
  it("显式 env 覆盖与列表解析", () => {
    const config = resolvePluginHostConfig(
      {
        NEUROCLAW_PLUGINS_DIR: "/opt/plugins",
        NEUROCLAW_HOST_API_VERSION: "2.1.0",
        NEUROCLAW_PLUGIN_HOST_ENABLED: "a_pack, b_pack ,"
      } as NodeJS.ProcessEnv,
      "/cwd"
    );
    expect(config).toMatchObject({
      pluginsDir: "/opt/plugins",
      hostApiVersion: "2.1.0",
      enabledPluginKeys: ["a_pack", "b_pack"]
    });
  });

  it("零 env：默认目录、默认宿主版本、零 allowlist（生产默认零代码执行）", () => {
    const config = resolvePluginHostConfig({} as NodeJS.ProcessEnv, "/cwd");
    expect(config).toMatchObject({
      pluginsDir: path.resolve("/cwd", "plugins"),
      hostApiVersion: DEFAULT_HOST_API_VERSION,
      enabledPluginKeys: []
    });
  });
});
