import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CAPABILITY_INVENTORY_V1 } from "./index.js";
import type { AgentContractField, AgentProfile, AgentRoleKey } from "./index.js";
import {
  ROLE_GRID_MATCHER_DEFAULTS,
  SIMULATION_ONLY_CAPABILITY_REFS,
  buildCapabilityMatchInput,
  checkAgentProfileExecutability,
  inventoryToInstalledPlugins
} from "./executability-bridge.js";

// ---------------------------------------------------------------------------
// RG-2b：role-grid profile → shared D5 matcher 接线（GM 裁：复用 D5，不另建包）
// ---------------------------------------------------------------------------

const P0_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL("../../../scripts/executability-report.mjs", import.meta.url));

function f(
  name: string,
  type: AgentContractField["type"],
  description: string,
  required = true
): AgentContractField {
  return { name, type, required, description };
}

function profile(role: AgentRoleKey, extra: Partial<AgentProfile> = {}): AgentProfile {
  return {
    role,
    inputContract: { fields: [f("businessSummary", "string", "Business context")] },
    outputContract: { fields: [f("contentAngles", "string[]", "Generated angles")] },
    acceptance: { requiredOutputFields: ["contentAngles"], minEvidenceLevel: "E1", verifier: "self" },
    ...extra
  };
}

// A：全部 ref 在清单 AVAILABLE（E3）⇒ tier A
const availableProfile = profile("content_editor", {
  skills: [
    {
      skillKey: "content_angles",
      skillVersion: "1.0.0",
      capabilityRefs: ["capability_growth_simulation"],
      promptTemplateRef: "prompt://content_angles"
    }
  ],
  tools: [
    {
      toolKey: "browse_public_pages",
      capabilityRef: "browser_extract",
      scopes: ["read"],
      actionType: "browser_extract",
      requiresApproval: false
    }
  ]
});

// C：MUST ref 清单内 MISSING ⇒ 拦截，--check 退出码非零
const missingProfile = profile("channel_ops", {
  tools: [
    {
      toolKey: "publish_xiaohongshu",
      capabilityRef: "capability_channel_publish_xiaohongshu",
      scopes: ["read"],
      requiresApproval: false
    }
  ]
});

// B：write scope ⇒ requiresRealSideEffect=true；provider 为 simulation-only ⇒ PARTIAL（列前置条件）
const partialProfile = profile("conversion_writer", {
  tools: [
    {
      toolKey: "simulated_write",
      capabilityRef: "capability_growth_simulation",
      scopes: ["write"],
      requiresApproval: true
    }
  ],
  permissions: {
    readScopes: ["workspace:growth"],
    writeScopes: ["workspace:growth"],
    maxRiskClass: "LOW",
    requiresApprovalFor: []
  }
});

let fixtureDir: string;
let availableFile: string;
let missingFile: string;
let partialFile: string;

beforeAll(async () => {
  fixtureDir = await mkdtemp(path.join(tmpdir(), "rg2b-"));
  availableFile = path.join(fixtureDir, "available.json");
  missingFile = path.join(fixtureDir, "missing.json");
  partialFile = path.join(fixtureDir, "partial.json");
  await writeFile(availableFile, JSON.stringify(availableProfile, null, 2));
  await writeFile(missingFile, JSON.stringify(missingProfile, null, 2));
  await writeFile(partialFile, JSON.stringify(partialProfile, null, 2));
});

afterAll(async () => {
  await rm(fixtureDir, { recursive: true, force: true });
});

function runScript(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT_PATH, ...args],
      { cwd: P0_ROOT, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout, stderr });
      }
    );
  });
}

// ---------------------------------------------------------------------------
// 缺省值与清单映射
// ---------------------------------------------------------------------------

describe("RG-2b 缺省值（无来源字段，保守取向）", () => {
  it("声明保守缺省：MUST / L0 / execute / E1", () => {
    expect(ROLE_GRID_MATCHER_DEFAULTS).toEqual({
      weight: "MUST",
      layer: "L0",
      chainSegment: "execute",
      minEvidence: "E1"
    });
  });

  it("simulation-only 白名单仅含 E3 已证 ref，不以命名推测", () => {
    expect([...SIMULATION_ONLY_CAPABILITY_REFS]).toEqual(["capability_growth_simulation"]);
  });
});

