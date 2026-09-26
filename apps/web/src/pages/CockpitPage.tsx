import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getAnalyticsOverview,
  listArtifacts,
  listPendingApprovals,
  listRunHistory,
  type AnalyticsOverview,
  type ArtifactRecord,
  type PendingApproval
} from "../lib/api.js";
import { latestCockpitRuns, summarizeCockpitRuns } from "../lib/cockpit.js";
import { navigate } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunRecord } from "../types.js";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatDate(value: string | undefined, locale: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
}

function QueryMessage(props: { testId: string; title: string; body: string; tone?: "error" | "empty" }) {
  return (
    <div
      data-testid={props.testId}
      className={props.tone === "error" ? "rounded-input border border-danger/25 bg-danger-light p-3 grid gap-1" : "rounded-input border hairline bg-surface-strong/40 p-3 grid gap-1"}
      role={props.tone === "error" ? "alert" : "status"}
    >
      <strong className="text-sm">{props.title}</strong>
      <span className="text-sm text-muted">{props.body}</span>
    </div>
  );
}

function Metric(props: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-input border hairline p-3 grid gap-1 min-w-0">
      <span className="text-[12px] text-muted">{props.label}</span>
      <strong className="text-2xl tracking-tight truncate">{props.value}</strong>
      {props.hint && <span className="text-[12px] text-muted truncate">{props.hint}</span>}
    </div>
  );
}

function runLabel(status: string, t: (key: string) => string): string {
  const key = `cockpit.status.${status}`;
  const translated = t(key);
  return translated === key ? status : translated;
}

function templateLabel(templateType: string, t: (key: string) => string): string {
  const key = `templates.names.${templateType}`;
  const translated = t(key);
  return translated === key ? templateType : translated;
}

