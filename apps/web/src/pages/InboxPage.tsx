import { useCallback, useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  approveRun,
  getRun,
  listPendingApprovals,
  type PendingApproval
} from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { useI18n } from "../lib/i18n.js";
import { getOperatorId } from "../lib/operator.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";
import { ApprovalCard } from "../components/ApprovalCard.js";

export function InboxPage(props: {
  workspaceId?: string;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const itemsQuery = useQuery({
    queryKey: ["pending-approvals", props.workspaceId ?? "all"],
    queryFn: async () => (await listPendingApprovals(props.workspaceId)) as PendingApproval[],
    refetchInterval: 5_000,
    refetchIntervalInBackground: false
  });

  useEffect(() => {
    if (itemsQuery.error) {
      setError(
        itemsQuery.error instanceof Error && !isWorkspaceMissingError(itemsQuery.error)
          ? itemsQuery.error.message
          : t("history.loadError")
      );
    }
  }, [itemsQuery.error, t]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pending-approvals"] });
    void queryClient.invalidateQueries({ queryKey: ["pending-approvals-badge"] });
    void queryClient.invalidateQueries({ queryKey: ["run"] });
  };

  const approve = useMutation({
    mutationFn: async (runId: string) => {
      await approveRun(runId, { approved: true, reviewerId: getOperatorId(), note: "inbox approve" });
    },
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : t("status.loadError")),
    onSettled: () => setBusyId(null)
  });

  const reject = useMutation({
    mutationFn: async (input: { runId: string; reasonLabel: string }) => {
      await approveRun(input.runId, {
        approved: false,
        reviewerId: getOperatorId(),
        note: input.reasonLabel
      });
    },
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof Error ? e.message : t("status.loadError")),
    onSettled: () => setBusyId(null)
  });

  const items = itemsQuery.data ?? [];

  return (
    <RouteLayout title={t("inbox.title")} subtitle={t("inbox.subtitle")}>
      <ErrorBanner error={error} />
      {itemsQuery.isPending ? (
        <div className="grid gap-3">
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index}><Skeleton className="h-16 w-full" /></Card>
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState title={t("inbox.emptyTitle")} body={t("inbox.emptyBody")} />
      ) : (
        <div className="grid gap-3">
          {items.map((item) => (
            <div key={item.approvalId} className="grid gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Badge variant="default">{t(`templates.names.${item.run.templateType}`)}</Badge>
                <span className="text-[12px] text-muted ml-auto">
                  {new Date(item.requestedAt).toLocaleString()}
                </span>
                <Button size="sm" variant="ghost" onClick={() => props.onOpenRun(item.run.id)}>
                  {t("library.open")} 鈫?                </Button>
              </div>
              <ApprovalCard
                actionType={item.actionType}
                reason={item.reason}
                busy={busyId === item.approvalId}
                onFetchInput={async () => {
                  const run = (await getRun(item.run.id)) as import("../types.js").RunRecord;
                  return run.input;
                }}
                onApprove={() => {
                  setBusyId(item.approvalId);
                  return approve.mutateAsync(item.run.id);
                }}
                onReject={(reasonLabel) => {
                  setBusyId(item.approvalId);
                  return reject.mutateAsync({ runId: item.run.id, reasonLabel });
                }}
              />
            </div>
          ))}
        </div>
      )}
    </RouteLayout>
  );
}


