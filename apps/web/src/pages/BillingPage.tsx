import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  changePlan,
  getBillingSummary,
  type BillingSummary
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";

const PLANS = [
  { id: "starter", nameKey: "billing.plan.starter.name", descKey: "billing.plan.starter.desc", quota: 30 },
  { id: "team", nameKey: "billing.plan.team.name", descKey: "billing.plan.team.desc", quota: 100 },
  { id: "business", nameKey: "billing.plan.business.name", descKey: "billing.plan.business.desc", quota: 500 },
  { id: "enterprise", nameKey: "billing.plan.enterprise.name", descKey: "billing.plan.enterprise.desc", quota: 0 }
] as const;

export function BillingPage(props: { workspaceId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);

  const summaryQuery = useQuery({
    queryKey: ["billing", props.workspaceId],
    queryFn: () => getBillingSummary(props.workspaceId)
  });
  const summary = summaryQuery.data ?? null;
  const loading = summaryQuery.isPending;

  useEffect(() => {
    if (summaryQuery.error) {
      setError(
        summaryQuery.error instanceof Error
          ? summaryQuery.error.message
          : "Failed to load billing"
      );
    }
  }, [summaryQuery.error]);

  const switchPlan = async (plan: string) => {
    setSwitching(plan);
    try {
      await changePlan(props.workspaceId, plan);
      await queryClient.invalidateQueries({ queryKey: ["billing", props.workspaceId] });
      setNotice(t("billing.changed"));
      setError(null);
    } catch (switchError) {
      setError(switchError instanceof Error ? switchError.message : t("history.loadError"));
    } finally {
      setSwitching(null);
    }
  };

  const quotaUsed = summary
    ? summary.monthlyRunQuota === 0
      ? 0
      : Math.min(100, Math.round((summary.usage.runsCreated / summary.monthlyRunQuota) * 100))
    : 0;

  return (
    <RouteLayout title={t("billing.title")} subtitle={t("billing.subtitle")}>
      <ErrorBanner error={error} />
      <InfoBanner message={notice} />

      {/* 当前订阅 + 配额仪表 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[15.5px]">{t("billing.quota.label")}</CardTitle>
          {summary && (
            <Badge variant={summary.status === "trialing" ? "waiting" : "completed"}>
              {summary.status === "trialing"
                ? t("billing.status.trialing")
                : t("billing.status.active")}
            </Badge>
          )}
        </CardHeader>
        <CardContent className="grid gap-3">
          {!summary ? (
            loading && <Skeleton className="h-14 w-full" />
          ) : (
            <>
              <div className="flex items-end gap-3 flex-wrap">
                <div className="text-[34px] leading-none font-extrabold tracking-tight">
                  {summary.usage.runsCreated}
                  <span className="text-[16px] font-semibold text-muted">
                    {" / "}
                    {summary.monthlyRunQuota === 0
                      ? t("billing.quota.unlimited")
                      : summary.monthlyRunQuota}
                  </span>
                </div>
                <span className="text-[13px] text-muted pb-1">
                  {summary.usage.quotaRemaining !== null &&
                    t("billing.quota.remaining", { n: summary.usage.quotaRemaining })}
                  {summary.renewsAt &&
                    ` · ${t("billing.renewsAt")} ${new Date(summary.renewsAt).toLocaleDateString()}`}
                </span>
              </div>
              <div
                role="progressbar"
                aria-label={t("billing.quota.label")}
                aria-valuenow={quotaUsed}
                aria-valuemin={0}
                aria-valuemax={100}
                className="h-2.5 rounded-pill bg-surface-strong overflow-hidden"
              >
                <div
                  className={`h-full rounded-pill bg-gradient-to-r ${
                    quotaUsed > 85 ? "from-[#f3b6b1] to-danger" : "from-brand to-brand-dark"
                  }`}
                  style={{ width: `${Math.max(3, quotaUsed)}%` }}
                />
              </div>
              <div className="flex gap-5 flex-wrap text-[12.5px] text-muted">
                <span>{t("billing.usage.runsCompleted")}: {summary.usage.runsCompleted}</span>
                <span>{t("billing.usage.tokensUsed")}: {summary.usage.tokensUsed.toLocaleString()}</span>
                {summary.plan === "growth" && <span>ℹ {t("billing.growthAlias")}</span>}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* 档位卡片 */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {!summary
          ? Array.from({ length: 4 }).map((_, index) => (
              <Card key={index}><Skeleton className="h-40 w-full" /></Card>
            ))
          : PLANS.map((plan) => {
              const current =
                summary.status === "trialing"
                  ? plan.id === "starter"
                  : summary.plan === plan.id;
              return (
                <Card
                  key={plan.id}
                  data-testid={`plan-${plan.id}`}
                  className={current ? "border-brand-dark ring-1 ring-brand/30" : undefined}
                >
                  <CardContent className="grid gap-2 h-full content-start">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold text-[15px]">{t(plan.nameKey)}</span>
                      {current && <Badge variant="completed">{t("billing.current")}</Badge>}
                    </div>
                    <p className="m-0 text-[13px] text-muted">{t(plan.descKey)}</p>
                    <div className="mt-auto pt-2">
                      {current ? (
                        <Button size="sm" variant="outline" disabled>
                          {t("billing.current")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={switching !== null}
                          onClick={() => void switchPlan(plan.id)}
                        >
                          {switching === plan.id ? t("common.loading") : t("billing.upgrade")}
                        </Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>
    </RouteLayout>
  );
}