describe("RG-2b 清单 → InstalledPlugin 映射", () => {
  const plugins = inventoryToInstalledPlugins(CAPABILITY_INVENTORY_V1);

  it("仅 AVAILABLE 条目映射为已安装插件（MISSING 不映射，留给 D5 rule 1）", () => {
    expect(plugins).toHaveLength(
      CAPABILITY_INVENTORY_V1.entries.filter((entry) => entry.status === "AVAILABLE").length
    );
    const ids = plugins.map((plugin) => plugin.pluginId);
    expect(ids).toContain("inventory:browser_extract");
    expect(ids).not.toContain("inventory:capability_channel_publish_xiaohongshu");
  });

  it("确定性排序 + pluginId 规则 + simulationOnly 白名单生效", () => {
    const ids = plugins.map((plugin) => plugin.pluginId);
    expect(ids).toEqual([...ids].sort());
    expect(plugins.filter((plugin) => plugin.simulationOnly).map((plugin) => plugin.pluginId)).toEqual(
      ["inventory:capability_growth_simulation"]
    );
    expect(plugins.every((plugin) => plugin.enabled && plugin.requires.length === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// profile → D5 输入映射
// ---------------------------------------------------------------------------

describe("RG-2b profile → D5 映射", () => {
  it("ref 去重且确定性排序；缺省字段落位；write scope 映射 requiresRealSideEffect", () => {
    const input = buildCapabilityMatchInput(availableProfile)!;
    expect(input).not.toBeNull();
    expect(input.goalSpec.objective).toBe("role-grid executability: content_editor");

    const requirements = input.goalSpec.requirements;
    expect(requirements.map((req) => req.capabilityRef)).toEqual([
      "browser_extract",
      "capability_growth_simulation"
    ]);
    expect(requirements.map((req) => req.reqId)).toEqual([
      "req:content_editor:browser_extract",
      "req:content_editor:capability_growth_simulation"
    ]);
    for (const req of requirements) {
      expect(req.weight).toBe("MUST");
      expect(req.layer).toBe("L0");
      expect(req.chainSegment).toBe("execute");
      expect(req.minEvidence).toBe("E1");
      expect(req.requiresRealSideEffect).toBe(false);
    }
    expect(input.inventory.length).toBeGreaterThan(0);
  });

  it("同一 ref 同时出现在 skills/tools 时合并为单条需求", () => {
    const merged = profile("content_editor", {
      skills: [
        {
          skillKey: "browse",
          skillVersion: "1.0.0",
          capabilityRefs: ["browser_extract"],
          promptTemplateRef: "prompt://browse"
        }
      ],
      tools: [
        {
          toolKey: "browse_public_pages",
          capabilityRef: "browser_extract",
          scopes: ["read"],
          actionType: "browser_extract",
          requiresApproval: false
        }
      ]
    });
    const input = buildCapabilityMatchInput(merged)!;
    expect(input.goalSpec.requirements).toHaveLength(1);
    expect(input.goalSpec.requirements[0]!.capabilityRef).toBe("browser_extract");
  });

  it("write scope ⇒ requiresRealSideEffect=true（来源字段，非缺省）", () => {
    const input = buildCapabilityMatchInput(partialProfile)!;
    expect(input.goalSpec.requirements[0]!.requiresRealSideEffect).toBe(true);
  });

  it("零 capability 绑定 ⇒ null（不合成需求、不判 A）", () => {
    const bare = profile("goal_officer");
    expect(buildCapabilityMatchInput(bare)).toBeNull();
  });

  it("write scope 缺授权链前置（permissions）⇒ 装配前即被 AgentProfile 门禁拒绝", () => {
    const { permissions: _removed, ...withoutPermissions } = partialProfile;
    expect(() => buildCapabilityMatchInput(withoutPermissions as AgentProfile)).toThrow(/write scope/);
  });
});

// ---------------------------------------------------------------------------
// tier 判定（复用 D5）
// ---------------------------------------------------------------------------

describe("RG-2b tier 判定（D5 复用）", () => {
  it("全 COVERED ⇒ tier A、不阻塞、无前置条件", () => {
    const result = checkAgentProfileExecutability(availableProfile);
    expect(result.verdict).toBe("A");
    expect(result.blocking).toBe(false);
    expect(result.preconditions).toEqual([]);
    expect(result.report!.items.every((item) => item.status === "COVERED")).toBe(true);
  });

  it("MUST=MISSING ⇒ tier C；条目 MISSING/E0 + unlockHint；段 BLOCKED", () => {
    const result = checkAgentProfileExecutability(missingProfile);
    expect(result.verdict).toBe("C");
    expect(result.blocking).toBe(true);
    expect(result.report!.items[0]).toMatchObject({
      capabilityRef: "capability_channel_publish_xiaohongshu",
      weight: "MUST",
      status: "MISSING",
      evidenceLevel: "E0"
    });
    expect(result.report!.items[0]!.unlockHint).toBeTruthy();
    expect(result.report!.segments).toContainEqual({ segment: "execute", status: "BLOCKED" });
  });

  it("PARTIAL ⇒ tier B、不阻塞、列出前置条件（不静默降级）", () => {
    const result = checkAgentProfileExecutability(partialProfile);
    expect(result.verdict).toBe("B");
    expect(result.blocking).toBe(false);
    expect(result.report!.items[0]).toMatchObject({ status: "PARTIAL", weight: "MUST" });
    expect(result.preconditions.length).toBeGreaterThan(0);
    expect(result.preconditions.join(" ")).toMatch(/non-simulation/);
  });

  it("零绑定 ⇒ NO_BINDINGS、不阻塞、report=null", () => {
    const result = checkAgentProfileExecutability(profile("goal_officer"));
    expect(result).toMatchObject({
      role: "goal_officer",
      verdict: "NO_BINDINGS",
      blocking: false,
      report: null,
      preconditions: []
    });
  });

  it("确定性：同输入两次调用报告字节一致", () => {
    const once = checkAgentProfileExecutability(availableProfile);
    const twice = checkAgentProfileExecutability(availableProfile);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

// ---------------------------------------------------------------------------
// 脚本 executability-report.mjs（--check 退出码口径）
// ---------------------------------------------------------------------------

describe("RG-2b executability-report.mjs", () => {
  it("--check：tier A ⇒ exit 0；两次运行 stdout 字节一致", async () => {
    const first = await runScript(["--check", availableFile]);
    expect(first.code, first.stderr).toBe(0);
    expect(first.stdout).toContain("tier=A");
    const second = await runScript(["--check", availableFile]);
    expect(second.stdout).toBe(first.stdout);
  });

  it("--check：MUST=MISSING ⇒ tier C 且退出码 1；报告模式（无 --check）放行 exit 0", async () => {
    const check = await runScript(["--check", missingFile]);
    expect(check.code).toBe(1);
    expect(check.stdout).toContain("tier=C");
    expect(check.stdout).toContain("unlockHint:");

    const reportOnly = await runScript([missingFile]);
    expect(reportOnly.code).toBe(0);
    expect(reportOnly.stdout).toContain("tier=C");
  });

  it("--check：PARTIAL ⇒ tier B、列前置条件、退出码 0", async () => {
    const result = await runScript(["--check", partialFile]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("tier=B");
    expect(result.stdout).toContain("precondition:");
  });

  it("用法/数据错误：无参数 exit 2；坏 JSON exit 1（fail-closed）", async () => {
    const usage = await runScript([]);
    expect(usage.code).toBe(2);

    const badFile = path.join(fixtureDir, "bad.json");
    await writeFile(badFile, "{ not json");
    const bad = await runScript(["--check", badFile]);
    expect(bad.code).toBe(1);
  });
});
