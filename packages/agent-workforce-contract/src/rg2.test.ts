import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_ROLE_KEYS,
  CAPABILITY_INVENTORY_V1,
  CAPABILITY_INVENTORY_V1_FILE,
  agentPermissionsSchema,
  agentProfileSchema,
  agentSkillBindingSchema,
  agentToolBindingSchema,
  capabilityInventoryFingerprint,
  capabilityInventorySchema,
  resolveAgentCapabilityRefs
} from "./index.js";
import type {
  AgentContractField,
  AgentProfile,
  AgentRoleKey,
  AgentToolBinding
} from "./index.js";

// ---------------------------------------------------------------------------
// RG-2 样例（依据提案 §二 字段 5/6/7；能力清单见 src/capability-inventory.v1.json）
// ---------------------------------------------------------------------------

function f(
  name: string,
  type: AgentContractField["type"],
  description: string,
  required = true
): AgentContractField {
  return { name, type, required, description };
}

function baseProfile(role: AgentRoleKey = "content_editor"): AgentProfile {
  return {
    role,
    inputContract: { fields: [f("businessSummary", "string", "Business context")] },
    outputContract: { fields: [f("contentAngles", "string[]", "Generated angles")] },
    acceptance: { requiredOutputFields: ["contentAngles"], minEvidenceLevel: "E1", verifier: "self" }
  };
}

const readTool: AgentToolBinding = {
  toolKey: "browse_public_pages",
  capabilityRef: "browser_extract",
  scopes: ["read"],
  actionType: "browser_extract",
  requiresApproval: false
};

const skill = {
  skillKey: "content_angles",
  skillVersion: "1.0.0",
  capabilityRefs: ["capability_growth_simulation"],
  promptTemplateRef: "prompt://content_angles"
};

const permissions = {
  readScopes: ["workspace:growth"],
  writeScopes: [],
  maxRiskClass: "LOW",
  requiresApprovalFor: []
};

// ---------------------------------------------------------------------------
// RG-2a 能力清单（capability-inventory.v1.json 首版）
// ---------------------------------------------------------------------------

