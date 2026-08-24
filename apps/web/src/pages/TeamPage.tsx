import { useState } from "react";

import { createRun } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Input, Label } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout, statusToBadgeVariant } from "../components/Layout.js";
import type { RunRecord, TemplateType } from "../types.js";

interface TeamStepDef {
  templateType: TemplateType;
  roleKey: string;
  /** 从上一步产出中提取哪些字段注入本步 businessSummary */
  feedFrom: string[];
}

const PLAYBOOKS: Array<{ key: string; steps: TeamStepDef[] }> = [
  {
    key: "sprint",
    steps: [
      { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
      {
        templateType: "private_conversion",
        roleKey: "conversion",
        feedFrom: ["contentAngles", "channelRecommendations"]
      },
      { templateType: "weekly_review", roleKey: "review", feedFrom: ["conversionDraft"] }
    ]
  },
  {
    key: "contentReview",
    steps: [
      { templateType: "content_acquisition", roleKey: "content", feedFrom: [] },
      { templateType: "weekly_review", roleKey: "review", feedFrom: ["contentAngles"] }
    ]
  }
];

type StepState = "pending" | "running" | "done" | "failed";

export function TeamPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [playbookKey, setPlaybookKey] = useState("sprint");
  const [goal, setGoal] = useState("");
  const [audience, setAudience] = useState("");
  const [states, setStates] = useState<StepState[]>([]);
  const [runIds, setRunIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const playbook = PLAYBOOKS.find((item) => item.key === playbookKey) ?? PLAYBOOKS[0];

  const launch = async () => {
    if (!goal.trim()) return;
    setError(null);
    setRunning(true);
    setStates(playbook.steps.map(() => "pending" as StepState));
    setRunIds([]);
    let carry: Record<string, unknown> = {};

    for (let index = 0; index < playbook.steps.length; index += 1) {
      const step = playbook.steps[index];
      setStates((current) => current.map((state, i) => (i === index ? "running" : state)));

      const carriedSummary = step.feedFrom
        .map((field) => {
          const value = carry[field];
          if (Array.isArray(value)) return value.join("; ");
          return typeof value === "string" ? value : "";
        })
        .filter(Boolean)
        .join("\n");

      try {
        const run = (await createRun({
          workspaceId: props.workspaceId,
          templateType: step.templateType,
          input: {
            businessSummary: carriedSummary
              ? `${goal.trim()}\n[来自上一环节的输入]\n${carriedSummary}`
              : goal.trim(),
            targetCustomer: audience.trim() || "目标客群",
            preferredChannels: ["email"],
            ...(step.templateType === "content_acquisition"
              ? { contentGoal: "团队接力产出" }
              : step.templateType === "private_conversion"
                ? { offerAsset: "团队接力 offer" }
                : { metricsWindowDays: 7 })
          }
        })) as RunRecord;

        setRunIds((current) => [...current, run.id]);
        carry = (run.outputPayload ?? {}) as Record<string, unknown>;

        // waiting_approval 视为本步完成(等待人工),继续推进下一步
        const terminal =
          run.status === "completed" || run.status === "waiting_approval" || run.status === "failed";
        setStates((current) =>
          current.map((state, i) =>
            i === index ? (run.status === "failed" ? "failed" : "done") : state
          )
        );
        if (!terminal && run.status !== "waiting_approval") {
          setStates((current) => current.map((state, i) => (i === index ? "failed" : state)));
        }
      } catch (stepError) {
        setStates((current) => current.map((state, i) => (i === index ? "failed" : state)));
        setError(
          stepError instanceof Error && stepError.message.includes("Workspace not found")
            ? t("setup.workspaceExpired")
            : stepError instanceof Error
              ? stepError.message
              : t("team.failed")
        );
        setRunning(false);
        return;
      }
    }

    setRunning(false);
  };

  return (
    <RouteLayout title={t("team.title")} subtitle={t("team.subtitle")}>
      <ErrorBanner error={error} />

      {/* Playbook 选择 */}
      <div className="grid gap-3 md:grid-cols-2">
        {PLAYBOOKS.map((item) => (
          <Card
            key={item.key}
            className={`cursor-pointer lift ${playbookKey === item.key ? "!border-brand ring-1 ring-brand/40" : ""}`}
            onClick={() => !running && setPlaybookKey(item.key)}
          >
            <CardHeader>
              <CardTitle className="text-[16px]">{t(`team.playbook.${item.key}.name`)}</CardTitle>
              {playbookKey === item.key && <Badge variant="default">✓</Badge>}
            </CardHeader>
            <CardContent>
              <p className="m-0 text-[13px] text-muted leading-relaxed">
                {t(`team.playbook.${item.key}.desc`)}
              </p>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {item.steps.map((step, index) => (
                  <span key={step.templateType} className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1">
                    {index + 1}. {t(`templates.names.${step.templateType}`)}
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 目标输入(仅两处轻量自由文本) */}
      <Card className="grid gap-3">
        <Label>
          <span>{t("team.goalLabel")}</span>
          <Input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="母婴店开业周,主打安全与性价比…" />
        </Label>
        <Label>
          <span>{t("team.audienceLabel")}</span>
          <Input value={audience} onChange={(event) => setAudience(event.target.value)} placeholder="新手妈妈" />
        </Label>
        <Button size="lg" onClick={() => void launch()} disabled={running || !goal.trim()}>
          {running ? t("team.running") : t("team.start")}
        </Button>
      </Card>

      {/* 接力链路状态 */}
      {states.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-[16px]">{t("team.step")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="m-0 p-0 list-none grid gap-2.5">
              {playbook.steps.map((step, index) => (
                <li key={step.templateType} className="flex items-center gap-3 flex-wrap">
                  <Badge variant={statusToBadgeVariant(states[index] === "done" ? "completed" : states[index])}>
                    {states[index] === "done"
                      ? `✓ ${t("team.done")}`
                      : states[index] === "running"
                        ? `● ${t("team.running")}`
                        : states[index] === "failed"
                          ? `✕ ${t("team.failed")}`
                          : "○"}
                  </Badge>
                  <strong className="text-[14px]">{index + 1}. {t(`templates.names.${step.templateType}`)}</strong>
                  {runIds[index] && (
                    <Button size="sm" variant="ghost" onClick={() => props.onOpenRun(runIds[index])}>
                      {t("library.open")} →
                    </Button>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </RouteLayout>
  );
}
