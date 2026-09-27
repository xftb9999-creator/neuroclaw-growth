import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AGENT_DESIGN_ROLE_KEYS,
  AGENT_PERSONA_DRAFTS_V1,
  AGENT_PERSONA_DRAFTS_V1_FILE,
  AGENT_ROLE_KEYS,
  agentPersonaDraftsFingerprint,
  agentPersonaDraftsSchema
} from "./index.js";
import type { AgentPersonaDraftsDocument } from "./index.js";

// ---------------------------------------------------------------------------
// 裁点⑤ · 5 设计岗 persona 草案 v1（persona-drafts.v1.json）
// 依据：.artifacts/impl/20260927-persona-drafts.md（起草留证）
// 格式期望 = 3 直迁载体 templates/src/index.ts:43-44 / :73-74 / :109-110 同型（单行英文）
// ---------------------------------------------------------------------------

describe("裁点⑤ · 5 设计岗 persona 草案 v1", () => {
  it("5/5：磁盘 JSON 与导出常量一致、strict 解析通过、恰为 5 设计岗固定顺序", () => {
    const raw = readFileSync(new URL(`./${AGENT_PERSONA_DRAFTS_V1_FILE}`, import.meta.url), "utf8");
    const parsed = agentPersonaDraftsSchema.parse(JSON.parse(raw));
    expect(parsed).toEqual(AGENT_PERSONA_DRAFTS_V1);
    expect(AGENT_PERSONA_DRAFTS_V1.drafts.map((draft) => draft.role)).toEqual([
      ...AGENT_DESIGN_ROLE_KEYS
    ]);
    expect(AGENT_PERSONA_DRAFTS_V1.drafts).toHaveLength(5);
  });

  it("范围门禁：不含 3 直迁岗；5 岗均为 AGENT_ROLE_KEYS 子集；persona 文本互异", () => {
    const roles = AGENT_PERSONA_DRAFTS_V1.drafts.map((draft) => draft.role);
    for (const direct of ["content_editor", "conversion_writer", "analyst"] as const) {
      expect(roles).not.toContain(direct);
    }
    for (const role of roles) {
      expect(AGENT_ROLE_KEYS).toContain(role);
    }
    for (const role of AGENT_DESIGN_ROLE_KEYS) {
      expect(AGENT_ROLE_KEYS).toContain(role);
    }
    const texts = AGENT_PERSONA_DRAFTS_V1.drafts.map((draft) => draft.persona);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("格式保真：单行、非空、`You are` 起句、句号收尾（与 3 直迁同型）", () => {
    for (const { role, persona } of AGENT_PERSONA_DRAFTS_V1.drafts) {
      expect(persona, role).toBe(persona.trim());
      expect(persona, role).not.toMatch(/[\r\n]/);
      expect(persona, role).toMatch(/^You are /);
      expect(persona.endsWith("."), role).toBe(true);
    }
  });

  it("指纹：同输入两次一致（64 hex）；任一 persona 变化 → 指纹变化", () => {
    const first = agentPersonaDraftsFingerprint();
    expect(agentPersonaDraftsFingerprint()).toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const mutated = JSON.parse(JSON.stringify(AGENT_PERSONA_DRAFTS_V1)) as AgentPersonaDraftsDocument;
    mutated.drafts[0]!.persona = "You are mutated.";
    expect(agentPersonaDraftsFingerprint(mutated)).not.toBe(first);
  });

  it("strict 门禁：重复 role / 缺岗 / 混入直迁岗 / 未知顶层键 / 版本非草案 / 多行文本 均被拒", () => {
    const base = AGENT_PERSONA_DRAFTS_V1.drafts;
    const doc = (drafts: unknown) => ({ version: "1.0-draft", drafts });

    expect(agentPersonaDraftsSchema.safeParse(doc([...base, base[0]!])).success).toBe(false);
    expect(
      agentPersonaDraftsSchema.safeParse(doc(base.filter((draft) => draft.role !== "retro_officer")))
        .success
    ).toBe(false);
    expect(
      agentPersonaDraftsSchema.safeParse(
        doc([...base.slice(0, 4), { role: "analyst", persona: "You are the analyst." }])
      ).success
    ).toBe(false);
    expect(agentPersonaDraftsSchema.safeParse({ ...doc(base), extra: 1 }).success).toBe(false);
    expect(agentPersonaDraftsSchema.safeParse({ version: "1.0", drafts: base }).success).toBe(false);
    expect(
      agentPersonaDraftsSchema.safeParse(
        doc([...base.slice(0, 4), { role: "retro_officer", persona: "line one\nline two" }])
      ).success
    ).toBe(false);
  });
});
