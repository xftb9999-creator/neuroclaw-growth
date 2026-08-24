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
import type { RunStatus } from "../types.js";

const PLAYBOOK_KEYS = ["sprint", "contentReview"] as const;

type View =
  | { level: "root" }
  | { level: "team"; teamId: string };

function stepStateVariant(state: TeamStepView["state"]) {
  switch (state) {
    case "done": return "completed" as const;
    case "running": return "running" as const;
    case "waiting_approval": return "waiting" as const;
    case "failed": return "failed" as const;
    default: return "info" as const;
  }
}

export function TeamPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [view, setView] = useState<View>({ level: "root" });
  const [recentTeams, setRecentTeams] = useState<TeamListItem[]>([]);
  const [team, setTeam] = useState<TeamRunRecord | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [playbookKey, setPlaybookKey] = useState<string>("sprint");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const [loadingRoot, setLoadingRoot] = useState(true);

  const loadRoot = useCallback(async () => {
    try {
      const items = await listTeams(props.workspaceId);
      setRecentTeams(items as typeof recentTeams);
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

  // 详情轮询
  useEffect(() => {
    if (view.level !== "team" || !team) return;
    if (team.status === "completed" || team.status === "failed") return;
    let stop = false;
    const timer = window.setInterval(async () => {
      try {
        const record = await getTeam(view.teamId);
        if (!stop) setTeam(record);
      } catch {
        // silent
      }
    }, 2500);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, [view, team?.status]);

  const openTeam = async (teamId: string) => {
    try {
      const record = await getTeam(teamId);
      setTeam(record);
      setSelectedStep(null);
      setView({ level: "team", teamId });
    } catch (openError) {
      if ((openError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
        props.onWorkspaceMissing(t("history.workspaceExpired"));
        return;
      }
      setError(openError instanceof Error ? openError.message : t("history.loadError"));
    }
  };

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
      setGoal("");
      setAudience("");
      await loadRoot();
      await openTeam(result.teamRunId);
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
    : "running";

  const participants = useMemo(() => {
    if (!team) return [];
    const seen = new Set<string>();
    for (const step of team.steps) seen.add(step.templateType);
    return [...seen];
  }, [team]);

  // ---------------------------------------------------------------------
  // LEVEL: 环节详情
  // ---------------------------------------------------------------------
  if (view.level === "team" && team && selectedStep !== null) {
    const step = team.steps[selectedStep];
    if (!step) {
      setSelectedStep(null);
      return null;
    }
    return (
      <RouteLayout title={`${t("team.stepDetail")} · ${selectedStep + 1}`} subtitle={t("team.subtitle")}>
        <Button variant="ghost" onClick={() => setSelectedStep(null)}>
          ← {t("team.backProcess")}
        </Button>

        <Card className="grid gap-3">
          <div className="flex items-center gap-2 flex-wrap">
            <strong className="text-[16px]">
              {t(`templates.names.${step.templateType}`) === `templates.names.${step.templateType}`
                ? step.templateType
                : t(`templates.names.${step.templateType}`)}
            </strong>
            <Badge variant={stepStateVariant(step.state)}>{step.state}</Badge>
            {step.durationSec !== undefined && step.durationSec !== null && (
              <span className="text-[12.5px] text-muted">⏱ {step.durationSec}s</span>
            )}
          </div>

          {step.startedAt && (
            <p className="m-0 text-[12.5px] text-muted">
              ⏱ {new Date(step.startedAt).toLocaleString()}
              {step.completedAt ? ` → ${new Date(step.completedAt).toLocaleString()}` : ""}
            </p>
          )}

          {Object.keys(step.outputFields ?? {}).length > 0 ? (
            <div className="grid gap-2">
              {Object.entries(step.outputFields ?? {}).map(([fieldKey, value]) => (
                <div key={fieldKey} className="border hairline rounded-input p-3 bg-white">
                  <span className="text-[11.5px] font-bold text-brand uppercase tracking-wide">{fieldKey}</span>
                  <p className="m-0 mt-1 text-[13.5px] leading-relaxed whitespace-pre-wrap">{value}</p>
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
      </RouteLayout>
    );
  }

  // ---------------------------------------------------------------------
  // LEVEL: 团队详情
  // ---------------------------------------------------------------------
  if (view.level === "team" && team) {
    return (
      <RouteLayout title={t(`team.playbook.${team.playbookKey}.name`)} subtitle={t("team.subtitle")}>
        <Button variant="ghost" onClick={() => { setView({ level: "root" }); setTeam(null); void loadRoot(); }}>
          ← {t("team.backList")}
        </Button>

        {/* 目标 / 时间 / 状态 */}
        <Card className="grid gap-2.5">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="grid gap-1">
              <span className="text-[11.5px] font-bold text-brand uppercase tracking-wide">🎯 {t("team.goalLabel")}</span>
              <p className="m-0 text-[15px] leading-relaxed">{team.goal}</p>
              {team.audience && (
                <span className="text-[12.5px] text-muted">👥 {team.audience}</span>
              )}
            </div>
            <Badge variant={teamStatusVariant}>{team.status}</Badge>
          </div>
          <div className="flex flex-wrap gap-4 text-[12px] text-muted border-t hairline pt-2">
            <span>🕒 {new Date(team.createdAt).toLocaleString()}</span>
            {team.updatedAt !== team.createdAt && (
              <span>↻ {new Date(team.updatedAt).toLocaleString()}</span>
            )}
            <span>{t("team.progress")}: {Math.min(team.currentStep + 1, team.steps.length)}/{team.steps.length}</span>
          </div>
        </Card>

        {/* 参与者 */}
        <Card className="grid gap-2">
          <span className="text-[12px] font-bold text-brand uppercase tracking-wide">👥 {t("team.participants")}</span>
          <div className="flex flex-wrap gap-2">
            {participants.map((type) => (
              <span key={type} className="text-[13px] font-medium bg-surface-strong rounded-pill px-3 py-1">
                {t(`templates.names.${type}`) === `templates.names.${type}` ? type : t(`templates.names.${type}`)}
              </span>
            ))}
          </div>
        </Card>

        {/* 流程 Stepper(可点入环节) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-[15.5px]">🔄 {t("common.nav.workflows")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="m-0 p-0 list-none grid">
              {team.steps.map((step, index) => (
                <li key={`${index}-${step.templateType}`} className="flex gap-3.5">
                  <div className="flex flex-col items-center">
                    <span
                      className={`inline-flex w-8 h-8 items-center justify-center rounded-full border text-[13px] font-bold ${
                        step.state === "done"
                          ? "bg-ok-light text-ok border-ok/30"
                          : step.state === "running"
                            ? "bg-brand-light text-brand border-brand/40 pulse-dot"
                            : step.state === "waiting_approval"
                              ? "bg-warn-light text-warn border-warn/30"
                              : step.state === "failed"
                                ? "bg-danger-light text-danger border-danger/30"
                                : "bg-surface-strong text-muted border-line"
                      }`}
                      aria-hidden="true"
                    >
                      {step.state === "done" ? "✓" : step.state === "running" ? "●" : step.state === "waiting_approval" ? "⏸" : step.state === "failed" ? "✕" : "○"}
                    </span>
                    {index < team.steps.length - 1 && (
                      <span className={`w-[2px] flex-1 min-h-[24px] my-1 rounded ${step.state === "done" ? "bg-ok/50" : "bg-line"}`} aria-hidden="true" />
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedStep(index)}
                    className="pb-4 pt-1 text-left grid gap-0.5 bg-transparent border-0 cursor-pointer flex-1"
                  >
                    <span className="flex items-center gap-2 flex-wrap">
                      <strong className="text-[14.5px]">
                        {index + 1}. {t(`templates.names.${step.templateType}`) === `templates.names.${step.templateType}` ? step.templateType : t(`templates.names.${step.templateType}`)}
                      </strong>
                      <Badge variant={stepStateVariant(step.state)}>{step.state}</Badge>
                      {step.durationSec != null && (
                        <span className="text-[11.5px] text-muted">{step.durationSec}s</span>
                      )}
                    </span>
                    {step.outputSummary && (
                      <span className="text-[12.5px] text-muted line-clamp-1 max-w-md">{step.outputSummary}</span>
                    )}
                  </button>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>

        {/* 结果汇总 */}
        <Card className="grid gap-2">
          <span className="text-[12px] font-bold text-brand uppercase tracking-wide">📦 {t("analytics.byAgent")} · {t("team.results")}</span>
          <div className="grid md:grid-cols-2 gap-3">
            {team.steps.filter((step) => step.outputSummary).map((step, index) => (
              <div key={`result-${index}-${step.templateType}`} className="border hairline rounded-input p-3 bg-white grid gap-1">
                <Badge variant="default">{t(`templates.names.${step.templateType}`)}</Badge>
                <p className="m-0 text-[13px] text-ink leading-relaxed line-clamp-3">{step.outputSummary}</p>
              </div>
            ))}
          </div>
        </Card>
      </RouteLayout>
    );
  }

  // ---------------------------------------------------------------------
  // LEVEL: 根列表(playbooks + 近期团队)
  // ---------------------------------------------------------------------
  return (
    <RouteLayout title={t("team.title")} subtitle={t("team.subtitle")}>
      <ErrorBanner error={error} />

      {recentTeams.length > 0 && (
        <section className="grid gap-3">
          <h3 className="m-0 text-[15px] font-bold tracking-tight">{t("team.recent")}</h3>
          <div className="grid gap-3 md:grid-cols-2">
            {recentTeams.slice(0, 6).map((item) => (
              <Card key={item.id} className="glass-hover lift cursor-pointer" onClick={() => void openTeam(item.id)}>
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
                <p className="m-0 mt-1 text-[11.5px] text-muted/80">
                  {t("team.progress")}: {item.currentStep}
                  {" · "}
                  {item.createdAt ? new Date(item.createdAt).toLocaleDateString() : ""}
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
              onClick={() => setPlaybookKey(key)}
            >
              <CardHeader>
                <CardTitle className="text-[16px]">{t(`team.playbook.${key}.name`)}</CardTitle>
                {playbookKey === key && <Badge variant="default">✓</Badge>}
              </CardHeader>
              <CardContent>
                <p className="m-0 text-[13px] text-muted leading-relaxed">
                  {t(`team.playbook.${key}.desc`)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="grid gap-3">
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
      </section>

      {loadingRoot && <Card><Skeleton className="h-16 w-full" /></Card>}
      {!loadingRoot && recentTeams.length === 0 && (
        <EmptyState title={t("inbox.emptyTitle")} body={t("knowledge.attachedHint")} />
      )}
    </RouteLayout>
  );
}
