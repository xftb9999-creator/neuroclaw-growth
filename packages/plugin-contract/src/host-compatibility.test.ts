/**
 * P1-2 · 装载前 semver 强制求值测试（正例 + 负例 + 装载前门序演示）。
 * 验收（plugin-roadmap.md:286）：不兼容区间在装载前 fail-closed；
 * compatibilityRange 真正求值（不受 NEUROCLAW_VERSION_MODE 开关影响）。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  PluginCompatibilityError,
  assertCompatibilityRange,
  assertHostApiCompatible,
  evaluateCompatibilityRange,
  evaluateHostApiCompatibility,
  verifyPluginManifestSet
} from "./host-compatibility.js";
import { PLUGIN_MANIFEST_SCHEMA_VERSION, type PluginManifest } from "./plugin-manifest.js";

/** 最小合法清单（同 P1-1 测试基准；依赖/权限组走默认）。 */
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

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...baseManifest, ...overrides };
}

/** 捕获 fail-closed 错误的分类码。 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PluginCompatibilityError) return error.code;
    throw error;
  }
  throw new Error("expected PluginCompatibilityError, nothing was thrown");
}

describe("§1 hostApiRange 单件门", () => {
  it("宿主版本落在 hostApiRange 内：通过并返回已解析清单", () => {
    const parsed = assertHostApiCompatible(manifest(), "1.5.0");
    expect(parsed.pluginKey).toBe("growth_pack_pilot");
    expect(parsed.hostApiRange).toBe(">=1.0.0 <2.0.0");
  });

  it("不兼容区间：装载前 fail-closed（负向硬点）", () => {
    const incompatible = manifest({ hostApiRange: ">=2.0.0 <3.0.0" });
    expect(evaluateHostApiCompatibility("1.5.0", ">=2.0.0 <3.0.0")).toBe(false);
    expect(codeOf(() => assertHostApiCompatible(incompatible, "1.5.0"))).toBe(
      "HOST_API_RANGE_UNSATISFIED"
    );
    try {
      assertHostApiCompatible(incompatible, "1.5.0");
    } catch (error) {
      expect((error as Error).message).toContain(">=2.0.0 <3.0.0");
      expect((error as Error).message).toContain("1.5.0");
    }
  });

  it("宿主 API 版本非法：fail-closed（绝不默认放行）", () => {
    expect(codeOf(() => assertHostApiCompatible(manifest(), "not-a-version"))).toBe(
      "HOST_API_VERSION_INVALID"
    );
  });

  it("清单本身非法（未知字段 / 缺失 hostApiRange）：fail-closed", () => {
    expect(codeOf(() => assertHostApiCompatible(manifest({ backdoor: true }), "1.5.0"))).toBe(
      "MANIFEST_INVALID"
    );
    const withoutRange = manifest();
    delete withoutRange.hostApiRange;
    expect(codeOf(() => assertHostApiCompatible(withoutRange, "1.5.0"))).toBe("MANIFEST_INVALID");
  });

  it("装载前门序：不兼容清单一律在 load 之前被拒（P1-2 核心演示）", () => {
    const loaded: string[] = [];
    // 演示装载器约定：gate 必须在 load（占位动态 import(entryPoint)）之前。
    const attemptLoad = (input: unknown, hostApiVersion: string): PluginManifest => {
      const parsed = assertHostApiCompatible(input, hostApiVersion); // ← gate FIRST
      loaded.push(parsed.pluginKey); // ← stands for import(entryPoint)
      return parsed;
    };

    expect(() => attemptLoad(manifest({ hostApiRange: ">=3.0.0" }), "1.5.0")).toThrow(
      PluginCompatibilityError
    );
    expect(loaded).toEqual([]); // load 从未发生

    attemptLoad(manifest(), "1.5.0");
    expect(loaded).toEqual(["growth_pack_pilot"]); // 兼容清单才到达 load
  });
});

describe("§2 compatibilityRange 无条件门（不受 NEUROCLAW_VERSION_MODE 影响）", () => {
  const previousMode = process.env.NEUROCLAW_VERSION_MODE;

  afterEach(() => {
    if (previousMode === undefined) delete process.env.NEUROCLAW_VERSION_MODE;
    else process.env.NEUROCLAW_VERSION_MODE = previousMode;
  });

  it("即使开关处于 strict（versionPinMatches 不求值的模式）本门仍真实求值", () => {
    process.env.NEUROCLAW_VERSION_MODE = "strict";
    expect(evaluateCompatibilityRange("1.2.0", ">=1.0.0 <2.0.0")).toBe(true);
    expect(evaluateCompatibilityRange("2.0.0", ">=1.0.0 <2.0.0")).toBe(false);
    expect(codeOf(() => assertCompatibilityRange("2.0.0", ">=1.0.0 <2.0.0", "growth_pack"))).toBe(
      "COMPATIBILITY_UNSATISFIED"
    );
    expect(() => assertCompatibilityRange("1.2.0", ">=1.0.0 <2.0.0", "growth_pack")).not.toThrow();
  });

  it("非法区间 / 空区间：fail-closed（false 或抛错，绝不静默放行）", () => {
    expect(evaluateCompatibilityRange("1.2.0", "not-a-range")).toBe(false);
    expect(evaluateCompatibilityRange("1.2.0", "")).toBe(false);
    expect(codeOf(() => assertCompatibilityRange("1.2.0", "not-a-range"))).toBe(
      "COMPATIBILITY_RANGE_INVALID"
    );
    expect(codeOf(() => assertCompatibilityRange("1.2.0", ""))).toBe("COMPATIBILITY_RANGE_INVALID");
  });
});

describe("§3 集合门 verifyPluginManifestSet", () => {
  const hostApiVersion = "1.5.0";

  it("合法集合：ok=true、findings 为空（CLI 退出 0 语义）", () => {
    const provider = manifest({ pluginKey: "growth_core", pluginVersion: "1.0.0" });
    const consumer = manifest({
      pluginKey: "growth_pack_pilot",
      requires: [{ pluginKey: "growth_core", versionRange: "^1.0.0" }]
    });
    const report = verifyPluginManifestSet([consumer, provider], { hostApiVersion });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.valid).toHaveLength(2);
  });

  it("依赖环：fail-closed（负向硬点）", () => {
    const a = manifest({
      pluginKey: "cycle_a",
      requires: [{ pluginKey: "cycle_b", versionRange: "^1.0.0" }]
    });
    const b = manifest({
      pluginKey: "cycle_b",
      requires: [{ pluginKey: "cycle_a", versionRange: "^1.0.0" }]
    });
    const report = verifyPluginManifestSet([a, b], { hostApiVersion });
    expect(report.ok).toBe(false);
    const cycles = report.findings.filter((finding) => finding.code === "DEPENDENCY_CYCLE");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain("cycle_a -> cycle_b -> cycle_a");
  });

  it("自依赖环：fail-closed", () => {
    const selfLoop = manifest({
      pluginKey: "self_loop",
      requires: [{ pluginKey: "self_loop", versionRange: "^1.0.0" }]
    });
    const report = verifyPluginManifestSet([selfLoop], { hostApiVersion });
    expect(report.ok).toBe(false);
    const cycles = report.findings.filter((finding) => finding.code === "DEPENDENCY_CYCLE");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]?.message).toContain("self_loop -> self_loop");
  });

  it("缺失依赖 / 集合内版本不满足：fail-closed", () => {
    const missing = manifest({
      pluginKey: "needs_ghost",
      requires: [{ pluginKey: "ghost_core", versionRange: "^1.0.0" }]
    });
    const reportMissing = verifyPluginManifestSet([missing], { hostApiVersion });
    expect(reportMissing.ok).toBe(false);
    expect(reportMissing.findings.some((f) => f.code === "MISSING_DEPENDENCY")).toBe(true);

    const provider = manifest({ pluginKey: "growth_core", pluginVersion: "1.0.0" });
    const mismatched = manifest({
      pluginKey: "needs_old_core",
      requires: [{ pluginKey: "growth_core", versionRange: "<0.9.0" }]
    });
    const reportMismatch = verifyPluginManifestSet([provider, mismatched], { hostApiVersion });
    expect(reportMismatch.ok).toBe(false);
    expect(
      reportMismatch.findings.some((f) => f.code === "DEPENDENCY_VERSION_UNSATISFIED")
    ).toBe(true);
  });

  it("重复 pluginKey：fail-closed", () => {
    const v1 = manifest({ pluginKey: "growth_core", pluginVersion: "1.0.0" });
    const v2 = manifest({ pluginKey: "growth_core", pluginVersion: "2.0.0" });
    const report = verifyPluginManifestSet([v1, v2], { hostApiVersion });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === "DUPLICATE_PLUGIN_KEY")).toBe(true);
  });

  it("冲突声明命中：fail-closed；区间不命中则通过", () => {
    const legacy = manifest({ pluginKey: "growth_legacy", pluginVersion: "1.5.0" });
    const blocker = manifest({
      pluginKey: "growth_pack_pilot",
      conflicts: [{ pluginKey: "growth_legacy", versionRange: "<2.0.0" }]
    });
    const hit = verifyPluginManifestSet([blocker, legacy], { hostApiVersion });
    expect(hit.ok).toBe(false);
    expect(hit.findings.some((f) => f.code === "CONFLICT_PRESENT")).toBe(true);

    const newer = manifest({ pluginKey: "growth_legacy", pluginVersion: "2.5.0" });
    const miss = verifyPluginManifestSet([blocker, newer], { hostApiVersion });
    expect(miss.findings.some((f) => f.code === "CONFLICT_PRESENT")).toBe(false);
  });

  it("simulationOnly 越权（writeScopes / sideEffects 非空）：装载前拒（P1-3「越权」用例）", () => {
    const escalation = manifest({ writeScopes: ["external:write"] });
    const report = verifyPluginManifestSet([escalation], { hostApiVersion });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.code === "SIMULATION_WRITE_ESCALATION")).toBe(true);

    const sideEffect = manifest({ sideEffects: ["network_outbound"] });
    const reportSide = verifyPluginManifestSet([sideEffect], { hostApiVersion });
    expect(reportSide.findings.some((f) => f.code === "SIMULATION_WRITE_ESCALATION")).toBe(true);

    // 非 simulationOnly 清单声明 writeScopes 是合法形状（运行期 CONTROLLED_WRITE 属 P2-2）。
    const live = manifest({ simulationOnly: false, writeScopes: ["draft_write"] });
    const reportLive = verifyPluginManifestSet([live], { hostApiVersion });
    expect(reportLive.ok).toBe(true);
  });

  it("集合中宿主不兼容项：被拒且不计入 valid（附输入序号）", () => {
    const ok = manifest({ pluginKey: "growth_core" });
    const bad = manifest({ pluginKey: "future_core", hostApiRange: ">=9.0.0" });
    const report = verifyPluginManifestSet([ok, bad], { hostApiVersion });
    expect(report.ok).toBe(false);
    expect(report.valid.map((m) => m.pluginKey)).toEqual(["growth_core"]);
    const hostFinding = report.findings.find((f) => f.code === "HOST_API_RANGE_UNSATISFIED");
    expect(hostFinding?.detail?.index).toBe(1);
  });

  it("集合中形状非法项：MANIFEST_INVALID 附输入序号（CLI 篡改用例内核）", () => {
    const report = verifyPluginManifestSet([manifest(), { pluginKey: "tampered" }], {
      hostApiVersion
    });
    expect(report.ok).toBe(false);
    const invalid = report.findings.find((f) => f.code === "MANIFEST_INVALID");
    expect(invalid?.detail?.index).toBe(1);
  });
});
