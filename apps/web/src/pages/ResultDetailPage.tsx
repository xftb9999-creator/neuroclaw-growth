import { useEffect, useState } from "react";

import { getRun } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import { ContentNoteCard } from "../components/results/ContentNoteCard.js";
import { ConversionChatCard } from "../components/results/ConversionChatCard.js";
import { ReviewDashboard } from "../components/results/ReviewDashboard.js";
import type { RunRecord } from "../types.js";

export function ResultDetailPage(props: {
  runId: string;
  onRunAgain: (run: RunRecord) => void;
  onBackToStatus: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    getRun(props.runId)
      .then((runRecord) => {
        setRun(runRecord as RunRecord);
        setError(null);
      })
      .catch((loadError: unknown) =>
        setError(loadError instanceof Error ? loadError.message : t("result.loadError"))
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runId]);

  return (
    <RouteLayout title={t("result.title")} subtitle={t("result.subtitle")}>
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
                {run.failureReason ?? t("result.readyToInspect")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => props.onBackToStatus(run.id)}>
                  {t("result.backToStatus")}
                </Button>
                <Button
                  data-testid="run-again"
                  onClick={() => props.onRunAgain(run)}
                >
                  {t("result.runAgain")}
                </Button>
              </div>
            </CardContent>
          </Card>
          <section aria-label={t("result.payloadSection")} className="grid gap-4">
            {run.outputPayload && !showRaw && (
              <>
                {run.templateType === "content_acquisition" && (
                  <ContentNoteCard payload={run.outputPayload} input={run.input} />
                )}
                {run.templateType === "private_conversion" && (
                  <ConversionChatCard payload={run.outputPayload} input={run.input} />
                )}
                {run.templateType === "weekly_review" && (
                  <ReviewDashboard payload={run.outputPayload} input={run.input} />
                )}
              </>
            )}

            {showRaw &&
              Object.entries(run.outputPayload ?? {}).map(([key, value]) => (
                <Card key={key}>
                  <CardHeader>
                    <Badge variant="default">{key}</Badge>
                  </CardHeader>
                  <pre className="text-sm text-ink overflow-auto m-0 whitespace-pre-wrap break-words">
                    {JSON.stringify(value, null, 2)}
                  </pre>
                </Card>
              ))}

            <div>
              <Button variant="ghost" size="sm" onClick={() => setShowRaw((current) => !current)}>
                {showRaw ? `▾ ${t("render.rawHide")}` : `▸ ${t("render.rawToggle")}`}
              </Button>
            </div>
          </section>
        </>
      )}
    </RouteLayout>
  );
}
