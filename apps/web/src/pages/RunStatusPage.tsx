import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { approveRun, cancelRun, getRun, listApprovals } from "../lib/api.js";
import { useAiStream } from "../lib/useAiStream.js";
import { useI18n } from "../lib/i18n.js";
import { getOperatorId } from "../lib/operator.js";
import { formatRunStatus } from "../lib/statusLabels.js";
import { useRunEventStream } from "../lib/useRunEventStream.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { Modal } from "../components/ui/Modal.js";
import { ErrorBanner, InfoBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import { InputSummaryStrip, PipelineStepper } from "../components/PipelineStepper.js";
import { ApprovalCard } from "../components/ApprovalCard.js";
import type { ApprovalRequest, RunRecord } from "../types.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function RunStatusPage(props: {
  runId: string;
  onViewResult: (runId: string) => void;
  onRunAgain: (run: RunRecord) => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [undoOpen, setUndoOpen] = useState(false);

  const ai = useAiStream({});

  const runQuery = useQuery({
    queryKey: ["run", props.runId],
    queryFn: async () => getRun(props.runId) as Promise<RunRecord>
  });
  const approvalsQuery = useQuery({
    queryKey: ["approvals", props.runId],
    queryFn: async () => listApprovals(props.runId) as Promise<ApprovalRequest[]>
  });

  const run = runQuery.data ?? null;
  const approvals = approvalsQuery.data ?? [];
  const loading = runQuery.isPending || approvalsQuery.isPending;

  // Round P/Q: live SSE push primary; 1.2s Query polling only as fallback
  // (stream disabled/failed) — always paused on hidden tabs.
  const onStreamUpdate = () => {
    void queryClient.invalidateQueries({ queryKey: ["run", props.runId] });
    void queryClient.invalidateQueries({ queryKey: ["approvals", props.runId] });
  };
  const streamHealth = useRunEventStream({
    runId: props.runId,
    enabled: Boolean(run && !TERMINAL_STATUSES.has(run.status)),
    onUpdate: onStreamUpdate
  });

  useEffect(() => {
    const active = Boolean(
      run && ["queued", "running"].includes(run.status) && streamHealth !== "live"
    );
    if (!active) return;
    const timer = window.setInterval(onStreamUpdate, 1_200);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.status, streamHealth]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["run", props.runId] });
    void queryClient.invalidateQueries({ queryKey: ["approvals", props.runId] });
  };

  const decide = useMutation({
    mutationFn: async (input: { approved: boolean; note?: string }) => {
      await approveRun(props.runId, {
        approved: input.approved,
        reviewerId: getOperatorId(),
        note: input.note
      });
    },
    onSuccess: refresh,
    onError: (mutationError) =>
      setError(mutationError instanceof Error ? mutationError.message : t("status.loadError")),
    onSettled: () => setIsUpdating(false)
  });

  const cancel = useMutation({
    mutationFn: async () => cancelRun(props.runId),
    onSuccess: refresh,
    onError: (cancelError) =>
      setError(cancelError instanceof Error ? cancelError.message : t("status.loadError")),
    onSettled: () => setIsUpdating(false)
  });

  const activeApproval = approvals.find((approval) => approval.status === "pending");

  return (
    <RouteLayout title={t("status.title")} subtitle={t("status.subtitle")}>
      <ErrorBanner error={error} />
      {loading && (
        <div role="status" aria-live="polite" aria-busy={loading}>
          <Card>
            <div className="grid gap-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-10 w-48" />
            </div>
          </Card>
        </div>
      )}
      {run && (
        <>
          <Card>
            <CardHeader>
              <Badge variant={statusToBadgeVariant(run.status)} data-testid="run-status">
                {formatRunStatus(run.status, locale)}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="mb-3">
                <InputSummaryStrip input={run.input} />
              </div>
              <p className="text-muted m-0">
                {run.failureReason ?? t("status.readyForReview")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => window.history.back()} aria-label={t("common.back")}>
                  �?{t("common.back")}
                </Button>
                <Button data-testid="refresh-run" variant="outline" onClick={refresh}>
                  {t("status.refresh")}
                </Button>
                {run.status === "completed" && (
                  <Button
                    data-testid="view-result"
                    onClick={() => props.onViewResult(run.id)}
                  >
                    {t("status.viewResult")}
                  </Button>
                )}
                <Button
                  data-testid="status-run-again"
                  variant="secondary"
                  onClick={() => props.onRunAgain(run)}
                >
                  {t("status.runAgain")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardTitle>{t("status.stepTimeline")}</CardTitle>
            <CardContent>
              <PipelineStepper run={run} />
            </CardContent>
          </Card>

          {run.status === "cancelled" && <InfoBanner message={t("approval.cancelledNote")} />}

          {activeApproval && (
            <ApprovalCard
              actionType={activeApproval.actionType}
              reason={activeApproval.reason}
              input={run.input}
              busy={isUpdating}
              onApprove={async () => {
                setIsUpdating(true);
                await decide.mutateAsync({ approved: true });
              }}
              onReject={async (reasonLabel) => {
                setIsUpdating(true);
                await decide.mutateAsync({ approved: false, note: reasonLabel });
              }}
            />
          )}

          {/* 撤回窗口:排队/待审�?执行中均可撤销(Round L) */}
          {["queued", "running", "waiting_approval"].includes(run.status) && (
            <div className="flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                data-testid="undo-run"
                disabled={isUpdating}
                onClick={() => setUndoOpen(true)}
              >
                �?{t("approval.undo")}
              </Button>
            </div>
          )}

          <Modal
            open={undoOpen}
            danger
            title={t("approval.undoConfirmTitle")}
            confirmLabel={t("approval.undoYes")}
            onClose={() => setUndoOpen(false)}
            onConfirm={() => {
              setUndoOpen(false);
              setIsUpdating(true);
              void cancel.mutateAsync();
            }}
          >
            <p className="m-0">{t("approval.undoConfirmBody")}</p>
          </Modal>

          {(run.status === "running" || run.status === "completed") && (
            <section aria-label={t("status.stream.title")}>
              <Card>
                <CardHeader>
                  <CardTitle>{t("status.stream.title")}</CardTitle>
                  {ai.state.isMock && <Badge variant="info">{t("status.stream.mock")}</Badge>}
                </CardHeader>
                <CardContent>
                  {ai.state.status === "idle" && (
                    <Button
                      onClick={() => ai.stream(run.templateType, run.input)}
                      aria-label={t("status.stream.generate")}
                    >
                      {t("status.stream.generate")}
                    </Button>
                  )}

                  {(ai.state.status === "connecting" || ai.state.status === "streaming") && (
                    <div
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                      className="grid gap-3"
                    >
                      <p className="text-sm text-muted m-0">
                        {ai.state.status === "connecting"
                          ? t("status.stream.connecting")
                          : t("status.stream.streaming")}
                      </p>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-5/6" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={ai.reset}
                        aria-label={t("status.stream.cancel")}
                      >
                        {t("status.stream.cancel")}
                      </Button>
                    </div>
                  )}

                  {ai.state.partial != null &&
                    (ai.state.status === "streaming" ||
                      ai.state.status === "connecting") && (
                      <pre
                        className="text-sm text-ink overflow-auto bg-bg-elev border border-line rounded-input p-3 m-0 whitespace-pre-wrap break-words"
                        aria-live="polite"
                      >
                        {JSON.stringify(ai.state.partial, null, 2)}
                      </pre>
                    )}

                  {ai.state.status === "done" && (
                    <div role="status" aria-live="polite" className="grid gap-3">
                      {ai.state.result ? (
                        <pre className="text-sm text-ink overflow-auto bg-bg-elev border border-line rounded-input p-3 m-0 whitespace-pre-wrap break-words">
                          {JSON.stringify(ai.state.result, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-muted m-0">{t("status.stream.done")}</p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={ai.reset}
                        aria-label={t("status.stream.clear")}
                      >
                        {t("status.stream.clear")}
                      </Button>
                    </div>
                  )}

                  {ai.state.status === "error" && (
                    <div className="grid gap-3">
                      <div
                        role="alert"
                        aria-live="assertive"
                        className="bg-danger-light text-danger rounded-input p-3 border border-danger/25"
                      >
                        {ai.state.error}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => ai.stream(run.templateType, run.input)}
                        aria-label={t("status.stream.retry")}
                      >
                        {t("status.stream.retry")}
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            </section>
          )}
        </>
      )}
    </RouteLayout>
  );
}
