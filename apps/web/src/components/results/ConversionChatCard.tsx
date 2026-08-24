import { useState } from "react";

import { useI18n } from "../../lib/i18n.js";

/**
 * 转化员工富渲染:把 conversionDraft 渲染成企微私聊气泡预览,
 * 支持一键复制;审批预览状态以时间线呈现。
 */
export function ConversionChatCard(props: {
  payload: Record<string, unknown>;
  input: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  const draft = String(
    props.payload.conversionDraft ?? props.payload.approvalPreview ?? ""
  ).trim();
  if (!draft) return null;

  const lead = String(props.input.targetCustomer ?? "").trim();
  const displayName = lead || "客户";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // clipboard unavailable — ignore
    }
  };

  return (
    <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr] items-start">
      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="text-[13px] font-semibold text-muted">
            {t("render.chatCaption")}
          </span>
          <button
            type="button"
            onClick={() => void copy()}
            className="text-[13px] font-semibold text-white border-0 cursor-pointer rounded-pill px-3.5 py-1.5 bg-gradient-to-br from-brand to-brand-dark shadow-[0_6px_16px_rgba(189,79,34,0.3)] hover:brightness-110 transition"
          >
            {copied ? t("render.copied") : t("render.copy")}
          </button>
        </div>

        <div className="chat-window">
          <div className="flex gap-2.5">
            <span className="chat-avatar" aria-hidden="true">🧑</span>
            <div className="chat-bubble-in">
              <div className="text-[12px] font-semibold text-brand mb-1">{displayName}</div>
              {draft}
            </div>
          </div>
          <div className="flex justify-end">
            <div className="max-w-[70%] bg-gradient-to-br from-brand to-brand-dark text-white rounded-[16px_4px_16px_16px] px-3.5 py-2 text-[13px] shadow-sm">
              👍 看起来不错,发我一个链接
            </div>
          </div>
        </div>
      </div>

      <div className="glass p-4 grid gap-3">
        <span className="inline-flex w-fit items-center gap-2 text-[13px] font-semibold text-ok bg-ok-light rounded-pill px-3 py-1">
          ⛨ {t("render.approvalReady")}
        </span>
        <ol className="m-0 pl-5 grid gap-2 text-[13.5px] text-muted leading-relaxed list-decimal">
          <li>{t("status.approve")} → preview-send 执行投递(webhook / SMTP)</li>
          <li>投递失败自动进入重试队列(指数退避)</li>
          <li>全程写入审计日志,可回放追溯</li>
        </ol>
        <p className="m-0 text-[12px] text-muted/80">
          offerAsset: {String(props.input.offerAsset ?? "-")}
        </p>
      </div>
    </div>
  );
}
