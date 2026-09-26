import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertNoPluginRangeConflicts,
  assertSemverRange,
  buildPluginLock,
  findPluginRangeConflicts,
  getVersionMode,
  isValidSemverRange,
  semverRangeSchema,
  versionPinMatches,
  versionSatisfiesRange,
  type PluginLockInput
} from "./semver-range.js";

/**
 * P-1 / D2 acceptance: the four "假版本化 → 真版本化" criteria (B3:125-129).
 *
 * 1. `compatibilityRange` 从"字符串"变为"被解析的 Range"（S1 加性门）。
 * 2. 版本校验从 `!==` 变为 `satisfies`，默认 `strict` 行为不变；
 *    `1.2.0` 满足 `^1.0.0` 而 `2.0.0` 不满足。
 * 3. 两个插件要求不相交 range → fail-closed 拒绝装载。
 * 4. 同一份 lock 在任意机器复算出同一解析图（确定性指纹）。
 */

const VERSION_MODE_ENV = "NEUROCLAW_VERSION_MODE";
const originalVersionMode = process.env[VERSION_MODE_ENV];

afterEach(() => {
  if (originalVersionMode === undefined) {
    delete process.env[VERSION_MODE_ENV];
  } else {
    process.env[VERSION_MODE_ENV] = originalVersionMode;
  }
});

describe("P-1 semver-range: 判据 1 · compatibilityRange 真正被解析", () => {
  it("accepts parseable ranges and returns them unchanged", () => {
    expect(assertSemverRange(">=1.0.0 <2.0.0")).toBe(">=1.0.0 <2.0.0");
    expect(assertSemverRange("^1.0.0")).toBe("^1.0.0");
    expect(semverRangeSchema.parse("^1.2.3")).toBe("^1.2.3");
  });

  it("fails closed on unparseable ranges at parse sites", () => {
    expect(() => assertSemverRange("not-a-range")).toThrow("Invalid semver range");
    expect(() => assertSemverRange("=>1.0.0")).toThrow("Invalid semver range");
    expect(semverRangeSchema.safeParse("not-a-range").success).toBe(false);
  });

  it("rejects empty/whitespace input although semver treats \"\" as \"*\"", () => {
    expect(() => assertSemverRange("")).toThrow("empty range");
    expect(() => assertSemverRange("   ")).toThrow("empty range");
    expect(isValidSemverRange("")).toBe(false);
    expect(isValidSemverRange("   ")).toBe(false);
    expect(semverRangeSchema.safeParse("").success).toBe(false);
    expect(isValidSemverRange(">=1.0.0 <2.0.0")).toBe(true);
  });
});

describe("P-1 semver-range: 判据 2 · satisfies 求值，strict 为默认", () => {
  it("proves 1.2.0 satisfies ^1.0.0 while 2.0.0 does not", () => {
    expect(versionSatisfiesRange("1.2.0", "^1.0.0")).toBe(true);
    expect(versionSatisfiesRange("2.0.0", "^1.0.0")).toBe(false);
  });

  it("defaults to strict equality when NEUROCLAW_VERSION_MODE is absent or unknown", () => {
    delete process.env[VERSION_MODE_ENV];
    expect(getVersionMode()).toBe("strict");
    expect(getVersionMode({})).toBe("strict");
    expect(getVersionMode({ NEUROCLAW_VERSION_MODE: "RANGE" })).toBe("strict");
    // strict mode ignores compatibilityRange — today's behaviour byte-for-byte.
    expect(versionPinMatches("1.2.0", "1.0.0", "^1.0.0")).toBe(false);
    expect(versionPinMatches("1.0.0", "1.0.0", "^1.0.0")).toBe(true);
  });

  it("evaluates the compatibilityRange only in explicit range mode", () => {
    process.env[VERSION_MODE_ENV] = "range";
    expect(getVersionMode()).toBe("range");
    expect(versionPinMatches("1.2.0", "1.0.0", "^1.0.0")).toBe(true);
    expect(versionPinMatches("2.0.0", "1.0.0", "^1.0.0")).toBe(false);
    // No range in scope → still strict; loosening is never implicit.
    expect(versionPinMatches("1.2.0", "1.0.0")).toBe(false);
    expect(versionPinMatches("1.0.0", "1.0.0")).toBe(true);
  });

  it("fail-closes on non-semver versions or broken ranges in range mode", () => {
    process.env[VERSION_MODE_ENV] = "range";
    expect(versionPinMatches("not-a-version", "1.0.0", "^1.0.0")).toBe(false);
    expect(versionPinMatches("1.2.0", "1.0.0", "not-a-range")).toBe(false);
  });

  it("reads the mode from an injected env record (browser-safe)", () => {
    expect(getVersionMode({ NEUROCLAW_VERSION_MODE: "range" })).toBe("range");
  });
});

