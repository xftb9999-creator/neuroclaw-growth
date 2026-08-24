import { useEffect, useMemo, useState } from "react";

import { getAnalyticsOverview, type AnalyticsOverview } from "../lib/api.js";
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

export function AnalyticsPage(props: { workspaceId: string }) {
  const { t } = useI18n();
  const [data, setData] = useState<AnalyticsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAnalyticsOverview(props.workspaceId)
      .then((overview) => setData(overview))
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t("history.loadError")))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

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

  return (
    <RouteLayout title={t("analytics.title")} subtitle={t("analytics.subtitle")}>
      <ErrorBanner error={error} />

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
