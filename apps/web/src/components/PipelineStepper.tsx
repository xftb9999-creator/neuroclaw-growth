import { useMemo } from "react";

import { useI18n } from "../lib/i18n.js";
import type { RunRecord, TemplateType } from "../types.js";

interface PipelineNode {
  key: string;
  label: string;
  state: "done" | "active" | "pending" | "failed" | "waiting";
  detail?: string;
}

const PIPELINE_BY_TEMPLATE: Record<TemplateType, Array<{ key: string; actionType?: string }>> = {
  content_acquisition: [
    { key: "pipeline.preflight" },
    { key: "pipeline.extract", actionType: "browser_extract" },
    { key: "pipeline.generate", actionType: "mcp_generate_brief" },
    { key: "pipeline.deliver" }
  ],
  private_conversion: [
    { key: "pipeline.preflight" },
    { key: "pipeline.generate", actionType: "mcp_generate_conversion_copy" },
    { key: "pipeline.approval", actionType: "notification_send_preview" },
    { key: "pipeline.deliver" }
  ],
  weekly_review: [
    { key: "pipeline.preflight" },
    { key: "pipeline.extract", actionType: "browser_extract" },
    { key: "pipeline.generate", actionType: "mcp_generate_review" },
    { key: "pipeline.deliver" }
  ]
};

/**
 * 执行链路可视化 — 竖版 Stepper,按 run.stepResults 与状态逐节点点亮。
 */
export function PipelineStepper(props: { run: RunRecord }) {
  const { t } = useI18n();
  const run = props.run;

  const nodes = useMemo<PipelineNode[]>(() => {
    const blueprint = PIPELINE_BY_TEMPLATE[run.templateType];
    const stepByAction = new Map(
      (run.stepResults ?? []).map((step) => [step.actionType, step])
    );

    return blueprint.map((node, index) => {
      const matched = node.actionType ? stepByAction.get(node.actionType) : undefined;

      let state: PipelineNode["state"] = "pending";
      if (run.status === "failed") {
        state = matched?.status === "completed" ? "done" : index === 0 ? "done" : "failed";
      } else if (matched) {
        state =
          matched.status === "completed"
            ? "done"
            : matched.status === "waiting_approval"
              ? "waiting"
              : matched.status === "failed"
                ? "failed"
                : "active";
        if (matched.status === "degraded") state = "done";
      } else if (index === 0 && ["running", "queued", "waiting_approval"].includes(run.status)) {
        state = "done";
      } else if (run.status === "completed") {
        state = "done";
      }

      // 找到第一个非完成节点标记为 active(进行中观感)
      return {
        key: node.key,
        label: t(node.key),
        state,
        detail: matched?.summary
      };
    });
  }, [run, t]);

  // 将首个 pending 节点在运行中态显示为 active
  const activeIndex = nodes.findIndex((node) => node.state === "pending");
  const display = nodes.map((node, index) =>
    node.state === "pending" &&
    ["running", "queued"].includes(run.status) &&
    index === activeIndex
      ? { ...node, state: "active" as const }
      : node
  );

  const iconFor = (state: PipelineNode["state"]) =>
    state === "done" ? "✓" : state === "active" ? "●" : state === "waiting" ? "⏸" : state === "failed" ? "✕" : "○";

  const colorFor = (state: PipelineNode["state"]) =>
    state === "done"
      ? "bg-ok-light text-ok border-ok/30"
      : state === "active"
        ? "bg-brand-light text-brand border-brand/40"
        : state === "waiting"
          ? "bg-warn-light text-warn border-warn/30"
          : state === "failed"
            ? "bg-danger-light text-danger border-danger/30"
            : "bg-surface-strong text-muted border-line";

  return (
    <ol className="m-0 p-0 list-none grid gap-0" aria-label={t("status.stepTimeline")}>
      {display.map((node, index) => (
        <li key={node.key} className="flex gap-3.5">
          <div className="flex flex-col items-center">
            <span
              className={`inline-flex w-8 h-8 items-center justify-center rounded-full border text-[14px] font-bold ${colorFor(node.state)} ${
                node.state === "active" ? "pulse-dot" : ""
              }`}
              aria-hidden="true"
            >
              {iconFor(node.state)}
            </span>
            {index < display.length - 1 && (
              <span
                className={`w-[2px] flex-1 min-h-[26px] my-1 rounded ${
                  display[index + 1].state === "pending" || node.state !== "done"
                    ? "bg-line"
                    : "bg-ok/50"
                }`}
                aria-hidden="true"
              />
            )}
          </div>
          <div className="pb-5 pt-1">
            <div className={`text-[14.5px] font-semibold ${node.state === "pending" ? "text-muted" : ""}`}>
              {node.label}
            </div>
            {node.detail && (
              <p className="m-0 mt-0.5 text-[12.5px] text-muted leading-snug max-w-md">{node.detail}</p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** 结构化输入摘要条 */
export function InputSummaryStrip(props: { input: Record<string, unknown> }) {
  const { t } = useI18n();
  const channels = Array.isArray(props.input.preferredChannels)
    ? (props.input.preferredChannels as string[])
    : [];

  const chips: Array<{ label: string; value: string }> = [];
  const business = String(props.input.businessSummary ?? "").trim();
  const audience = String(props.input.targetCustomer ?? "").trim();
  if (business) chips.push({ label: t("fields.businessSummary"), value: business });
  if (audience) chips.push({ label: t("fields.targetCustomer"), value: audience });
  for (const channel of channels) {
    chips.push({ label: t("fields.preferredChannels"), value: channel });
  }
  if (typeof props.input.offerAsset === "string" && props.input.offerAsset.trim()) {
    chips.push({ label: t("fields.offerAsset"), value: props.input.offerAsset });
  }

  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((chip, index) => (
        <span
          key={`${chip.label}-${index}`}
          className="text-[12px] bg-surface-strong text-muted rounded-pill px-2.5 py-1"
        >
          <b className="text-ink/70 font-semibold">{chip.label}</b> · {chip.value.slice(0, 40)}
          {chip.value.length > 40 ? "…" : ""}
        </span>
      ))}
    </div>
  );
}
