import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_PROFILES_V1,
  AGENT_PROFILES_V1_FILE,
  AGENT_ROLE_KEYS,
  agentProfileSchema,
  agentProfilesFingerprint,
  agentProfilesSchema,
  resolveAgentCapabilityRefs
} from "./index.js";
import type { AgentContractField, AgentProfile, AgentRoleKey } from "./index.js";

// ---------------------------------------------------------------------------
// M1 · 8 岗位 profile 终稿 v1（profiles.v1.json）
// 依据：.artifacts/impl/20260927-m1-profiles.md（TODO-7/裁点⑤复核留证）
// 3 个 E3 岗位期望 = templates/src/index.ts:45-58 / :75-88 / :111-124 原文
// ---------------------------------------------------------------------------

const e3TemplateContracts: Record<
  "content_editor" | "conversion_writer" | "analyst",
  {
    input: Array<[string, AgentContractField["type"], boolean]>;
    output: Array<[string, AgentContractField["type"], boolean]>;
  }
> = {
  content_editor: {
    input: [
      ["businessSummary", "string", true],
      ["targetCustomer", "string", true],
      ["preferredChannels", "string[]", true],
      ["contentGoal", "string", true]
    ],
    output: [
      ["contentAngles", "string[]", true],
      ["channelRecommendations", "string[]", true]
    ]
  },
  conversion_writer: {
    input: [
      ["businessSummary", "string", true],
      ["targetCustomer", "string", true],
      ["preferredChannels", "string[]", true],
      ["offerAsset", "string", true],
      ["recipientEmail", "string", false]
    ],
    output: [
      ["conversionDraft", "string", true],
      ["approvalPreview", "string", true]
    ]
  },
  analyst: {
    input: [
      ["businessSummary", "string", true],
      ["targetCustomer", "string", true],
      ["preferredChannels", "string[]", true],
      ["metricsWindowDays", "number", true],
      ["metricsSummary", "string", false]
    ],
    output: [
      ["reviewSummary", "string", true],
      ["nextActions", "string[]", true]
    ]
  }
};

function condense(fields: AgentContractField[]): Array<[string, string, boolean]> {
  return fields.map((field) => [field.name, field.type, field.required]);
}

function profile(role: AgentRoleKey): AgentProfile {
  const found = AGENT_PROFILES_V1.profiles.find((candidate) => candidate.role === role);
  if (!found) throw new Error(`profile missing: ${role}`);
  return found;
}

describe("M1 · 8 岗位 profile 终稿 v1", () => {
  it("8/8：磁盘 JSON 与导出常量一致，逐岗 strict 解析通过", () => {
    const raw = readFileSync(new URL(`./${AGENT_PROFILES_V1_FILE}`, import.meta.url), "utf8");
    const parsed = agentProfilesSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual(AGENT_PROFILES_V1);

    let passed = 0;
    for (const role of AGENT_ROLE_KEYS) {
      // 岗位级 strict 解析（文档级不变量=全量 8 岗，由负向用例覆盖）
      const result = agentProfileSchema.safeParse(profile(role));
      expect(result.success, `${role}: ${JSON.stringify(result.error?.issues ?? [])}`).toBe(true);
      passed += 1;
    }
    expect(passed).toBe(AGENT_ROLE_KEYS.length);
    expect(AGENT_PROFILES_V1.profiles).toHaveLength(8);
  });

  it("岗位覆盖：恰为 AGENT_ROLE_KEYS 固定顺序、无重复", () => {
    expect(AGENT_PROFILES_V1.profiles.map((candidate) => candidate.role)).toEqual([
      ...AGENT_ROLE_KEYS
    ]);
  });

  it("3 个 E3 岗位契约零新写直迁 templates（逐字段比对）", () => {
    for (const [role, expected] of Object.entries(e3TemplateContracts)) {
      const target = profile(role as AgentRoleKey);
      expect(condense(target.inputContract.fields), `${role}.input`).toEqual(expected.input);
      expect(condense(target.outputContract.fields), `${role}.output`).toEqual(expected.output);
    }
  });

  it("上岗预裁决（capabilityRef 解析）：3 ELIGIBLE + 2 BLOCKED（缺口不发明）", () => {
    const eligible = ["goal_officer", "strategist", "content_editor", "conversion_writer", "analyst", "retro_officer"] as const;
    for (const role of eligible) {
      const resolution = resolveAgentCapabilityRefs(profile(role));
      expect(resolution.status, role).toBe("ELIGIBLE");
      expect(resolution.blocked, role).toEqual([]);
    }

    const channelOps = resolveAgentCapabilityRefs(profile("channel_ops"));
    expect(channelOps.status).toBe("BLOCKED_BY_CAPABILITY");
    expect(channelOps.blocked).toEqual(["capability_channel_publish_xiaohongshu"]);

    const compliance = resolveAgentCapabilityRefs(profile("compliance_reviewer"));
    expect(compliance.status).toBe("BLOCKED_BY_CAPABILITY");
    expect(compliance.blocked).toEqual([
      "capability_compliance_tos_check",
      "capability_ratelimit_enforce"
    ]);

    // 无工具设计岗：空解析（不发明绑定）
    for (const role of ["goal_officer", "strategist", "retro_officer"] as const) {
      expect(resolveAgentCapabilityRefs(profile(role)).items, role).toEqual([]);
    }
  });

  it("审批门编码：conversion_writer 的 notification_send_preview requiresApproval=true", () => {
    const tool = (profile("conversion_writer").tools ?? []).find(
      (candidate) => candidate.toolKey === "notification_send_preview"
    );
    expect(tool?.requiresApproval).toBe(true);
  });

  it("指纹：同输入两次一致、64 hex；任一字段变化 → 指纹变化", () => {
    const first = agentProfilesFingerprint();
    const second = agentProfilesFingerprint(AGENT_PROFILES_V1);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);

    const mutated = JSON.parse(JSON.stringify(AGENT_PROFILES_V1)) as typeof AGENT_PROFILES_V1;
    mutated.profiles[0]!.inputContract.fields[0]!.description = "Mutated description";
    expect(agentProfilesFingerprint(mutated)).not.toBe(first);
  });

  it("strict 门禁：重复 role / 未知顶层键 / 缺岗 均被拒", () => {
    const duplicated = agentProfilesSchema.safeParse({
      version: "1.0",
      profiles: [...AGENT_PROFILES_V1.profiles, AGENT_PROFILES_V1.profiles[0]]
    });
    expect(duplicated.success).toBe(false);

    const unknownKey = agentProfilesSchema.safeParse({ ...AGENT_PROFILES_V1, extra: 1 });
    expect(unknownKey.success).toBe(false);

    const missingRole = agentProfilesSchema.safeParse({
      version: "1.0",
      profiles: AGENT_PROFILES_V1.profiles.filter((candidate) => candidate.role !== "retro_officer")
    });
    expect(missingRole.success).toBe(false);
  });
});
