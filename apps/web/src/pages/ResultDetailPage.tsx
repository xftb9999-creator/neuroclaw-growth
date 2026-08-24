import { useEffect, useState } from "react";

import { getRun } from "../lib/api.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunRecord } from "../types.js";

export function ResultDetailPage(props: {
  runId: string;
  onRunAgain: (run: RunRecord) => void;
  onBackToStatus: (runId: string) => void;
}) {
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getRun(props.runId)
      .then((runRecord) => {
        setRun(runRecord as RunRecord);
        setError(null);
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : "Failed to load result")
      )
      .finally(() => setLoading(false));
  }, [props.runId]);

  return (
    <RouteLayout
      title="Result Detail"
      subtitle="Review the output payload and decide what to do next."
    >
      <ErrorBanner error={error} />
      {loading && (
        <div role="status" aria-live="polite" aria-busy={loading}>
          <Card>
            <div className="grid gap-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-6 w-1/2" />
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
              <Badge variant={statusToBadgeVariant(run.status)}>{run.status}</Badge>
            </CardHeader>
            <CardTitle data-testid="result-title">
              {run.templateType.replaceAll("_", " ")}
            </CardTitle>
            <CardContent>
              <p className="text-muted m-0">
                {run.failureReason ?? "Result payload is ready to inspect."}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => props.onBackToStatus(run.id)}>
                  Back to Status
                </Button>
                <Button
                  data-testid="run-again"
                  onClick={() => props.onRunAgain(run)}
                >
                  Run Again
                </Button>
              </div>
            </CardContent>
          </Card>
          <section aria-label="Result payload" className="grid gap-4 md:grid-cols-2">
            {Object.entries(run.outputPayload ?? {}).map(([key, value]) => (
              <Card key={key}>
                <CardHeader>
                  <Badge variant="info">{key}</Badge>
                </CardHeader>
                <pre className="text-sm text-ink overflow-auto m-0 whitespace-pre-wrap break-words">
                  {JSON.stringify(value, null, 2)}
                </pre>
              </Card>
            ))}
          </section>
        </>
      )}
    </RouteLayout>
  );
}