describe("RG-2a 能力清单 v1", () => {
  it("磁盘 JSON 与导出常量一致、schema 严格解析通过", () => {
    const raw = readFileSync(
      new URL(`./${CAPABILITY_INVENTORY_V1_FILE}`, import.meta.url),
      "utf8"
    );
    const parsed = capabilityInventorySchema.parse(JSON.parse(raw));
    expect(parsed).toEqual(CAPABILITY_INVENTORY_V1);
    expect(CAPABILITY_INVENTORY_V1.version).toBe("1.0");
  });

  it("基线构成：3 模板 + 5 动作 + 3 实测 ref + 3 缺口（共 14 条）", () => {
    const entries = CAPABILITY_INVENTORY_V1.entries;
    expect(entries).toHaveLength(14);
    expect(entries.filter((entry) => entry.kind === "template")).toHaveLength(3);
    expect(entries.filter((entry) => entry.kind === "action")).toHaveLength(5);
    expect(entries.filter((entry) => entry.status === "MISSING").map((entry) => entry.capabilityRef)).toEqual([
      "capability_channel_publish_xiaohongshu",
      "capability_compliance_tos_check",
      "capability_ratelimit_enforce"
    ]);
    for (const ref of ["capability_growth_simulation", "capability_evidence_capture", "capability_receipt_emit"]) {
      const entry = entries.find((candidate) => candidate.capabilityRef === ref);
      expect(entry?.status, ref).toBe("AVAILABLE");
      expect(entry?.kind, ref).toBe("capability_ref");
    }
  });

  it("fingerprint：sha256 确定性 + golden 快照", () => {
    const first = capabilityInventoryFingerprint();
    const second = capabilityInventoryFingerprint(CAPABILITY_INVENTORY_V1);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(first).toBe("b1d3f84114ebc8fe0110be4c626094793e7202b4086f81ceafe3e8e683cd8f22");
  });

  it("strict：未知字段 / 未知版本被拒", () => {
    expect(
      capabilityInventorySchema.safeParse({ ...CAPABILITY_INVENTORY_V1, extra: 1 }).success
    ).toBe(false);
    expect(
      capabilityInventorySchema.safeParse({ ...CAPABILITY_INVENTORY_V1, version: "2.0" }).success
    ).toBe(false);
  });

  it("重复 capabilityRef 被拒", () => {
    const entry = CAPABILITY_INVENTORY_V1.entries[0];
    const duplicated = capabilityInventorySchema.safeParse({
      version: "1.0",
      entries: [entry, { ...entry }]
    });
    expect(duplicated.success).toBe(false);
  });

  it("AVAILABLE + E0 被拒（D5 证据地板），MISSING + E0 放行", () => {
    const availableE0 = capabilityInventorySchema.safeParse({
      version: "1.0",
      entries: [
        {
          capabilityRef: "capability_demo",
          kind: "capability_ref",
          status: "AVAILABLE",
          evidenceLevel: "E0",
          source: "test"
        }
      ]
    });
    expect(availableE0.success).toBe(false);
    const missingE0 = capabilityInventorySchema.safeParse({
      version: "1.0",
      entries: [
        {
          capabilityRef: "capability_demo",
          kind: "capability_ref",
          status: "MISSING",
          evidenceLevel: "E0",
          source: "test"
        }
      ]
    });
    expect(missingE0.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RG-2c skills / tools / permissions 收紧
// ---------------------------------------------------------------------------

describe("RG-2c skills / tools / permissions 收紧", () => {
  it("合法绑定 profile 通过（可选但存在即须合规）", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      skills: [skill],
      tools: [readTool],
      permissions
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });

  it("skills：合法通过、未知字段与空 skillKey 被拒", () => {
    expect(agentSkillBindingSchema.safeParse(skill).success).toBe(true);
    expect(agentSkillBindingSchema.safeParse({ ...skill, extra: 1 }).success).toBe(false);
    expect(agentSkillBindingSchema.safeParse({ ...skill, skillKey: "" }).success).toBe(false);
  });

  it("tools：非法 scope 与非法 actionType 被拒、缺 requiresApproval 被拒", () => {
    expect(agentToolBindingSchema.safeParse(readTool).success).toBe(true);
    expect(agentToolBindingSchema.safeParse({ ...readTool, scopes: ["admin"] }).success).toBe(false);
    expect(agentToolBindingSchema.safeParse({ ...readTool, actionType: "delete_everything" }).success).toBe(
      false
    );
    const { requiresApproval: _removed, ...withoutApproval } = readTool;
    expect(agentToolBindingSchema.safeParse(withoutApproval).success).toBe(false);
  });

  it("permissions：rateLimit 仅 enforced 模式有效", () => {
    expect(
      agentPermissionsSchema.safeParse({
        ...permissions,
        rateLimit: { mode: "enforced", perHour: 10 }
      }).success
    ).toBe(true);
    expect(
      agentPermissionsSchema.safeParse({
        ...permissions,
        rateLimit: { mode: "fixture", perHour: 10 }
      }).success
    ).toBe(false);
  });

  it("memoryScope/kpi/escalation 仍为过渡键位（RG-3 前不收紧）", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      memoryScope: {},
      kpi: [],
      escalation: {}
    });
    expect(parsed.success).toBe(true);
  });
});

describe("RG-2c write scope 授权链前置门禁", () => {
  const writeTool: AgentToolBinding = {
    toolKey: "publish_channel",
    capabilityRef: "capability_channel_publish_xiaohongshu",
    scopes: ["write"],
    actionType: "notification_send_preview",
    requiresApproval: true
  };

  it("write scope 但缺 permissions 被拒", () => {
    const parsed = agentProfileSchema.safeParse({ ...baseProfile(), tools: [writeTool] });
    expect(parsed.success).toBe(false);
  });

  it("write scope 但 permissions.writeScopes 为空被拒", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      tools: [writeTool],
      permissions: { ...permissions, writeScopes: [] }
    });
    expect(parsed.success).toBe(false);
  });

  it("write scope 但 requiresApproval=false 被拒", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      tools: [{ ...writeTool, requiresApproval: false }],
      permissions: { ...permissions, writeScopes: ["channel:xiaohongshu"] }
    });
    expect(parsed.success).toBe(false);
  });

  it("write scope + writeScopes 非空 + 审批门 ⇒ 通过", () => {
    const parsed = agentProfileSchema.safeParse({
      ...baseProfile(),
      tools: [writeTool],
      permissions: { ...permissions, writeScopes: ["channel:xiaohongshu"], maxRiskClass: "MEDIUM" }
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RG-2 capabilityRef 解析（BLOCKED 名单元数据）
// ---------------------------------------------------------------------------

describe("RG-2 capabilityRef 解析", () => {
  it("可解析 ref ⇒ ELIGIBLE（COVERED）", () => {
    const resolution = resolveAgentCapabilityRefs({
      ...baseProfile(),
      skills: [skill],
      tools: [readTool]
    });
    expect(resolution.status).toBe("ELIGIBLE");
    expect(resolution.blocked).toEqual([]);
    expect(resolution.items.map((item) => [item.capabilityRef, item.status])).toEqual([
      ["capability_growth_simulation", "COVERED"],
      ["browser_extract", "COVERED"]
    ]);
  });

  it("缺口 ref（清单内 MISSING）⇒ BLOCKED_BY_CAPABILITY", () => {
    const resolution = resolveAgentCapabilityRefs({
      ...baseProfile("channel_ops"),
      tools: [
        {
          toolKey: "publish_channel",
          capabilityRef: "capability_channel_publish_xiaohongshu",
          scopes: ["read"],
          requiresApproval: false
        }
      ]
    });
    expect(resolution.status).toBe("BLOCKED_BY_CAPABILITY");
    expect(resolution.blocked).toEqual(["capability_channel_publish_xiaohongshu"]);
    expect(resolution.items[0]).toMatchObject({
      inventoryStatus: "MISSING",
      status: "MISSING",
      evidenceLevel: "E0"
    });
  });

  it("清单外 ref ⇒ NOT_IN_INVENTORY 且 BLOCKED（不发明）", () => {
    const resolution = resolveAgentCapabilityRefs({
      ...baseProfile(),
      skills: [{ ...skill, capabilityRefs: ["capability_not_catalogued"] }]
    });
    expect(resolution.status).toBe("BLOCKED_BY_CAPABILITY");
    expect(resolution.items[0].inventoryStatus).toBe("NOT_IN_INVENTORY");
  });

  it("确定性：同输入两次调用结果一致、重复 ref 去重", () => {
    const profile = { ...baseProfile(), skills: [{ ...skill, capabilityRefs: [skill.capabilityRefs[0]!, skill.capabilityRefs[0]!] }] };
    const first = resolveAgentCapabilityRefs(profile);
    const second = resolveAgentCapabilityRefs(profile);
    expect(first).toEqual(second);
    expect(first.items).toHaveLength(1);
  });

  it("8 岗位无绑定样例 ⇒ ELIGIBLE（空解析）", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const resolution = resolveAgentCapabilityRefs(baseProfile(role));
      expect(resolution.status, role).toBe("ELIGIBLE");
      expect(resolution.items, role).toEqual([]);
    }
  });
});
