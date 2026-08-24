import { useEffect, useMemo, useState } from "react";

import { listRunHistory } from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { navigate, writeRunDraft } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunRecord, TemplateType } from "../types.js";

function detectIntent(query: string): TemplateType | null {
  const q = query.toLowerCase();
  if (/(复盘|周报|周度|总结数据|review|weekly)/.test(q)) return "weekly_review";
  if (/(转化|私域|成交|逼单|跟进咨询|conversion|dm)/.test(q)) return "private_conversion";
  if (/(写|内容|笔记|文章|种草|获客|content|post|article)/.test(q)) return "content_acquisition";
  return null;
}

const statTints = [
  "bg-[#fff0e7]",
  "bg-[#e9f6ee]",
  "bg-[#fdf5e3]",
  "bg-[#f0ecff]"
] as const;

export function HomePage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

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

  const stats = useMemo(() => {
    const completed = runs.filter((run) => run.status === "completed").length;
    const pending = runs.filter(
      (run) => run.status === "waiting_approval" || run.approvalStatus === "pending"
    ).length;
    const outputs = runs.filter(
      (run) => run.status === "completed" && run.outputPayload
    ).length;
    return [
      { label: t("home.stat.runs"), value: runs.length },
      { label: t("home.stat.completed"), value: completed },
      { label: t("home.stat.memory"), value: outputs },
      { label: t("home.stat.pending"), value: pending }
    ];
  }, [runs, t]);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? t("home.greeting.morning") : hour < 18 ? t("home.greeting.afternoon") : t("home.greeting.evening");

  const recentOutputs = runs
    .filter((run) => run.status === "completed" && run.outputPayload)
    .slice(0, 3);

  const launch = () => {
    const text = query.trim();
    if (!text) {
      navigate("/templates");
      return;
    }
    const intent = detectIntent(text);
    if (!intent) {
      navigate("/templates");
      return;
    }
    writeRunDraft({
      templateType: intent,
      input: { businessSummary: text },
      sourceRunId: "quickstart"
    });
    navigate(`/runs/new/${intent}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  const copyDraft = async (run: RunRecord) => {
    const draft = String(run.outputPayload?.conversionDraft ?? "");
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopiedId(run.id);
      window.setTimeout(() => setCopiedId(null), 1600);
    } catch {
      // clipboard unavailable
    }
  };

  return (
    <RouteLayout title={`${greeting} · ${t("home.title")}`} subtitle={t("home.subtitle")}>
      <ErrorBanner error={error} />

      {/* 一句话启动 */}
      <Card className="p-5">
        <div className="flex gap-2.5 flex-wrap sm:flex-nowrap">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") launch();
            }}
            placeholder={t("home.launch.placeholder")}
            aria-label={t("home.launch.placeholder")}
            className="flex-1 min-w-[220px] border border-line bg-surface-strong/50 rounded-pill px-5 py-3.5 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand placeholder:text-muted/70 transition-colors hover:border-line-strong"
          />
          <Button onClick={launch} size="lg" className="shrink-0">
            {t("home.launch.button")} ✦
          </Button>
        </div>
        <p className="m-0 mt-2.5 text-[12.5px] text-muted px-1">{t("home.launch.hint")}</p>
        <div className="flex flex-wrap gap-2 mt-3">
          {[t("home.suggestion.content"), t("home.suggestion.review")].map((tip) => (
            <button
              key={tip}
              type="button"
              onClick={() => setQuery(tip)}
              className="text-[12.5px] border border-line bg-white rounded-pill px-3 py-1.5 text-muted hover:text-brand hover:border-brand/40 cursor-pointer transition-colors"
            >
              ✦ {tip}
            </button>
          ))}
        </div>
      </Card>

      {/* 概览统计 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(loading ? Array.from({ length: 4 }) : stats).map((stat, index) => (
          <div key={index} className={`rounded-card p-4 ${statTints[index]} lift`}>
            {loading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <>
                <div className="text-[12.5px] font-semibold text-ink/70">
                  {(stat as { label: string }).label}
                </div>
                <div className="text-[28px] leading-none font-extrabold tracking-tight mt-1.5">
                  {(stat as { value: number }).value}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* 最近成果(富卡片) */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h3 className="m-0 text-lg font-bold tracking-tight">{t("home.recent")}</h3>
          <Button variant="ghost" size="sm" onClick={() => navigate("/templates")}>
            {t("home.quick.templates")} →
          </Button>
        </div>

        {!loading && recentOutputs.length === 0 ? (
          <Card className="p-6 text-center">
            <div className="text-3xl mb-2" aria-hidden="true">🌱</div>
            <h4 className="m-0 mb-1 font-bold">{t("home.recentEmpty.title")}</h4>
            <p className="m-0 text-muted text-sm">{t("home.recentEmpty.body")}</p>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-3">
            {recentOutputs.map((run) => (
              <Card key={run.id} className="glass-hover lift">
                <div className="flex items-center justify-between mb-2">
                  <Badge variant="default">{t(`templates.names.${run.templateType}`)}</Badge>
                  <Badge variant={statusToBadgeVariant(run.status)}>{run.status}</Badge>
                </div>

                {run.templateType === "content_acquisition" &&
                  Array.isArray(run.outputPayload?.contentAngles) && (
                    <ul className="m-0 p-0 list-none grid gap-1.5">
                      {(run.outputPayload!.contentAngles as string[])
                        .slice(0, 3)
                        .map((angle, angleIndex) => (
                          <li key={angleIndex} className="text-[13.5px] font-medium truncate">
                            · {angle}
                          </li>
                        ))}
                    </ul>
                  )}

                {run.templateType === "private_conversion" &&
                  typeof run.outputPayload?.conversionDraft === "string" && (
                    <p className="m-0 text-[13.5px] leading-relaxed line-clamp-4">
                      {run.outputPayload!.conversionDraft.slice(0, 140)}
                    </p>
                  )}

                {run.templateType === "weekly_review" &&
                  typeof run.outputPayload?.reviewSummary === "string" && (
                    <p className="m-0 text-[13.5px] leading-relaxed line-clamp-4">
                      📊 {run.outputPayload!.reviewSummary.slice(0, 140)}
                    </p>
                  )}

                <div className="flex gap-2 mt-3 pt-3 border-t hairline">
                  <Button size="sm" variant="secondary" onClick={() => props.onOpenRun(run.id)}>
                    {t("history.open")}
                  </Button>
                  {run.templateType === "private_conversion" && (
                    <Button size="sm" variant="outline" onClick={() => void copyDraft(run)}>
                      {copiedId === run.id ? t("render.copied") : t("render.copy")}
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>
    </RouteLayout>
  );
}
