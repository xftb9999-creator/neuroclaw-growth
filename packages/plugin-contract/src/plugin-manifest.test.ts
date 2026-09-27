/**
 * P-1.1 · PluginManifest 契约测试（正例 + 负例）。
 * 规格：plugin.md §3.1 L73-110；验收（plugin-roadmap.md:285）：
 * 未知字段被拒；hostApiRange 缺失被拒。
 */
import { describe, expect, it } from "vitest";
import {
  PLUGIN_MANIFEST_SCHEMA_VERSION,
  parsePluginManifest,
  pluginManifestSchema
} from "./index.js";

/** 最小合法清单（依赖/权限/证据组走默认或缺省）。 */
const baseManifest = {
  pluginKey: "growth_pack_pilot",
  pluginVersion: "1.0.0",
  pluginKind: "PACK",
  publisherRef: "neuroclaw.internal",
  hostApiRange: ">=1.0.0 <2.0.0",
  schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
  entryPoint: "./dist/index.js",
  riskClass: "LOW",
  simulationOnly: true
};

/** 复制 baseManifest 并剔除指定键（构造缺失字段负例）。 */
function without(keys: string[]): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...baseManifest };
  for (const key of keys) delete clone[key];
  return clone;
}

describe("pluginManifestSchema 正例（七组）", () => {
  it("最小清单通过校验，且缺省键位填充为默认（权限默认拒绝）", () => {
    const parsed = pluginManifestSchema.parse(baseManifest);
    expect(parsed.pluginKey).toBe("growth_pack_pilot");
    expect(parsed.pluginVersion).toBe("1.0.0");
    expect(parsed.hostApiRange).toBe(">=1.0.0 <2.0.0");
    expect(parsed.schemaVersion).toBe(PLUGIN_MANIFEST_SCHEMA_VERSION);
    expect(parsed.requires).toEqual([]);
    expect(parsed.conflicts).toEqual([]);
    expect(parsed.provides).toEqual([]);
    expect(parsed.readScopes).toEqual([]);
    expect(parsed.writeScopes).toEqual([]);
    expect(parsed.authRequirements).toEqual([]);
    expect(parsed.sideEffects).toEqual([]);
  });

  it("完整七组清单通过校验（依赖/权限/生命周期/入口/证据全给）", () => {
    const parsed = pluginManifestSchema.parse({
      ...baseManifest,
      pluginKind: "ADAPTER",
      requires: [{ pluginKey: "growth_core", versionRange: "^1.0.0" }],
      conflicts: [{ pluginKey: "growth_legacy", versionRange: "<0.9.0" }],
      provides: ["capability.publish_post"],
      readScopes: ["metrics_read"],
      writeScopes: ["draft_write"],
      authRequirements: ["oauth_channel"],
      sideEffects: ["network_outbound"],
      riskClass: "MEDIUM",
      hooks: { onLoad: "./hooks/on-load.js", onUninstall: "./hooks/on-uninstall.js" },
      healthCheck: "./hooks/health.js",
      readinessCheck: "./hooks/readiness.js",
      rollbackPlan: "./hooks/rollback.js",
      evidenceRequirements: ["E2"],
      localizationRefs: ["zh-CN"],
      frontendModuleRegistry: ["growth.dashboard"]
    });
    expect(parsed.requires[0]?.pluginKey).toBe("growth_core");
    expect(parsed.hooks?.onLoad).toBe("./hooks/on-load.js");
    expect(parsed.rollbackPlan).toBe("./hooks/rollback.js");
  });

  it("parsePluginManifest 返回同一语义对象（canonical 入口）", () => {
    const parsed = parsePluginManifest(baseManifest);
    expect(parsed.entryPoint).toBe("./dist/index.js");
  });
});

describe("pluginManifestSchema 负例（拒收，fail-closed）", () => {
  it("未知顶层字段被拒（.strict()）", () => {
    const result = pluginManifestSchema.safeParse({ ...baseManifest, unknownField: true });
    expect(result.success).toBe(false);
  });

  it("缺失 hostApiRange 被拒（验收硬点）", () => {
    const result = pluginManifestSchema.safeParse(without(["hostApiRange"]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("hostApiRange"))).toBe(true);
    }
  });

  it("非法 / 空 hostApiRange 被拒", () => {
    expect(
      pluginManifestSchema.safeParse({ ...baseManifest, hostApiRange: "not-a-range" }).success
    ).toBe(false);
    expect(pluginManifestSchema.safeParse({ ...baseManifest, hostApiRange: "" }).success).toBe(
      false
    );
  });

  it("pluginKey 非 snake_case 被拒（复用 integrationProjectKeySchema）", () => {
    expect(
      pluginManifestSchema.safeParse({ ...baseManifest, pluginKey: "Growth-Pack" }).success
    ).toBe(false);
  });

  it("pluginVersion 非 semver 被拒", () => {
    expect(pluginManifestSchema.safeParse({ ...baseManifest, pluginVersion: "1.0" }).success).toBe(
      false
    );
  });

  it("schemaVersion 非当前清单版本被拒（legacy 值不被接受）", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...baseManifest,
        schemaVersion: "plugin.neuroclaw.v1"
      }).success
    ).toBe(false);
  });

  it("pluginKind 非法枚举值被拒", () => {
    expect(pluginManifestSchema.safeParse({ ...baseManifest, pluginKind: "SERVICE" }).success).toBe(
      false
    );
  });

  it("缺失 riskClass / simulationOnly 被拒（安全字段必须显式）", () => {
    expect(pluginManifestSchema.safeParse(without(["riskClass"])).success).toBe(false);
    expect(pluginManifestSchema.safeParse(without(["simulationOnly"])).success).toBe(false);
  });

  it("requires 条目缺 versionRange 被拒", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...baseManifest,
        requires: [{ pluginKey: "growth_core" }]
      }).success
    ).toBe(false);
  });

  it("hooks 未知键被拒（嵌套 .strict()）", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...baseManifest,
        hooks: { onLoad: "./hooks/on-load.js", onBeforeInstall: "./hooks/x.js" }
      }).success
    ).toBe(false);
  });

  it("parsePluginManifest 对非法输入抛错（fail-closed）", () => {
    expect(() => parsePluginManifest({})).toThrow();
  });
});