function RunsModule(props: {
  runs: RunRecord[] | undefined;
  pending: boolean;
  error: unknown;
  summary: ReturnType<typeof summarizeCockpitRuns>;
  latest: RunRecord[];
  locale: string;
  onOpenRun: (runId: string) => void;
  t: (key: string) => string;
}) {
  const { t } = props;
  return (
    <Card data-testid="cockpit-execution">
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle className="text-[15.5px]">{t("cockpit.execution.title")}</CardTitle>
          <span className="text-[12px] text-muted">{t("cockpit.execution.subtitle")}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate("/history")}>{t("cockpit.viewAll")}</Button>
      </CardHeader>
      <CardContent>
        {props.pending ? (
          <Skeleton className="h-24 w-full" />
        ) : props.error ? (
          <QueryMessage testId="cockpit-runs-error" title={t("cockpit.loadError")} body={String(props.error)} tone="error" />
        ) : !props.runs?.length ? (
          <QueryMessage testId="cockpit-runs-empty" title={t("cockpit.execution.emptyTitle")} body={t("cockpit.execution.emptyBody")} />
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-2">
              <Metric label={t("cockpit.metric.total")} value={String(props.summary.total)} />
              <Metric label={t("cockpit.metric.completed")} value={String(props.summary.completed)} />
              <Metric label={t("cockpit.metric.active")} value={String(props.summary.active)} />
              <Metric label={t("cockpit.metric.waiting")} value={String(props.summary.waiting)} />
              <Metric label={t("cockpit.metric.failed")} value={String(props.summary.failed)} />
              <Metric label={t("cockpit.metric.outputs")} value={String(props.summary.outputs)} />
            </div>
            <div className="grid gap-2 pt-1">
              {props.latest.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  data-testid="cockpit-run-row"
                  className="w-full text-left rounded-input border hairline p-3 bg-transparent hover:bg-surface-strong/60 cursor-pointer grid gap-1"
                  onClick={() => props.onOpenRun(run.id)}
                >
                  <span className="flex items-center gap-2 flex-wrap min-w-0">
                    <strong className="text-sm truncate">{templateLabel(run.templateType, t)}</strong>
                    <Badge variant={statusToBadgeVariant(run.status)}>{runLabel(run.status, t)}</Badge>
                    <span className="text-[12px] text-muted ml-auto">{formatDate(run.updatedAt ?? run.createdAt, props.locale)}</span>
                  </span>
                  <span className="text-[12px] text-muted truncate">{run.outputSummary || run.failureReason || t("cockpit.execution.noSummary")}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ApprovalsModule(props: {
  approvals: PendingApproval[] | undefined;
  pending: boolean;
  error: unknown;
  t: (key: string) => string;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = props;
  return (
    <Card data-testid="cockpit-approvals">
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle className="text-[15.5px]">{t("cockpit.approvals.title")}</CardTitle>
          <span className="text-[12px] text-muted">{t("cockpit.approvals.subtitle")}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate("/inbox")}>{t("cockpit.viewAll")}</Button>
      </CardHeader>
      <CardContent>
        {props.pending ? <Skeleton className="h-20 w-full" /> : props.error ? (
          <QueryMessage testId="cockpit-approvals-error" title={t("cockpit.loadError")} body={String(props.error)} tone="error" />
        ) : !props.approvals?.length ? (
          <QueryMessage testId="cockpit-approvals-empty" title={t("cockpit.approvals.emptyTitle")} body={t("cockpit.approvals.emptyBody")} />
        ) : (
          <div className="grid gap-2">
            <div className="text-3xl font-extrabold tracking-tight">{props.approvals.length}</div>
            {props.approvals.slice(0, 2).map((approval) => (
              <button
                key={approval.approvalId}
                type="button"
                className="text-left rounded-input border hairline p-3 bg-transparent hover:bg-surface-strong/60 cursor-pointer grid gap-1"
                onClick={() => props.onOpenRun(approval.run.id)}
              >
                <span className="text-sm font-medium truncate">{approval.run.businessSummary || approval.actionType}</span>
                <span className="text-[12px] text-muted truncate">{approval.reason}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AnalyticsModule(props: { data: AnalyticsOverview | undefined; pending: boolean; error: unknown; t: (key: string) => string }) {
  const { t } = props;
  return (
    <Card data-testid="cockpit-analytics">
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle className="text-[15.5px]">{t("cockpit.analytics.title")}</CardTitle>
          <span className="text-[12px] text-muted">{t("cockpit.analytics.subtitle")}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate("/analytics")}>{t("cockpit.viewAll")}</Button>
      </CardHeader>
      <CardContent>
        {props.pending ? <Skeleton className="h-20 w-full" /> : props.error ? (
          <QueryMessage testId="cockpit-analytics-error" title={t("cockpit.loadError")} body={String(props.error)} tone="error" />
        ) : !props.data ? (
          <QueryMessage testId="cockpit-analytics-empty" title={t("cockpit.analytics.emptyTitle")} body={t("cockpit.analytics.emptyBody")} />
        ) : (
          <div className="grid grid-cols-2 gap-2">
            <Metric label={t("analytics.successRate")} value={props.data.successRate === null ? "—" : `${props.data.successRate}%`} />
            <Metric label={t("analytics.avgDuration")} value={props.data.avgDurationSec === null ? "—" : `${props.data.avgDurationSec}s`} />
            <Metric label={t("cockpit.metric.total")} value={String(props.data.totals.all)} />
            <Metric label={t("cockpit.metric.failed")} value={String(props.data.totals.failed)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function EvidenceModule(props: { artifacts: ArtifactRecord[] | undefined; pending: boolean; error: unknown; locale: string; t: (key: string) => string; onOpenRun: (runId: string) => void }) {
  const { t } = props;
  return (
    <Card data-testid="cockpit-evidence">
      <CardHeader>
        <div className="grid gap-1">
          <CardTitle className="text-[15.5px]">{t("cockpit.evidence.title")}</CardTitle>
          <span className="text-[12px] text-muted">{t("cockpit.evidence.subtitle")}</span>
        </div>
        <Button size="sm" variant="ghost" onClick={() => navigate("/library")}>{t("cockpit.viewAll")}</Button>
      </CardHeader>
      <CardContent>
        {props.pending ? <Skeleton className="h-20 w-full" /> : props.error ? (
          <QueryMessage testId="cockpit-evidence-error" title={t("cockpit.loadError")} body={String(props.error)} tone="error" />
        ) : !props.artifacts?.length ? (
          <QueryMessage testId="cockpit-evidence-empty" title={t("cockpit.evidence.emptyTitle")} body={t("cockpit.evidence.emptyBody")} />
        ) : (
          <div className="grid gap-2">
            <div className="text-3xl font-extrabold tracking-tight">{props.artifacts.length}</div>
            {props.artifacts.slice(0, 3).map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                data-testid="cockpit-artifact-row"
                className="text-left rounded-input border hairline p-3 bg-transparent hover:bg-surface-strong/60 cursor-pointer grid gap-1"
                onClick={() => props.onOpenRun(artifact.runId)}
              >
                <span className="text-sm font-medium truncate">{artifact.title}</span>
                <span className="text-[12px] text-muted truncate">{artifact.summary || artifact.kind} · {formatDate(artifact.createdAt, props.locale)}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function CockpitPage(props: { workspaceId: string; onOpenRun: (runId: string) => void }) {
  const { t, locale } = useI18n();
  const runsQuery = useQuery({
    queryKey: ["cockpit-runs", props.workspaceId],
    queryFn: () => listRunHistory(props.workspaceId) as Promise<RunRecord[]>
  });
  const approvalsQuery = useQuery({
    queryKey: ["cockpit-approvals", props.workspaceId],
    queryFn: () => listPendingApprovals(props.workspaceId)
  });
  const analyticsQuery = useQuery({
    queryKey: ["cockpit-analytics", props.workspaceId],
    queryFn: () => getAnalyticsOverview(props.workspaceId)
  });
  const artifactsQuery = useQuery({
    queryKey: ["cockpit-artifacts", props.workspaceId],
    queryFn: () => listArtifacts(props.workspaceId)
  });

  const runs = runsQuery.data;
  const summary = useMemo(() => summarizeCockpitRuns(runs ?? []), [runs]);
  const latestRuns = useMemo(() => latestCockpitRuns(runs ?? []), [runs]);
  const approvalCount = approvalsQuery.data?.length ?? 0;
  const artifactCount = artifactsQuery.data?.length ?? 0;

  return (
    <RouteLayout title={t("cockpit.title")} subtitle={t("cockpit.subtitle")}>
      <div data-testid="cockpit-page" className="grid gap-4">
        <Card data-testid="cockpit-objective">
          <CardHeader>
            <div className="grid gap-1">
              <CardTitle>{t("cockpit.objective.title")}</CardTitle>
              <span className="text-[12px] text-muted">{t("cockpit.objective.subtitle")}</span>
            </div>
            <Badge variant="info">Growth v1</Badge>
          </CardHeader>
          <CardContent>
            <div className="rounded-card border border-brand-dark/20 bg-brand-light/45 p-4 grid gap-2">
              <span className="text-[12px] text-brand font-semibold uppercase tracking-wide">{t("cockpit.objective.outcomeLabel")}</span>
              <strong className="text-xl tracking-tight">{t("cockpit.objective.outcome")}</strong>
              <span className="text-sm text-muted">{t("cockpit.objective.evidence")}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {["discovery", "activation", "conversion", "retention"].map((stage) => (
                <span key={stage} className="rounded-pill border hairline px-3 py-1 text-[12px] text-muted">{t(`cockpit.stage.${stage}`)}</span>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => navigate("/launch")}>{t("cockpit.objective.primaryAction")}</Button>
              <Button size="sm" variant="secondary" onClick={() => navigate("/analytics")}>{t("cockpit.objective.secondaryAction")}</Button>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-[1.35fr_.65fr]">
          <RunsModule
            runs={runs}
            pending={runsQuery.isPending}
            error={runsQuery.error ? errorMessage(runsQuery.error, t("cockpit.loadError")) : null}
            summary={summary}
            latest={latestRuns}
            locale={locale}
            onOpenRun={props.onOpenRun}
            t={t}
          />
          <div className="grid gap-4">
            <ApprovalsModule
              approvals={approvalsQuery.data}
              pending={approvalsQuery.isPending}
              error={approvalsQuery.error ? errorMessage(approvalsQuery.error, t("cockpit.loadError")) : null}
              t={t}
              onOpenRun={props.onOpenRun}
            />
            <AnalyticsModule
              data={analyticsQuery.data}
              pending={analyticsQuery.isPending}
              error={analyticsQuery.error ? errorMessage(analyticsQuery.error, t("cockpit.loadError")) : null}
              t={t}
            />
          </div>
        </div>

        <EvidenceModule
          artifacts={artifactsQuery.data}
          pending={artifactsQuery.isPending}
          error={artifactsQuery.error ? errorMessage(artifactsQuery.error, t("cockpit.loadError")) : null}
          locale={locale}
          t={t}
          onOpenRun={props.onOpenRun}
        />

        <div className="text-[12px] text-muted" data-testid="cockpit-readonly-note">
          {t("cockpit.readonlyNote")} · {t("cockpit.summaryCounts", { runs: summary.total, approvals: approvalCount, artifacts: artifactCount })}
        </div>
      </div>
    </RouteLayout>
  );
}
