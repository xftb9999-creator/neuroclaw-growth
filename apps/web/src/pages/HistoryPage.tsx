import { useEffect, useState } from "react";

import { listRunHistory } from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { navigate } from "../lib/router.js";
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
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const items = (await listRunHistory(props.workspaceId)) as RunRecord[];
      setRuns(items);
      setError(null);
    } catch (error) {
      if (isWorkspaceMissingError(error)) {
        props.onWorkspaceMissing(
          "Your workspace expired after a backend reset. Create a new workspace to reload history."
        );
        return;
      }
      setError(error instanceof Error ? error.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [props.workspaceId]);

  return (
    <RouteLayout
      title="Run History"
      subtitle="Review previous runs, inspect outcomes, and reuse a working input set."
    >
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
          title="No runs yet"
          body="Launch your first Growth run to start building reusable execution history."
          action={
            <Button variant="secondary" onClick={() => navigate("/templates")}>
              Go to Templates
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
                      <Badge variant="info">
                        {run.templateType.replaceAll("_", " ")}
                      </Badge>
                    </CardHeader>
                    <h3 className="text-base font-semibold m-0">{run.id}</h3>
                    <p className="text-sm text-muted m-0">
                      {run.outputSummary ?? run.failureReason ?? "No summary available yet."}
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
                        Open
                      </Button>
                      <Button
                        data-testid={`clone-${run.id}`}
                        variant="secondary"
                        size="sm"
                        onClick={() => void props.onReuse(run.id)}
                      >
                        Clone
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
