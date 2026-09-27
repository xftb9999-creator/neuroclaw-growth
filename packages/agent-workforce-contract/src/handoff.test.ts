import { describe, expect, it } from "vitest";

import { validateHandoff } from "./handoff.js";
import type { AgentInputContract } from "./index.js";

/**
 * AW-5 片 2 · 判据①③ 定向单测（纯函数，零 DB / 零 I/O）。
 * 对照：方案稿 §二 ①（类型错配拒）/ ③（未声明字段拒）；设计源 §3.3.2:503-505。
 */

const contract: AgentInputContract = {
  fields: [
    { name: "businessSummary", type: "string", required: true, description: "Business context" },
    { name: "contentAngles", type: "string[]", required: true, description: "Angles" },
    { name: "metricsWindowDays", type: "number", required: true, description: "Window" }
  ]
};

describe("AW-5 片2: validateHandoff 纯函数（判据①③）", () => {
  it("判据① 正向：声明内且类型匹配的 payload 通过，accepted 保结构", () => {
    const payload = {
      businessSummary: "growth probe",
      contentAngles: ["angle-1", "angle-2"],
      metricsWindowDays: 7
    };
    const result = validateHandoff(payload, "task_up", "task_down", contract);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.accepted).toEqual(payload);
    expect(result.acceptedFields).toEqual(["businessSummary", "contentAngles", "metricsWindowDays"]);
    expect(result.fromTask).toBe("task_up");
    expect(result.toTask).toBe("task_down");
  });

  it("判据① 负向：类型错配被拒（string[] 给 string / number 给 string）", () => {
    const result = validateHandoff(
      { contentAngles: "not-an-array", metricsWindowDays: "7", businessSummary: "s" },
      "task_up",
      "task_down",
      contract
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => [v.kind, v.field])).toEqual([
      ["TYPE_MISMATCH", "contentAngles"],
      ["TYPE_MISMATCH", "metricsWindowDays"]
    ]);
    expect(result.accepted).toEqual({ businessSummary: "s" });
  });

  it("判据① 负向：string[] 含非字符串项被拒", () => {
    const result = validateHandoff(
      { contentAngles: ["ok", 42] },
      "task_up",
      "task_down",
      contract
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.kind)).toEqual(["TYPE_MISMATCH"]);
  });

  it("判据③ 负向：未声明字段被拒且不进 accepted（防污染）", () => {
    const result = validateHandoff(
      { businessSummary: "s", rogueField: "pollution" },
      "task_up",
      "task_down",
      contract
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        kind: "UNDECLARED_FIELD",
        field: "rogueField",
        detail: expect.stringContaining("未在下游 inputContract 声明")
      }
    ]);
    expect(result.accepted).toEqual({ businessSummary: "s" });
    expect(result.acceptedFields).toEqual(["businessSummary"]);
  });

  it("混合场景：合法子集保留、违规项确定性排序（field, kind）", () => {
    const result = validateHandoff(
      { zeta: 1, contentAngles: "bad", alpha: true, businessSummary: "s" },
      "task_up",
      "task_down",
      contract
    );
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => [v.field, v.kind])).toEqual([
      ["alpha", "UNDECLARED_FIELD"],
      ["contentAngles", "TYPE_MISMATCH"],
      ["zeta", "UNDECLARED_FIELD"]
    ]);
    expect(result.accepted).toEqual({ businessSummary: "s" });
  });

  it("期望字段缺失：MISSING_HANDOFF_FIELD（fail-closed，替代静默丢字段）", () => {
    const result = validateHandoff(
      { businessSummary: "s" },
      "task_up",
      "task_down",
      contract,
      { expectedFields: ["businessSummary", "contentAngles"] }
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      {
        kind: "MISSING_HANDOFF_FIELD",
        field: "contentAngles",
        detail: expect.stringContaining("缺失")
      }
    ]);
  });

  it("期望字段齐全则不产生缺失违规", () => {
    const result = validateHandoff(
      { contentAngles: ["a"] },
      "task_up",
      "task_down",
      contract,
      { expectedFields: ["contentAngles"] }
    );
    expect(result.ok).toBe(true);
  });

  it("边界：undefined/null 值视同未提供（不算未声明）", () => {
    const result = validateHandoff(
      { businessSummary: "s", rogueField: undefined, other: null },
      "task_up",
      "task_down",
      contract
    );
    expect(result.ok).toBe(true);
    expect(result.accepted).toEqual({ businessSummary: "s" });
  });

  it("边界：空 payload + 无期望集 ⇒ 空交接通过（accepted 为空）", () => {
    const result = validateHandoff({}, "task_up", "task_down", contract);
    expect(result.ok).toBe(true);
    expect(result.acceptedFields).toEqual([]);
  });

  it("边界：非对象 payload ⇒ INVALID_PAYLOAD", () => {
    for (const bad of [null, undefined, "str", 42, ["a"]]) {
      const result = validateHandoff(bad, "task_up", "task_down", contract);
      expect(result.ok).toBe(false);
      expect(result.violations.map((v) => v.kind)).toEqual(["INVALID_PAYLOAD"]);
      expect(result.acceptedFields).toEqual([]);
    }
  });

  it("确定性：同输入两次调用结果字节一致", () => {
    const payload = { contentAngles: ["a"], rogue: "x", businessSummary: "s" };
    const first = validateHandoff(payload, "t1", "t2", contract, { expectedFields: ["missing"] });
    const second = validateHandoff(payload, "t1", "t2", contract, { expectedFields: ["missing"] });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("非法契约 fail loud（zod 校验，不静默放行）", () => {
    expect(() =>
      validateHandoff({}, "a", "b", { fields: [{ name: "x", type: "boolean" }] } as never)
    ).toThrow();
  });
});
