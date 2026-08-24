import { useCallback, useEffect, useState } from "react";

import {
  getTeam,
  launchTeam,
  type TeamRunRecord,
  type TeamStepView
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Input, Label } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunStatus } from "../types.js";

const PLAYBOOK_KEYS = ["sprint", "contentReview"] as const;

function stepBadgeVariant(state: TeamStepView["state"]) {
  switch (state) {
    case "done":
      return "completed" as const;
    case "running":
      return "running" as const;
    case "waiting_approval":
      return "waiting" as const;
    case "failed":
      return "failed" as const;
    default:
      return "info" as const;
  }
}

export function TeamPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [playbookKey, setPlaybookKey] = useState<string>("sprint");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [teamRunId, setTeamRunId] = useState<string | null>(null);
  const [team, setTeam] = useState<TeamRunRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  // 轮询团队状态(运行中/等审批时每 2.5s)
  useEffect(() => {
    if (!teamRunId) return;
    let stop = false;
    const tick = async () => {
      try {
        const record = await getTeam(teamRunId);
        if (stop) return;
        setTeam(record);
        if (record.status === "completed" || record.status === "failed") {
          return; // 终态停止轮询
        }
      } catch (pollError) {
        if ((pollError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
          props.onWorkspaceMissing(t("history.workspaceExpired"));
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2500);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamRunId]);

  const start = useCallback(async () => {
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
    } catch (launchError) {
      if ((launchError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
        props.onWorkspaceMissing(t("setup.workspaceExpired"));
        return;
      }
      setError(launchError instanceof Error ? launchError.message : t("team.failed"));
    } finally {
      setLaunching(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId, playbookKey, goal, audience]);

  const teamStatusVariant = statusToBadgeVariant(
    team?.status === "waiting_approval"
      ? "waiting_approval"
      : team?.status === "completed"
        ? "completed"
        : team?.status === "failed"
          ? "failed"
          : ("running" satisfies RunStatus)
  );

  return (
    <RouteLayout title={t("team.title")} subtitle={t("team.subtitle")}>
      <ErrorBanner error={error} />

      {/* Playbook 选择 */}
      {!teamRunId && (
        <>
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
                  {/* 步骤链预览 */}
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {(key === "sprint"
                      ? ["content_acquisition", "private_conversion", "weekly_review"]
                      : ["content_acquisition", "weekly_review"]
                    ).map((type, index) => (
                      <span
                        key={type}
                        className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1"
                      >
                        {index + 1}. {t(`templates.names.${type}`) === `templates.names.${type}` ? type : t(`templates.names.${type}`)}
                      </span>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card className="grid gap-3">
            <Label>
              <span>{t("team.goalLabel")}</span>
              <Input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="母婴店开业周,主打安全与性价比…" />
            </Label>
            <Label>
              <span>{t("team.audienceLabel")}</span>
              <Input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="新手妈妈" />
            </Label>
            <Button size="lg" onClick={() => void start()} disabled={launching || !goal.trim()}>
              {launching ? t("team.running") : t("team.start")}
            </Button>
          </Card>
        </>
      )}

      {/* 服务端接力视图 */}
      {team && (
        <Card className="grid gap-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle className="text-[16px] m-0">
              {t(`team.playbook.${team.playbookKey}.name`)}
            </CardTitle>
            <Badge variant={teamStatusVariant}>{team.status}</Badge>
          </div>

          <ol className="m-0 p-0 list-none grid gap-0">
            {team.steps.map((step, index) => (
              <li key={`${step.templateType}-${index}`} className="flex gap-3.5">
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
                    {step.state === "done"
                      ? "✓"
                      : step.state === "running"
                        ? "●"
                        : step.state === "waiting_approval"
                          ? "⏸"
                          : step.state === "failed"
                            ? "✕"
                            : "○"}
                  </span>
                  {index < team.steps.length - 1 && (
                    <span
                      className={`w-[2px] flex-1 min-h-[26px] my-1 rounded ${
                        step.state === "done" ? "bg-ok/50" : "bg-line"
                      }`}
                      aria-hidden="true"
                    />
                  )}
                </div>
                <div className="pb-5 pt-1 grid gap-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <strong className="text-[14.5px]">
                      {index + 1}. {t(`templates.names.${step.templateType}`) === `templates.names.${step.templateType}` ? step.templateType : t(`templates.names.${step.templateType}`)}
                    </strong>
                    <Badge variant={stepBadgeVariant(step.state)}>
                      {step.state === "waiting_approval" ? t("status.approvalNeeded") : step.state}
                    </Badge>
                    {step.feedFrom.length > 0 && (
                      <span className="text-[11.5px] text-muted">
                        ← {step.feedFrom.join(", ")}
                      </span>
                    )}
                  </div>
                  {step.outputSummary && (
                    <p className="m-0 text-[12.5px] text-muted leading-snug max-w-md line-clamp-2">
                      {step.outputSummary}
                    </p>
                  )}
                  {step.runId && (
                    <Button size="sm" variant="ghost" onClick={() => props.onOpenRun(step.runId!)}>
                      {t("library.open")} →
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ol>

          {team.status !== "completed" && team.status !== "failed" && (
            <p className="m-0 text-[12.5px] text-muted flex items-center gap-1.5">
              <span className="pulse-dot inline-block w-2 h-2 rounded-full bg-brand" aria-hidden="true" />
              {team.status === "waiting_approval" ? t("status.approvalNeeded") : t("team.running")}
            </p>
          )}
        </Card>
      )}
    </RouteLayout>
  );
}
