import { useEffect, useState } from "react";

import { listRunHistory } from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { navigate } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardHeader } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunRecord } from "../types.js";

export function HistoryPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
  onReuse: (runId: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const items = (await listRunHistory(props.workspaceId)) as RunRecord[];
      setRuns(items);
      setError(null);
    } catch (loadError) {
      if (isWorkspaceMissingError(loadError)) {
        props.onWorkspaceMissing(t("history.workspaceExpired"));
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  return (
    <RouteLayout title={t("history.title")} subtitle={t("history.subtitle")}>
      <ErrorBanner error={error} />
      {loading && (
        <div
          role="status"
          aria-live="polite"
          aria-busy={loading}
          className="grid gap-4"
        >
          {Array.from({ length: 3 }).map((_, index) => (
            <Card key={`skeleton-${index}`}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div className="grid gap-2 flex-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-5 w-1/2" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
                <div className="grid gap-2 items-end">
                  <Skeleton className="h-6 w-24" />
                  <Skeleton className="h-10 w-32" />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      {!loading && runs.length === 0 ? (
        <EmptyState
          title={t("history.emptyTitle")}
          body={t("history.emptyBody")}
          action={
            <Button variant="secondary" onClick={() => navigate("/templates")}>
              {t("history.goTemplates")}
            </Button>
          }
        />
      ) : (
        !loading && (
          <div className="grid gap-4">
            {runs.map((run) => (
              <Card key={run.id}>
                <div className="flex items-start justify-between gap-4 flex-wrap">
                  <div className="grid gap-1 flex-1 min-w-[200px]">
                    <CardHeader>
                      <Badge variant="default">
                        {t(`templates.names.${run.templateType}`)}
                      </Badge>
                    </CardHeader>
                    <h3 className="text-base font-semibold m-0">{run.id}</h3>
                    <p className="text-sm text-muted m-0">
                      {run.outputSummary ?? run.failureReason ?? t("history.noSummary")}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge variant={statusToBadgeVariant(run.status)}>
                      {run.status}
                    </Badge>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        data-testid={`open-${run.id}`}
                        size="sm"
                        onClick={() => props.onOpenRun(run.id)}
                      >
                        {t("history.open")}
                      </Button>
                      <Button
                        data-testid={`clone-${run.id}`}
                        variant="secondary"
                        size="sm"
                        onClick={() => void props.onReuse(run.id)}
                      >
                        {t("history.clone")}
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )
      )}
    </RouteLayout>
  );
}
