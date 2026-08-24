import { useCallback, useEffect, useState } from "react";

import {
  approveRun,
  listPendingApprovals,
  type PendingApproval
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";

export function InboxPage(props: {
  workspaceId?: string;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<PendingApproval[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const items = (await listPendingApprovals(props.workspaceId)) as PendingApproval[];
      setItems(items);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
  }, [props.workspaceId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (approvalId: string, runId: string, approved: boolean) => {
    setBusyId(approvalId);
    try {
      await approveRun(runId, { approved, reviewerId: "operator_1", note: approved ? "inbox approve" : "inbox reject" });
      await load();
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : t("status.loadError"));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <RouteLayout title={t("inbox.title")} subtitle={t("inbox.subtitle")}>
      <ErrorBanner error={error} />
      {loading ? (
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
            <Card key={item.approvalId} className="glass-hover lift">
              <CardContent className="grid gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="waiting">{t("status.approvalNeeded")}</Badge>
                  <Badge variant="default">{t(`templates.names.${item.run.templateType}`)}</Badge>
                  <span className="text-[12px] text-muted ml-auto">
                    {new Date(item.requestedAt).toLocaleString()}
                  </span>
                </div>
                <p className="m-0 text-[14.5px] leading-snug">
                  {item.run.businessSummary || item.run.id}
                </p>
                <p className="m-0 text-[12.5px] text-muted">{item.reason}</p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busyId === item.approvalId}
                    onClick={() => void decide(item.approvalId, item.run.id, true)}
                  >
                    ✓ {t("status.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busyId === item.approvalId}
                    onClick={() => void decide(item.approvalId, item.run.id, false)}
                  >
                    ✕ {t("status.reject")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => props.onOpenRun(item.run.id)}>
                    {t("library.open")} →
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </RouteLayout>
  );
}
