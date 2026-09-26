import { useState } from "react";

import { useI18n } from "../lib/i18n.js";
import { Button } from "./ui/Button.js";
import { Badge } from "./ui/Input.js";
import { Card, CardContent } from "./ui/Card.js";
import { Modal } from "./ui/Modal.js";
import { InputSummaryStrip } from "./PipelineStepper.js";

const REJECT_REASON_KEYS = [
  "approval.reject.reason.content",
  "approval.reject.reason.timing",
  "approval.reject.reason.edit",
  "approval.reject.reason.other"
] as const;

/**
 * 审批卡四要素(Round L, audit P1-4/P0-E2):
 * ① 将执行内容的全文预览 ② 目标渠道徽章 ③ 人话版风险原因(附系统判定)
 * ④ 批准二次确认 + 拒绝原因必选。
 */
export function ApprovalCard(props: {
  actionType: string;
  reason: string;
  input?: Record<string, unknown>;
  onFetchInput?: () => Promise<Record<string, unknown>>;
  busy?: boolean;
  onApprove: () => Promise<void>;
  onReject: (reasonLabel: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState<string>(REJECT_REASON_KEYS[0]);
  const [input, setInput] = useState<Record<string, unknown> | undefined>(props.input);
  const [loadingInput, setLoadingInput] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const specificReason = t(`approval.humanReason.${props.actionType}`);
  const humanReason = specificReason.startsWith("approval.humanReason.")
    ? t("approval.humanReason.default")
    : specificReason;

  const channels = Array.isArray(input?.preferredChannels)
    ? (input!.preferredChannels as string[])
    : [];

  const expandPreview = async () => {
    if (input || !props.onFetchInput) {
      setInput(input ?? props.input);
      return;
    }
    setLoadingInput(true);
    try {
      setInput(await props.onFetchInput());
      setError(null);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : t("history.loadError"));
    } finally {
      setLoadingInput(false);
    }
  };

  return (
    <>
      <Card className="border-brand-dark/30">
        <CardContent className="grid gap-2.5">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="waiting">{t("status.approvalNeeded")}</Badge>
            <span className="text-[12px] font-mono text-muted">{props.actionType}</span>
          </div>

          {/* ③ 人话版风险原因 */}
          <p className="m-0 text-[14.5px] font-medium leading-snug">{humanReason}</p>
          <p className="m-0 text-[12.5px] text-muted">
            {t("approval.rawReasonPrefix")}
            {props.reason}
          </p>

          {/* ② 目标渠道 */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[12.5px] text-muted">{t("approval.channelsLabel")}:</span>
            {channels.length === 0 ? (
              <span className="text-[12.5px] text-muted">{t("approval.noChannels")}</span>
            ) : (
              channels.map((channel) => (
                <Badge key={channel} variant="default">
                  {channel}
                </Badge>
              ))
            )}
          </div>

          {/* ① 全文预览 */}
          {!input && props.onFetchInput && (
            <Button size="sm" variant="outline" onClick={() => void expandPreview()} disabled={loadingInput}>
              {loadingInput ? t("common.loading") : t("approval.previewTitle")} ↕
            </Button>
          )}
          {input && (
            <details open className="grid gap-2">
              <summary className="cursor-pointer text-[13px] font-semibold text-brand select-none">
                {t("approval.previewTitle")}
              </summary>
              <div className="rounded-input bg-surface-strong/40 border border-line p-3">
                <InputSummaryStrip input={input} />
              </div>
            </details>
          )}

          {error && (
            <div role="alert" className="text-danger text-[12.5px]">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2 mt-1">
            <Button size="sm" data-testid="approve-run" disabled={props.busy} onClick={() => setConfirmOpen(true)}>
              ✓ {t("status.approve")}
            </Button>
            <Button size="sm" variant="danger" data-testid="reject-run" disabled={props.busy} onClick={() => setRejectOpen(true)}>
              ✕ {t("status.reject")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ④a 批准二次确认 */}
      <Modal
        open={confirmOpen}
        title={t("approval.confirmTitle")}
        confirmLabel={t("approval.confirmYes")}
        confirmTestId="confirm-approve-run"
        onClose={() => setConfirmOpen(false)}
        onConfirm={async () => {
          setConfirmOpen(false);
          await props.onApprove();
        }}
      >
        <p className="m-0">{t("approval.confirmBody")}</p>
        <p className="m-0 text-[12.5px]">{humanReason}</p>
      </Modal>

      {/* ④b 拒绝原因必选 */}
      <Modal
        open={rejectOpen}
        danger
        title={t("approval.rejectTitle")}
        confirmLabel={t("approval.rejectConfirm")}
        confirmTestId="confirm-reject-run"
        onClose={() => setRejectOpen(false)}
        onConfirm={async () => {
          setRejectOpen(false);
          await props.onReject(t(rejectReason));
        }}
      >
        <div role="radiogroup" aria-label={t("approval.rejectTitle")} className="grid gap-1.5">
          {REJECT_REASON_KEYS.map((key) => (
            <label key={key} className="flex items-center gap-2 cursor-pointer text-[14px]">
              <input
                type="radio"
                name={`reject-reason-${props.actionType}`}
                value={key}
                checked={rejectReason === key}
                onChange={() => setRejectReason(key)}
              />
              {t(key)}
            </label>
          ))}
        </div>
      </Modal>
    </>
  );
}
