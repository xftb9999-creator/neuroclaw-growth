/**
 * AW-5 片 2 · 结构化交接校验（判据①③）——DAG-ready 纯函数。
 *
 * 依据：
 * - 方案稿 `.artifacts/proposals/2026-09-27-aw-5-plan.md` §三 片 2 / §二 ①③：
 *   `validateHandoff(payload, fromTask, toTask, downstreamInputContract)`——
 *   逐字段类型校验＋未声明字段拒绝；零 DB / 零 I/O、可单测。
 * - 设计源 `.artifacts/gm-report-20260922/agent-workforce.md` §3.3.2（:497-505）：
 *   「交接必须过契约校验：字段存在 + 类型匹配」；
 *   「交接不得携带超出下游 `inputContract` 的字段（防止上游产出污染下游 prompt）」。
 *
 * 语义（E2 判读，不发明业务语义）：
 * 1. 未声明字段拒绝（判据③）：payload 任一字段未出现在 downstreamInputContract
 *    声明集 ⇒ `UNDECLARED_FIELD`，该字段不进入 `accepted`。
 * 2. 类型校验（判据①）：声明内字段按 `ContractField.type`
 *    （string | string[] | number）逐字段验型 ⇒ 错配 `TYPE_MISMATCH`；
 *    口径与 shared `validateTemplateInputContract` 一致（零方言）。
 * 3. 期望字段存在性（可选 `options.expectedFields`，relay 以 `step.feedFrom`
 *    作为期望集）：期望字段缺失 ⇒ `MISSING_HANDOFF_FIELD`（设计源 :503
 *    「字段存在」；替代字符串拼接时代的静默丢字段）。
 * 4. `undefined` / `null` 值视同未提供（跳过，不算未声明）；`accepted` 仅含
 *    「声明内且验型通过」的字段投影，供调用方结构化注入。
 * 5. 确定性纯函数：violations 按 (field, kind) 排序、accepted 按字段名排序，
 *    同输入两次调用字节一致；`downstreamInputContract` 先过
 *    `templateInputContractSchema`（非法契约 fail loud）。
 *
 * 边界：不改 shared / TaskNode schema；不扩 TeamStep schema（片 2 采用
 * 「手写校验」承载 fromTask 语义，见留证）；经包根 barrel 导出供 relay 消费
 * （`duty-decision` 导出裁决维持「暂不导出」，二者独立）。
 */
import { templateInputContractSchema } from "@neuroclaw/shared";

import type { AgentContractField, AgentInputContract } from "./index.js";

export type HandoffViolationKind =
  | "INVALID_PAYLOAD"
  | "UNDECLARED_FIELD"
  | "TYPE_MISMATCH"
  | "MISSING_HANDOFF_FIELD";

export interface HandoffViolation {
  kind: HandoffViolationKind;
  /** 字段级违规携带字段名；payload 整体非法时为 null。 */
  field: string | null;
  detail: string;
}

export interface HandoffValidationOptions {
  /** 期望交接字段集（如 relay 的 `step.feedFrom`）；缺失即 MISSING_HANDOFF_FIELD。 */
  expectedFields?: readonly string[];
}

export interface HandoffValidationResult {
  ok: boolean;
  /** 交接来源标识（DAG：上游 taskId；relay：上游 runId）。 */
  fromTask: string;
  /** 交接目标标识（DAG：下游 taskId；relay：`step_<index>_<templateType>`）。 */
  toTask: string;
  violations: HandoffViolation[];
  /** 校验通过字段的投影（排序键；值为原始结构，未做字符串化）。 */
  accepted: Record<string, unknown>;
  /** 通过字段名（排序；供事件 `fields` / 审计复用）。 */
  acceptedFields: string[];
}

function describeValue(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

/** 与 shared `validateTemplateInputContract` 同口径的类型检查（零方言）。 */
function matchesContractFieldType(type: AgentContractField["type"], value: unknown): boolean {
  if (type === "string") return typeof value === "string";
  if (type === "string[]") {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
  }
  return typeof value === "number";
}

/**
 * 结构化交接校验：`payload` 字段必须 ⊆ `downstreamInputContract` 声明集且逐字段
 * 类型匹配；可选期望集必须齐全。返回确定性的违规清单与通过投影。
 */
export function validateHandoff(
  payload: unknown,
  fromTask: string,
  toTask: string,
  downstreamInputContract: AgentInputContract,
  options: HandoffValidationOptions = {}
): HandoffValidationResult {
  const contract = templateInputContractSchema.parse(downstreamInputContract);
  const violations: HandoffViolation[] = [];
  const accepted: Record<string, unknown> = {};

  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    violations.push({
      kind: "INVALID_PAYLOAD",
      field: null,
      detail: `交接 payload 必须是字段对象（收到 ${describeValue(payload)}）`
    });
  } else {
    const record = payload as Record<string, unknown>;
    const declared = new Map(contract.fields.map((field) => [field.name, field]));

    // 未声明拒绝（判据③）+ 类型校验（判据①）。
    for (const [field, value] of Object.entries(record)) {
      if (value === undefined || value === null) continue; // 视同未提供
      const declaration = declared.get(field);
      if (!declaration) {
        violations.push({
          kind: "UNDECLARED_FIELD",
          field,
          detail: `交接字段 ${field} 未在下游 inputContract 声明（禁止超出下游声明的字段）`
        });
        continue;
      }
      if (!matchesContractFieldType(declaration.type, value)) {
        violations.push({
          kind: "TYPE_MISMATCH",
          field,
          detail: `交接字段 ${field} 期望 ${declaration.type}，实收 ${describeValue(value)}`
        });
        continue;
      }
      accepted[field] = value;
    }

    // 期望字段存在性（设计源 :503）。
    for (const field of new Set(options.expectedFields ?? [])) {
      const value = record[field];
      if (value === undefined || value === null) {
        violations.push({
          kind: "MISSING_HANDOFF_FIELD",
          field,
          detail: `期望交接字段 ${field} 缺失（上游产出未携带）`
        });
      }
    }
  }

  violations.sort(
    (a, b) =>
      (a.field ?? "").localeCompare(b.field ?? "") || a.kind.localeCompare(b.kind)
  );
  const acceptedFields = Object.keys(accepted).sort();
  const acceptedSorted: Record<string, unknown> = {};
  for (const field of acceptedFields) {
    acceptedSorted[field] = accepted[field];
  }

  return {
    ok: violations.length === 0,
    fromTask,
    toTask,
    violations,
    accepted: acceptedSorted,
    acceptedFields
  };
}
