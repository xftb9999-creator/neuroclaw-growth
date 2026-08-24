import { useEffect, useState } from "react";

import { approveRun, getRun, listApprovals } from "../lib/api.js";
import { useAiStream } from "../lib/useAiStream.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { ApprovalRequest, RunRecord } from "../types.js";

export function RunStatusPage(props: {
  runId: string;
  onViewResult: (runId: string) => void;
  onRunAgain: (run: RunRecord) => void;
}) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [loading, setLoading] = useState(true);

  const ai = useAiStream({});

  const load = async () => {
    try {
      const [runRecord, approvalItems] = await Promise.all([
        getRun(props.runId),
        listApprovals(props.runId)
      ]);
      setRun(runRecord as RunRecord);
      setApprovals(approvalItems as ApprovalRequest[]);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [props.runId]);

  const activeApproval = approvals.find((approval) => approval.status === "pending");

  return (
    <RouteLayout
      title="Run Status"
      subtitle="Review execution progress, approval state, and step-level outcomes."
    >
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
                {run.status}
              </Badge>
            </CardHeader>
            <CardContent>
              <p className="text-muted m-0">
                {run.failureReason ?? "Execution is ready for review."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button data-testid="refresh-run" variant="outline" onClick={() => void load()}>
                  Refresh
                </Button>
                {run.status === "completed" && (
                  <Button
                    data-testid="view-result"
                    onClick={() => props.onViewResult(run.id)}
                  >
                    View Result
                  </Button>
                )}
                <Button
                  data-testid="status-run-again"
                  variant="secondary"
                  onClick={() => props.onRunAgain(run)}
                >
                  Run Again
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardTitle>Step Timeline</CardTitle>
            <CardContent>
              <ol className="grid gap-3 list-none p-0 m-0">
                {(run.stepResults ?? []).map((step) => (
                  <li
                    key={step.stepId}
                    className="grid gap-1 border-l-2 border-line pl-3"
                  >
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <strong className="text-ink">{step.stepId}</strong>
                      <Badge variant={statusToBadgeVariant(step.status)}>
                        {step.status}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted m-0">{step.summary}</p>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>

          {activeApproval && (
            <Card>
              <CardHeader>
                <Badge variant="waiting">Approval Needed</Badge>
              </CardHeader>
              <CardTitle>{activeApproval.actionType}</CardTitle>
              <CardContent>
                <p className="text-muted m-0">{activeApproval.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    data-testid="approve-run"
                    disabled={isUpdating}
                    onClick={async () => {
                      setIsUpdating(true);
                      try {
                        const updated = (await approveRun(run.id, {
                          approved: true,
                          reviewerId: "operator_1"
                        })) as RunRecord;
                        setRun(updated);
                        await load();
                      } catch (error) {
                        setError(error instanceof Error ? error.message : "Approval failed");
                      } finally {
                        setIsUpdating(false);
                      }
                    }}
                  >
                    Approve
                  </Button>
                  <Button
                    data-testid="reject-run"
                    variant="secondary"
                    disabled={isUpdating}
                    onClick={async () => {
                      setIsUpdating(true);
                      try {
                        const updated = (await approveRun(run.id, {
                          approved: false,
                          reviewerId: "operator_1",
                          note: "Rejected from UI"
                        })) as RunRecord;
                        setRun(updated);
                        await load();
                      } catch (error) {
                        setError(error instanceof Error ? error.message : "Rejection failed");
                      } finally {
                        setIsUpdating(false);
                      }
                    }}
                  >
                    Reject
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {(run.status === "running" || run.status === "completed") && (
            <section aria-label="AI Preview Stream">
              <Card>
                <CardHeader>
                  <CardTitle>Stream AI Preview</CardTitle>
                  {ai.state.isMock && <Badge variant="info">Mock Mode</Badge>}
                </CardHeader>
                <CardContent>
                  {ai.state.status === "idle" && (
                    <Button
                      onClick={() => ai.stream(run.templateType, run.input)}
                      aria-label="Generate AI preview for this run"
                    >
                      Generate AI Preview
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
                          ? "Connecting to AI stream..."
                          : "Streaming AI output..."}
                      </p>
                      <Skeleton className="h-4 w-full" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-4 w-5/6" />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={ai.reset}
                        aria-label="Cancel AI preview stream"
                      >
                        Cancel
                      </Button>
                    </div>
                  )}

                  {ai.state.partial != null &&
                    (ai.state.status === "streaming" ||
                      ai.state.status === "connecting") && (
                      <pre
                        className="text-sm text-ink overflow-auto bg-bg rounded-input p-3 m-0 whitespace-pre-wrap break-words"
                        aria-live="polite"
                      >
                        {JSON.stringify(ai.state.partial, null, 2)}
                      </pre>
                    )}

                  {ai.state.status === "done" && (
                    <div role="status" aria-live="polite" className="grid gap-3">
                      {ai.state.result ? (
                        <pre className="text-sm text-ink overflow-auto bg-bg rounded-input p-3 m-0 whitespace-pre-wrap break-words">
                          {JSON.stringify(ai.state.result, null, 2)}
                        </pre>
                      ) : (
                        <p className="text-muted m-0">Stream completed.</p>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={ai.reset}
                        aria-label="Clear AI preview"
                      >
                        Clear
                      </Button>
                    </div>
                  )}

                  {ai.state.status === "error" && (
                    <div className="grid gap-3">
                      <div
                        role="alert"
                        aria-live="assertive"
                        className="bg-danger-light text-danger rounded-input p-3"
                      >
                        {ai.state.error}
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => ai.stream(run.templateType, run.input)}
                        aria-label="Retry AI preview"
                      >
                        Retry
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
