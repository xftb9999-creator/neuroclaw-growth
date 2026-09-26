import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import {
  getAnalyticsOverview,
  getBenchmarks,
  getNorthStarOverview,
  getWorkspaceIndustry,
  type AnalyticsOverview,
  type NorthStarOverview
} from "../lib/api.js";
import { summarizeIndustryBenchmarks } from "../lib/benchmarks.js";
import { useI18n } from "../lib/i18n.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";

const AGENT_TINT: Record<string, string> = {
  content_acquisition: "from-[#ffb98a] to-brand",
  private_conversion: "from-[#8fd8ae] to-ok",
  weekly_review: "from-[#c9bcff] to-[#6d5bd0]"
};

/** 14 日趋势 — 堆叠柱(completed 上/failed 下),纯 SVG */
function TrendChart(props: {
  series: AnalyticsOverview["series"];
}) {
  const { t } = useI18n();
  const max = Math.max(1, ...props.series.map((point) => point.total));
  const width = 560;
  const height = 150;
  const gap = 8;
  const barWidth = (width - gap * (props.series.length - 1)) / Math.max(1, props.series.length);

  return (
    <svg
      viewBox={`0 0 ${width} ${height + 22}`}
      role="img"
      aria-label={t("analytics.trendAria")}
      className="w-full h-auto"
    >
      {props.series.map((point, index) => {
        const x = index * (barWidth + gap);
        const totalH = (point.total / max) * (height - 10);
        const completedH = (point.completed / max) * (height - 10);
        const failedH = totalH - completedH;
        const baseline = height;
        return (
          <g key={point.label}>
            <title>
              {`${point.label} · ${t("analytics.total")}: ${point.total} · ✓ ${point.completed} · ✕ ${point.failed}`}
            </title>
            {point.total === 0 ? (
              <rect x={x} y={baseline - 2} width={barWidth} height={2} rx={1.5} fill="#e7e0d4" />
            ) : (
              <>
                <rect
                  x={x}
                  y={baseline - completedH}
                  width={barWidth}
                  height={Math.max(3, completedH)}
                  rx={3}
                  fill="url(#gradCompleted)"
                />
                {failedH > 0 && (
                  <rect
                    x={x}
                    y={baseline - totalH}
                    width={barWidth}
                    height={Math.max(3, failedH)}
                    rx={3}
                    fill="#f3b6b1"
                  />
                )}
              </>
            )}
            {(index % 2 === 0 || props.series.length <= 8) && (
              <text x={x + barWidth / 2} y={height + 16} textAnchor="middle" fontSize="10" fill="#a89c92">
                {point.label}
              </text>
            )}
          </g>
        );
      })}
      <defs>
        <linearGradient id="gradCompleted" x1="0" y1="1" x2="0" y2="0">
          <stop offset="0%" stopColor="#f0965e" />
          <stop offset="100%" stopColor="#ec8a22" />
        </linearGradient>
      </defs>
    </svg>
  );
}

/** 成功率环 */
function SuccessRing(props: { rate: number | null }) {
  const { t } = useI18n();
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const rate = props.rate ?? 0;
  const dash = (rate / 100) * circumference;

  return (
    <div className="relative w-[132px] h-[132px]" role="img" aria-label={`${t("analytics.successRate")}: ${props.rate ?? "—"}%`}>
      <svg viewBox="0 0 132 132" className="w-full h-full -rotate-90">
        <circle cx="66" cy="66" r={radius} fill="none" stroke="#efe9df" strokeWidth="11" />
        {props.rate !== null && (
          <circle
            cx="66"
            cy="66"
            r={radius}
            fill="none"
            stroke="url(#ringGrad)"
            strokeWidth="11"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
          />
        )}
        <defs>
          <linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#bd4f22" />
            <stop offset="100%" stopColor="#ec8a22" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="text-[26px] font-extrabold tracking-tight leading-none">
            {props.rate === null ? "—" : `${rate}%`}
          </div>
          <div className="text-[11.5px] text-muted mt-1">{t("analytics.successRate")}</div>
        </div>
      </div>
    </div>
  );
}

