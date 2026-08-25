import { useCallback, useEffect, useMemo, useState } from "react";

import {
  getTeam,
  launchTeam,
  listTeams,
  type TeamListItem,
  type TeamRunRecord,
  type TeamStepView
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Input, Label, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";

const PLAYBOOK_KEYS = ["sprint", "contentReview"] as const;
type Stage = 1 | 2 | 3 | 4;

function stepStateVariant(state: TeamStepView["state"]) {
  switch (state) {
    case "done": return "completed" as const;
    case "running": return "running" as const;
    case "waiting_approval": return "waiting" as const;
    case "failed": return "failed" as const;
    default: return "info" as const;
  }
}

function stageIcon(stage: Stage): string {
  return stage === 1 ? "🧩" : stage === 2 ? "🎯" : stage === 3 ? "⚡" : "📦";
}

export function TeamPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [stage, setStage] = useState<Stage>(1);
  const [playbookKey, setPlaybookKey] = useState<string>("sprint");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [teamRunId, setTeamRunId] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamRunRecord | null>(null);
  const [recentTeams, setRecentTeams] = useState<TeamListItem[]>([]);
  const [expandedStep, setExpandedStep] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [loadingRoot, setLoadingRoot] = useState(true);

  const loadRoot = useCallback(async () => {
    try {
      const items = await listTeams(props.workspaceId);
      setRecentTeams(items as TeamListItem[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoadingRoot(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  // 团队运行中轮询
  const refreshTeam = useCallback(async (teamId: string) => {
    try {
      const record = await getTeam(teamId);
      setTeam(record);
      return record;
    } catch (pollError) {
      if ((pollError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
        props.onWorkspaceMissing(t("history.workspaceExpired"));
      }
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);

  useEffect(() => {
    if (!teamRunId || !team) return;
    if (team.status === "completed" || team.status === "failed") return;
    const timer = window.setInterval(async () => {
      const record = await refreshTeam(teamRunId);
      if (record?.status === "completed") setStage(4);
    }, 2500);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamRunId, team?.status]);

  const startRelay = async () => {
    if (!goal.trim()) return;
    setError(null);
    setLaunching(true);
    try {
      const result = (await launchTeam({
        workspaceId: props.workspaceId,
        playbookKey,
        goal: goal.trim(),
        audience: audience.trim() || undefined
      })) as { teamRunId: string };
      setTeamRunId(result.teamRunId);
      const record = await getTeam(result.teamRunId);
      setTeam(record);
      setExpandedStep(record.currentStep ?? 0);
      setStage(3);
      void loadRoot();
    } catch (startError) {
      if ((startError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
        props.onWorkspaceMissing(t("setup.workspaceExpired"));
        return;
      }
      setError(startError instanceof Error ? startError.message : t("team.failed"));
    } finally {
      setLaunching(false);
    }
  };

  const openExisting = async (teamId: string) => {
    try {
      const record = await getTeam(teamId);
      setTeamRunId(teamId);
      setTeam(record);
      setExpandedStep(Math.min(record.currentStep, record.steps.length - 1));
      setStage(record.status === "completed" ? 4 : 3);
    } catch (openError) {
      if ((openError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
        props.onWorkspaceMissing(t("history.workspaceExpired"));
        return;
      }
      setError(openError instanceof Error ? openError.message : t("history.loadError"));
    }
  };

  const goStage = (target: Stage) => {
    if (target >= 3 && !teamRunId) return;
    if (target === 4 && (!team || team.status !== "completed")) return;
    setStage(target);
  };

  const stages: Array<{ id: Stage; label: string; enabled: boolean }> = [
    { id: 1, label: t("team.stage.pick"), enabled: true },
    { id: 2, label: t("team.stage.goal"), enabled: true },
    { id: 3, label: t("team.stage.relay"), enabled: Boolean(teamRunId) },
    { id: 4, label: t("team.stage.results"), enabled: Boolean(team && team.status === "completed") }
  ];

  const participants = useMemo(() => {
    if (!team) return [] as string[];
    const seen = new Set<string>();
    for (const step of team.steps) seen.add(step.templateType);
    return [...seen];
  }, [team]);

  const teamStatusVariant = team
    ? statusToBadgeVariant(
        team.status === "waiting_approval"
          ? "waiting_approval"
          : team.status === "completed"
            ? "completed"
            : team.status === "failed"
              ? "failed"
              : "running"
      )
    : "info";

  const agentName = (type: string) =>
    t(`templates.names.${type}`) === `templates.names.${type}` ? type : t(`templates.names.${type}`);

  // ---------------------------------------------------------------------
  // 顶部横向阶段导航条 — 大步骤横向切换,随时可回任何环节
  // ---------------------------------------------------------------------
  const StageBar = (
    <div className="glass p-3 mb-5">
      <ol className="m-0 p-0 list-none flex items-center gap-0 overflow-x-auto">
        {stages.map((item, index) => {
          const active = stage === item.id;
          const reachable = item.enabled;
          return (
            <li key={item.id} className="flex items-center flex-none">
              <button
                type="button"
                onClick={() => reachable && goStage(item.id)}
                aria-current={active ? "step" : undefined}
                className={`flex items-center gap-2 rounded-pill px-4 py-2 border cursor-pointer transition-all ${
                  active
                    ? "border-brand bg-gradient-to-br from-brand to-brand-dark text-white shadow-[0_6px_18px_rgba(189,79,34,0.35)]"
                    : reachable
                      ? "border-line-strong bg-white hover:border-brand/50"
                      : "border-line bg-surface-strong text-muted/60 cursor-not-allowed"
                }`}
              >
                <span
                  className={`inline-flex w-6 h-6 items-center justify-center rounded-full text-[12px] font-bold ${
                    active ? "bg-white/25" : item.enabled ? "bg-brand-light text-brand" : "bg-surface-strong text-muted"
                  }`}
                  aria-hidden="true"
                >
                  {item.id}
                </span>
                <span className="text-[13.5px] font-semibold whitespace-nowrap">
                  {stageIcon(item.id)} {item.label}
                </span>
              </button>
              {index < stages.length - 1 && (
                <span className={`w-8 h-[2px] mx-1 rounded ${item.id < stage ? "bg-brand" : "bg-line-strong"}`} aria-hidden="true" />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );

  // ---------------------------------------------------------------------
  // STAGE 1 — 选 Playbook
  // ---------------------------------------------------------------------
  const stageOne = (
    <div className="grid gap-4 fade-up">
      {recentTeams.length > 0 && (
        <section className="grid gap-3">
          <h3 className="m-0 text-[15px] font-bold tracking-tight">{t("team.recent")}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {recentTeams.slice(0, 4).map((item) => (
              <Card
                key={item.id}
                className="glass-hover lift cursor-pointer"
                onClick={() => void openExisting(item.id)}
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <strong className="text-[14px]">{t(`team.playbook.${item.playbookKey}.name`)}</strong>
                  <Badge variant={statusToBadgeVariant(
                    item.status === "waiting_approval" ? "waiting_approval"
                    : item.status === "completed" ? "completed"
                    : item.status === "failed" ? "failed"
                    : "running"
                  )}>
                    {item.status}
                  </Badge>
                </div>
                <p className="m-0 mt-1 text-[13px] text-muted line-clamp-1">{item.goal}</p>
                <p className="m-0 mt-0.5 text-[11.5px] text-muted/80">
                  {t("team.progress")} {item.currentStep} · {new Date(item.createdAt).toLocaleDateString()}
                </p>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-3">
        <h3 className="m-0 text-[15px] font-bold tracking-tight">{t("team.newRelay")}</h3>
        <div className="grid gap-3 md:grid-cols-2">
          {PLAYBOOK_KEYS.map((key) => (
            <Card
              key={key}
              className={`cursor-pointer lift ${playbookKey === key ? "!border-brand ring-1 ring-brand/40" : ""}`}
              onClick={() => { setPlaybookKey(key); setStage(2); }}
            >
              <CardHeader>
                <CardTitle className="text-[16px]">{t(`team.playbook.${key}.name`)}</CardTitle>
                {playbookKey === key && <Badge variant="default">✓</Badge>}
              </CardHeader>
              <CardContent>
                <p className="m-0 text-[13px] text-muted leading-relaxed">{t(`team.playbook.${key}.desc`)}</p>
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {(key === "sprint"
                    ? ["content_acquisition", "private_conversion", "weekly_review"]
                    : ["content_acquisition", "weekly_review"]
                  ).map((type) => (
                    <span key={type} className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1">
                      {agentName(type)}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>
      {loadingRoot && <Card><Skeleton className="h-16 w-full" /></Card>}
    </div>
  );

  // ---------------------------------------------------------------------
  // STAGE 2 — 定目标
  // ---------------------------------------------------------------------
  const stageTwo = (
    <Card className="grid gap-3 max-w-2xl fade-up">
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="default">{t(`team.playbook.${playbookKey}.name`)}</Badge>
        <Button size="sm" variant="ghost" onClick={() => setStage(1)}>← {t("team.stage.pick")}</Button>
      </div>
      <Label>
        <span>{t("team.goalLabel")}</span>
        <Input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="母婴店开业周…" />
      </Label>
      <Label>
        <span>{t("team.audienceLabel")}</span>
        <Input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="新手妈妈" />
      </Label>
      <Button size="lg" onClick={() => void startRelay()} disabled={launching || !goal.trim()}>
        {launching ? t("team.running") : t("team.start")}
      </Button>
    </Card>
  );

  // ---------------------------------------------------------------------
  // STAGE 3 — 接力执行(横向步骤条 + 竖向展开细节)
  // ---------------------------------------------------------------------
  const stageThree = team ? (
    <div className="grid gap-4 fade-up">
      {/* 横向大步骤 */}
      <div className="glass p-3">
        <ol className="m-0 p-0 list-none flex items-center gap-1.5 overflow-x-auto">
          {team.steps.map((step, index) => {
            const active = expandedStep === index;
            return (
              <li key={`${index}-${step.templateType}`} className="flex items-center flex-none">
                <button
                  type="button"
                  onClick={() => setExpandedStep(index)}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-pill px-3.5 py-2 border cursor-pointer transition-all ${
                    active
                      ? "border-brand bg-gradient-to-br from-brand to-brand-dark text-white shadow-[0_6px_18px_rgba(189,79,34,0.3)]"
                      : "border-line-strong bg-white hover:border-brand/50"
                  }`}
                >
                  <span className={`inline-flex w-6 h-6 items-center justify-center rounded-full text-[11.5px] font-bold ${
                    step.state === "done" ? "bg-ok-light text-ok"
                    : step.state === "waiting_approval" ? "bg-warn-light text-warn"
                    : step.state === "failed" ? "bg-danger-light text-danger"
                    : active ? "bg-white/25 text-white"
                    : "bg-surface-strong text-muted"
                  }`} aria-hidden="true">
                    {step.state === "done" ? "✓" : step.state === "running" ? "●" : step.state === "waiting_approval" ? "⏸" : step.state === "failed" ? "✕" : index + 1}
                  </span>
                  <span className="text-[13px] font-semibold whitespace-nowrap">{agentName(step.templateType)}</span>
                </button>
                {index < team.steps.length - 1 && <span className="w-6 h-[2px] bg-line-strong mx-0.5" aria-hidden="true">→</span>}
              </li>
            );
          })}
        </ol>
        {participants.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 mt-3 pt-2.5 border-t hairline">
            <span className="text-[11.5px] font-bold text-brand uppercase tracking-wide">👥 {t("team.participants")}</span>
            {participants.map((type) => (
              <span key={type} className="text-[12.5px] bg-surface-strong rounded-pill px-2.5 py-0.5">{agentName(type)}</span>
            ))}
            <Badge variant={teamStatusVariant} className="ml-auto">{team.status}</Badge>
          </div>
        )}
      </div>

      {/* 竖向展开的环节细节 */}
      {(() => {
        const step = team.steps[expandedStep ?? team.currentStep] ?? team.steps[0];
        if (!step) return null;
        return (
          <Card className="grid gap-3 fade-up">
            <div className="flex items-center gap-2 flex-wrap">
              <strong className="text-[15.5px]">{agentName(step.templateType)}</strong>
              <Badge variant={stepStateVariant(step.state)}>{step.state}</Badge>
              {step.durationSec != null && <span className="text-[12.5px] text-muted">⏱ {step.durationSec}s</span>}
              {step.feedFrom.length > 0 && (
                <span className="text-[11.5px] text-muted">← {step.feedFrom.join(", ")}</span>
              )}
            </div>

            {(step.startedAt || step.completedAt) && (
              <p className="m-0 text-[12.5px] text-muted border-l-2 border-brand/40 pl-3">
                ⏱ {step.startedAt ? new Date(step.startedAt).toLocaleString() : "—"}
                {step.completedAt ? ` → ${new Date(step.completedAt).toLocaleString()}` : ""}
              </p>
            )}

            {Object.keys(step.outputFields ?? {}).length > 0 ? (
              <div className="grid gap-2">
                {Object.entries(step.outputFields!).map(([fieldKey, value]) => (
                  <div key={fieldKey} className="border hairline rounded-input p-3 bg-white">
                    <span className="text-[11.5px] font-bold text-brand uppercase tracking-wide">{fieldKey}</span>
                    <p className="m-0 mt-1 text-[13.5px] leading-relaxed whitespace-pre-wrap line-clamp-6">{value}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="m-0 text-[13px] text-muted">{t("status.readyForReview")}</p>
            )}

            {step.runId && (
              <Button size="sm" variant="secondary" className="justify-self-start" onClick={() => props.onOpenRun(step.runId!)}>
                {t("library.open")} →
              </Button>
            )}
          </Card>
        );
      })()}
    </div>
  ) : null;

  // ---------------------------------------------------------------------
  // STAGE 4 — 结果汇总
  // ---------------------------------------------------------------------
  const stageFour = team ? (
    <div className="grid gap-4 fade-up">
      <Card className="grid gap-2.5">
        <span className="text-[11.5px] font-bold text-brand uppercase tracking-wide">🎯 {t("team.goalLabel")}</span>
        <p className="m-0 text-[15px] leading-relaxed">{team.goal}</p>
        {team.audience && <span className="text-[12.5px] text-muted">👥 {team.audience}</span>}
        <div className="flex flex-wrap gap-4 text-[12px] text-muted border-t hairline pt-2">
          <span>🕒 {new Date(team.createdAt).toLocaleString()}</span>
          <span>↻ {new Date(team.updatedAt).toLocaleString()}</span>
          <Badge variant={teamStatusVariant}>{team.status}</Badge>
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-3">
        {team.steps.filter((step) => Object.keys(step.outputFields ?? {}).length > 0).map((step) => (
          <Card key={`result-${step.runId ?? step.templateType}`} className="grid gap-1.5 lift">
            <CardHeader className="!mb-0.5">
              <CardTitle className="text-[15px]">{agentName(step.templateType)}</CardTitle>
              {step.durationSec != null && <span className="text-[11.5px] text-muted">{step.durationSec}s</span>}
            </CardHeader>
            <CardContent className="gap-1">
              {Object.entries(step.outputFields ?? {}).slice(0, 4).map(([fieldKey, value]) => (
                <p key={fieldKey} className="m-0 text-[13px] leading-relaxed line-clamp-3">
                  <b className="text-brand text-[11px] uppercase mr-1">{fieldKey}</b>
                  {value.slice(0, 160)}
                </p>
              ))}
              {step.runId && (
                <Button size="sm" variant="ghost" className="justify-self-start mt-1" onClick={() => props.onOpenRun(step.runId!)}>
                  {t("library.open")} →
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  ) : null;

  return (
    <RouteLayout title={t("team.title")} subtitle={t("team.subtitle")}>
      {StageBar}
      <ErrorBanner error={error} />
      {stage === 1 && stageOne}
      {stage === 2 && stageTwo}
      {stage === 3 && (team ? stageThree : <EmptyState title={t("team.title")} body={t("sched.empty")} />)}
      {stage === 4 && (team ? stageFour : <EmptyState title={t("team.results")} body={t("sched.empty")} />)}
    </RouteLayout>
  );
}