describe("P-1 semver-range: 判据 3 · 插件区间冲突 fail-closed", () => {
  const conflicting = [
    { id: "@lab/one", requires: { "@lab/core": "^1.0.0" } },
    { id: "@lab/two", requires: { "@lab/core": "^2.0.0" } }
  ];

  it("detects non-intersecting requirement ranges for one dependency", () => {
    const conflicts = findPluginRangeConflicts(conflicting);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      dependency: "@lab/core",
      left: { id: "@lab/one", range: "^1.0.0" },
      right: { id: "@lab/two", range: "^2.0.0" }
    });
  });

  it("reports conflicts deterministically regardless of input order", () => {
    expect(findPluginRangeConflicts([...conflicting].reverse())).toEqual(
      findPluginRangeConflicts(conflicting)
    );
  });

  it("accepts intersecting ranges and plugins without requirements", () => {
    expect(
      findPluginRangeConflicts([
        { id: "@lab/one", requires: { "@lab/core": "^1.0.0" } },
        { id: "@lab/two", requires: { "@lab/core": "~1.2.0" } },
        { id: "@lab/three" }
      ])
    ).toEqual([]);
    expect(() =>
      assertNoPluginRangeConflicts([
        { id: "@lab/one", requires: { "@lab/core": "^1.0.0" } },
        { id: "@lab/two", requires: { "@lab/core": "~1.2.0" } }
      ])
    ).not.toThrow();
  });

  it("fail-closes on conflicting or unparseable requirement ranges", () => {
    expect(() =>
      assertNoPluginRangeConflicts([
        { id: "@lab/one", requires: { "@lab/core": "^1.0.0" } },
        { id: "@lab/two", requires: { "@lab/core": "^2.0.0" } }
      ])
    ).toThrow("@lab/core");
    expect(() =>
      findPluginRangeConflicts([{ id: "@lab/one", requires: { "@lab/core": "not-a-range" } }])
    ).toThrow("Invalid semver range");
  });
});

describe("P-1 semver-range: 判据 4 · plugin lock 确定性", () => {
  const pluginOne: PluginLockInput = {
    id: "@lab/one",
    version: "1.0.0",
    requires: { "@lab/core": "^1.0.0" }
  };
  const pluginTwo: PluginLockInput = {
    id: "@lab/two",
    version: "2.1.0",
    requires: { "@lab/core": ">=2.0.0" }
  };

  it("projects the same lock for any input order on any machine", () => {
    const left = buildPluginLock([pluginOne, pluginTwo]);
    const right = buildPluginLock([pluginTwo, pluginOne]);

    expect(left).toEqual(right);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(left.lockVersion).toBe("plugin-lock.v1");
    expect(left.plugins.map((entry) => `${entry.id}@${entry.version}`)).toEqual([
      "@lab/one@1.0.0",
      "@lab/two@2.1.0"
    ]);

    // Independently recompute the fingerprint over the canonical body.
    const recomputed = createHash("sha256")
      .update(JSON.stringify({ lockVersion: left.lockVersion, plugins: left.plugins }))
      .digest("hex");
    expect(left.fingerprint).toBe(recomputed);
    expect(left.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sorts requirement keys so serialization ignores declaration order", () => {
    const lock = buildPluginLock([
      {
        id: "@lab/one",
        version: "1.0.0",
        requires: { "@lab/zeta": "^1.0.0", "@lab/alpha": "^1.0.0" }
      }
    ]);
    expect(Object.keys(lock.plugins[0]!.requires)).toEqual(["@lab/alpha", "@lab/zeta"]);
  });

  it("fail-closes on invalid plugin versions or requirement ranges", () => {
    expect(() =>
      buildPluginLock([{ id: "@lab/one", version: "1.2", requires: {} }])
    ).toThrow("invalid semver version");
    expect(() =>
      buildPluginLock([
        { id: "@lab/one", version: "1.0.0", requires: { "@lab/core": "not-a-range" } }
      ])
    ).toThrow("Invalid semver range");
  });

  it("is pure: building a lock does not mutate the input set", () => {
    const input: PluginLockInput[] = [
      { id: "@lab/one", version: "1.0.0", requires: { "@lab/core": "^1.0.0" } }
    ];
    const before = structuredClone(input);
    buildPluginLock(input);
    expect(input).toEqual(before);
  });
});
