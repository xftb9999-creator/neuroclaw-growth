import { describe, expect, it } from "vitest";

import {
  LEGACY_PLUGIN_SCHEMA_VERSION,
  parseLegacyPluginManifest,
  legacyPluginManifestSchema
} from "./plugin-manifest.js";

/**
 * Legacy dialect acceptance (B3 §D1): PluginManifest 的 fail-closed 硬约束。
 *
 * 该方言于 2026-09-27 退役（GM 裁定 Option A；`plugin.md §3.1` 为唯一权威方言）；
 * 符号已加 `legacy`/`Legacy` 前缀。本文件仅覆盖 legacy schema 自身行为，
 * 新功能测试应针对 `@neuroclaw/plugin-contract`（P1-1）。
 *
 * - `.strict()`：未知字段一律拒绝（契约冻结点）；
 * - D1.4-1：`capabilities.provides` 必须可兑现（mcp tool 名或 skill/pack 的
 *   `capabilityRefs`）；
 * - D1.4-2：`sideEffects ≠ ["none"]` 禁止 `sandbox.isolation: "in-process"`；
 * - S1：`version` / `requires.hostApi` / `requires.plugins` 走真 semver 解析。
 */

const validManifest = () => ({
  schemaVersion: LEGACY_PLUGIN_SCHEMA_VERSION,
  id: "@neuroclaw/example-adapter",
  version: "1.2.3",
  kind: "mcp-server",
  mcp: {
    transport: "stdio",
    command: "node",
    declares: {
      tools: [{ name: "tool_read", description: "Reads things", inputSchema: {} }]
    }
  },
  capabilities: { layer: "L4", provides: ["tool_read"] },
  requires: { hostApi: "^1.0.0" },
  permissions: {
    scopes: { read: ["project:read"], write: [] },
    sideEffects: ["none"],
    credentials: [],
    quota: { maxInvocationsPerRun: 100, maxWallClockMs: 5000, maxNetworkBytes: 0 }
  },
  sandbox: { isolation: "in-process", network: { mode: "none" }, env: { allow: [] } },
  evidence: { level: "E3", refs: ["fixture"] }
});

const skillManifest = () => ({
  ...validManifest(),
  kind: "skill",
  capabilities: { layer: "L1", provides: ["cap_read"] },
  capabilityRefs: ["cap_read"],
  skill: {
    skillMd: "SKILL.md",
    name: "example",
    description: "Example skill",
    disclosure: { level1: "frontmatter", level2: "body", level3: "references" }
  }
});

describe("P-1 plugin manifest: 基线与默认值", () => {
  it("parses a redeemable mcp-server manifest and applies defaults", () => {
    const manifest = parseLegacyPluginManifest(validManifest());

    expect(manifest.schemaVersion).toBe(LEGACY_PLUGIN_SCHEMA_VERSION);
    expect(manifest.id).toBe("@neuroclaw/example-adapter");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.requires.plugins).toEqual({});
    expect(manifest.mcp?.declares?.resources).toEqual([]);
    expect(manifest.mcp?.declares?.prompts).toEqual([]);
    expect(manifest.sandbox.network.allow).toEqual([]);
  });

  it("is strict at every level", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({ ...validManifest(), unexpected: true })
    ).toThrow();
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        capabilities: { layer: "L4", provides: ["tool_read"], extra: true }
      })
    ).toThrow();
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        sandbox: { ...validManifest().sandbox, extra: true }
      })
    ).toThrow();
  });

  it("rejects plugin ids that do not follow the npm scope convention", () => {
    expect(() => legacyPluginManifestSchema.parse({ ...validManifest(), id: "no-scope" })).toThrow(
      "plugin id"
    );
    expect(() =>
      legacyPluginManifestSchema.parse({ ...validManifest(), id: "@Neuroclaw/example" })
    ).toThrow("plugin id");
  });
});

describe("P-1 plugin manifest: D1.4-1 能力必须可兑现", () => {
  it("rejects a capability that matches no tool and no registered ref", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        capabilities: { layer: "L4", provides: ["tool_missing"] }
      })
    ).toThrow("not redeemable");
  });

  it("accepts capabilityRefs only for kind skill/pack", () => {
    expect(parseLegacyPluginManifest(skillManifest()).capabilities.provides).toEqual(["cap_read"]);

    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        kind: "adapter",
        capabilities: { layer: "L4", provides: ["cap_read"] },
        capabilityRefs: ["cap_read"]
      })
    ).toThrow("not redeemable");
  });

  it("requires the carrier block of a declared kind (structural honesty)", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({ ...validManifest(), mcp: undefined })
    ).toThrow("requires the mcp block");
    expect(() =>
      legacyPluginManifestSchema.parse({ ...skillManifest(), skill: undefined })
    ).toThrow("requires the skill block");
  });
});

describe("P-1 plugin manifest: D1.4-2 副作用禁用 in-process", () => {
  it("rejects side effects under in-process isolation", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        permissions: { ...validManifest().permissions, sideEffects: ["network"] }
      })
    ).toThrow("in-process");
  });

  it("accepts side effects once isolation leaves the host process", () => {
    const manifest = legacyPluginManifestSchema.parse({
      ...validManifest(),
      permissions: { ...validManifest().permissions, sideEffects: ["network", "filesystem"] },
      sandbox: {
        ...validManifest().sandbox,
        isolation: "subprocess",
        network: { mode: "allowlist", allow: ["api.example.com"] }
      }
    });
    expect(manifest.sandbox.isolation).toBe("subprocess");
  });

  it("keeps side-effect-free plugins loadable in-process and enforces min(1)", () => {
    expect(
      legacyPluginManifestSchema.parse(validManifest()).sandbox.isolation
    ).toBe("in-process");
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        permissions: { ...validManifest().permissions, sideEffects: [] }
      })
    ).toThrow();
  });
});

describe("P-1 plugin manifest: version/requires 真 semver 校验", () => {
  it("rejects non-SemVer versions", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({ ...validManifest(), version: "1.2" })
    ).toThrow("Invalid SemVer");
    expect(() =>
      legacyPluginManifestSchema.parse({ ...validManifest(), version: "not-a-version" })
    ).toThrow("Invalid SemVer");
  });

  it("rejects unparseable or missing hostApi ranges", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        requires: { hostApi: "not-a-range" }
      })
    ).toThrow("Invalid semver range");
    expect(() => legacyPluginManifestSchema.parse({ ...validManifest(), requires: {} })).toThrow();
  });

  it("rejects unparseable requires.plugins ranges but keeps the empty default", () => {
    expect(() =>
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        requires: { hostApi: "^1.0.0", plugins: { "@lab/core": "not-a-range" } }
      })
    ).toThrow("Invalid semver range");
    expect(
      legacyPluginManifestSchema.parse({
        ...validManifest(),
        requires: { hostApi: "^1.0.0", plugins: { "@lab/core": "^2.0.0" } }
      }).requires.plugins
    ).toEqual({ "@lab/core": "^2.0.0" });
  });
});