function formatDelta(value: number | null, suffix: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}${suffix}`;
}

export function AnalyticsPage(props: { workspaceId: string }) {
  const { t } = useI18n();

  // Round P: parallel queries replace the hand-rolled loader.
  const overviewQuery = useQuery({
    queryKey: ["analytics-overview", props.workspaceId],
    queryFn: () => getAnalyticsOverview(props.workspaceId)
  });
  const northstarQuery = useQuery({
    queryKey: ["northstar", props.workspaceId],
    queryFn: async () => {
      try {
        return await getNorthStarOverview(props.workspaceId, 30);
      } catch {
        return null; // non-admin / transient — degrade silently
      }
    }
  });
  const industryQuery = useQuery({
    queryKey: ["workspace-industry", props.workspaceId],
    queryFn: () => getWorkspaceIndustry(props.workspaceId)
  });
  const industry = industryQuery.data?.industry?.trim() || null;
  const benchmarksQuery = useQuery({
    queryKey: ["benchmarks", industry],
    queryFn: () => getBenchmarks(industry!),
    enabled: Boolean(industry),
    retry: false
  });

  const data = overviewQuery.data ?? null;
  const northstar = northstarQuery.data ?? null;
  const error =
    overviewQuery.error instanceof Error ? overviewQuery.error.message : null;
  const loading = overviewQuery.isPending || northstarQuery.isPending;

  const kpis = useMemo(() => {
    if (!data) return [];
    return [
      { label: t("home.stat.runs"), value: String(data.totals.all) },
      { label: t("home.stat.completed"), value: String(data.totals.completed) },
      { label: t("analytics.avgDuration"), value: data.avgDurationSec === null ? "—" : `${data.avgDurationSec}s` },
      { label: t("home.stat.pending"), value: String(data.totals.waiting) }
    ];
  }, [data, t]);

  const agentMax = useMemo(
    () => Math.max(1, ...(data?.byAgent.map((item) => item.count) ?? [1])),
    [data]
  );
  const benchmarkSummary = useMemo(
    () => summarizeIndustryBenchmarks(benchmarksQuery.data ?? []),
    [benchmarksQuery.data]
  );
  const peerSuccessRate = benchmarkSummary.weightedSuccessRate === null
    ? null
    : Math.round(benchmarkSummary.weightedSuccessRate * 100);
  const successDelta = data?.successRate !== null && data?.successRate !== undefined && peerSuccessRate !== null
    ? data.successRate - peerSuccessRate
    : null;
  const durationDelta = data?.avgDurationSec !== null && data?.avgDurationSec !== undefined && benchmarkSummary.weightedP50DurationSec !== null
    ? data.avgDurationSec - benchmarkSummary.weightedP50DurationSec
    : null;

  return (
    <RouteLayout title={t("analytics.title")} subtitle={t("analytics.subtitle")}>
      <ErrorBanner error={error} />

      {industry && (
        <Card data-testid="bench-compare-card">
          <CardHeader>
            <div className="grid gap-1">
              <CardTitle className="text-[15.5px]">{t("analytics.bench.title")}</CardTitle>
              <span className="text-[12px] text-muted">{industry} · {t("analytics.bench.subtitle")}</span>
            </div>
            <span className="text-[12px] text-muted">{t("analytics.bench.sample", {
              groups: String(benchmarkSummary.groupCount),
              samples: String(benchmarkSummary.sampleSize)
            })}</span>
          </CardHeader>
          <CardContent>
            {benchmarksQuery.isPending ? (
              <Skeleton className="h-20 w-full" />
            ) : benchmarksQuery.isError ? (
              <p data-testid="bench-compare-error" className="m-0 text-sm text-muted">{t("analytics.bench.error")}</p>
            ) : benchmarkSummary.groupCount === 0 ? (
              <p data-testid="bench-compare-empty" className="m-0 text-sm text-muted">{t("analytics.bench.empty")}</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="bench-compare-values">
                <div className="rounded-input border hairline p-3 grid gap-1">
                  <span className="text-[12px] text-muted">{t("analytics.bench.success")}</span>
                  <strong data-testid="bench-compare-success" className="text-lg">
                    {data?.successRate === null || data?.successRate === undefined ? "—" : `${data.successRate}%`}
                    <span className="text-[12px] text-muted font-normal"> {t("analytics.bench.vsPeer", { value: peerSuccessRate === null ? "—" : `${peerSuccessRate}%` })}</span>
                  </strong>
                  <span data-testid="bench-compare-success-delta" className="text-[12px] text-muted">{t("analytics.bench.delta", { value: formatDelta(successDelta, "pp") })}</span>
                </div>
                <div className="rounded-input border hairline p-3 grid gap-1">
                  <span className="text-[12px] text-muted">{t("analytics.bench.duration")}</span>
                  <strong data-testid="bench-compare-duration" className="text-lg">
                    {data?.avgDurationSec === null || data?.avgDurationSec === undefined ? "—" : `${data.avgDurationSec}s`}
                    <span className="text-[12px] text-muted font-normal"> {t("analytics.bench.vsPeer", { value: benchmarkSummary.weightedP50DurationSec === null ? "—" : `${Math.round(benchmarkSummary.weightedP50DurationSec)}s` })}</span>
                  </strong>
                  <span data-testid="bench-compare-duration-delta" className="text-[12px] text-muted">{t("analytics.bench.delta", { value: formatDelta(durationDelta, "s") })}</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* 北星指标区块(Round L) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[15.5px]">{t("northstar.title")}</CardTitle>
          <span className="text-[12px] text-muted">{t("northstar.subtitle")}</span>
        </CardHeader>
        <CardContent className="grid gap-3">
          {!northstar ? (
            loading && (
              <div className="grid grid-cols-3 gap-3">
                {Array.from({ length: 3 }).map((_, index) => (
                  <Skeleton key={index} className="h-16 w-full" />
                ))}
              </div>
            )
          ) : (
            <>
              <div
                className="grid grid-cols-3 gap-3"
                title={t("northstar.hintAria")}
              >
                <div className="rounded-card p-4 bg-white border hairline shadow-sm">
                  <div className="text-[12.5px] font-semibold text-muted">{t("northstar.activation")}</div>
                  <div data-testid="ns-activation" className="text-[26px] leading-none font-extrabold tracking-tight mt-1.5">
                    {northstar.activationRate === null ? "—" : `${northstar.activationRate}%`}
                  </div>
                </div>
                <div className="rounded-card p-4 bg-white border hairline shadow-sm">
                  <div className="text-[12.5px] font-semibold text-muted">{t("northstar.day7")}</div>
                  <div data-testid="ns-day7" className="text-[26px] leading-none font-extrabold tracking-tight mt-1.5">
                    {northstar.day7SuccessRate === null ? "—" : `${northstar.day7SuccessRate}%`}
                  </div>
                </div>
                <div className="rounded-card p-4 bg-white border hairline shadow-sm">
                  <div className="text-[12.5px] font-semibold text-muted">{t("northstar.wsCreated")}</div>
                  <div className="text-[26px] leading-none font-extrabold tracking-tight mt-1.5">
                    {northstar.workspacesCreatedInWindow}
                  </div>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(northstar.totals)
                  .filter(([type]) => type !== "workspace.created")
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, 6)
                  .map(([type, count]) => (
                    <span
                      key={type}
                      className="inline-flex items-center gap-1 rounded-pill bg-surface-strong px-2.5 py-1 text-[11.5px] text-muted"
                    >
                      {type.replace(/\./g, " · ")} ×{count}
                    </span>
                  ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* KPI 行 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {loading || !data
          ? Array.from({ length: 4 }).map((_, index) => (
              <Card key={index}><Skeleton className="h-16 w-full" /></Card>
            ))
          : kpis.map((kpi, index) => (
              <div key={index} className="rounded-card p-4 bg-white border hairline shadow-sm lift">
                <div className="text-[12.5px] font-semibold text-muted">{kpi.label}</div>
                <div className="text-[26px] leading-none font-extrabold tracking-tight mt-1.5">
                  {kpi.value}
                </div>
              </div>
            ))}
      </div>

      {/* 趋势 + 成功率 */}
      <div className="grid gap-4 lg:grid-cols-[1fr_auto] items-stretch">
        <Card>
          <CardHeader>
            <CardTitle className="text-[15.5px]">{t("analytics.trendTitle")}</CardTitle>
            <span className="flex items-center gap-3 text-[12px] text-muted">
              <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-[#ec8a22] inline-block" />✓</span>
              <span className="inline-flex items-center gap-1"><i className="w-2.5 h-2.5 rounded-sm bg-[#f3b6b1] inline-block" />✕</span>
            </span>
          </CardHeader>
          <CardContent>
            {!data ? <Skeleton className="h-[150px] w-full" /> : <TrendChart series={data.series} />}
          </CardContent>
        </Card>

        <Card className="grid place-items-center p-6">
          {!data ? <Skeleton className="h-[132px] w-[132px] rounded-full" /> : <SuccessRing rate={data.successRate} />}
        </Card>
      </div>

      {/* 分智能体 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[15.5px]">{t("analytics.byAgent")}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-2.5">
          {!data ? (
            <Skeleton className="h-20 w-full" />
          ) : data.byAgent.length === 0 ? (
            <p className="m-0 text-sm text-muted">{t("library.empty")}</p>
          ) : (
            data.byAgent.map((item) => (
              <div key={item.type} className="grid gap-1">
                <div className="flex justify-between text-[13px]">
                  <span className="font-medium">
                    {t(`templates.names.${item.type}`) === `templates.names.${item.type}`
                      ? item.type
                      : t(`templates.names.${item.type}`)}
                  </span>
                  <span className="text-muted">×{item.count}</span>
                </div>
                <div className="h-2.5 rounded-pill bg-surface-strong overflow-hidden">
                  <div
                    className={`h-full rounded-pill bg-gradient-to-r ${AGENT_TINT[item.type] ?? "from-line-strong to-muted"}`}
                    style={{ width: `${Math.max(8, (item.count / agentMax) * 100)}%` }}
                  />
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </RouteLayout>
  );
}
