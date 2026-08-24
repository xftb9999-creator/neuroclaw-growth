import { useCallback, useEffect, useState } from "react";

import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  listTemplates,
  type ScheduleRecord
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Badge, Input, Label, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";

const INTERVALS = [
  { minutes: 5, key: "demo" },
  { minutes: 1440, key: "daily" },
  { minutes: 10080, key: "weekly" }
] as const;

export function SchedulePage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const [templates, setTemplates] = useState<Array<{ type: string; name: string }>>([]);
  const [templateType, setTemplateType] = useState<string | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState<number>(1440);
  const [label, setLabel] = useState("");
  const [goal, setGoal] = useState("");
  const [items, setItems] = useState<ScheduleRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [scheduleItems, templateItems] = await Promise.all([
        listSchedules(props.workspaceId),
        listTemplates()
      ]);
      setItems(scheduleItems as ScheduleRecord[]);
      setTemplates(templateItems as Array<{ type: string; name: string }>);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    if (!templateType || !goal.trim()) return;
    setSaving(true);
    try {
      await createSchedule({
        workspaceId: props.workspaceId,
        templateType,
        label: label.trim() || `${t(`templates.names.${templateType}`)} · ${intervalMinutes}m`,
        inputPayload: { businessSummary: goal.trim(), preferredChannels: ["email"] },
        intervalMinutes
      });
      setGoal("");
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("history.loadError"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <RouteLayout title={t("sched.title")} subtitle={t("sched.subtitle")}>
      <ErrorBanner error={error} />

      <Card className="grid gap-4">
        <section className="grid gap-2">
          <Badge variant="default">1 · {t("builder.step.base")}</Badge>
          <div className="flex flex-wrap gap-2">
            {(loading ? [] : templates).map((template) => (
              <button
                key={template.type}
                type="button"
                onClick={() => setTemplateType(template.type)}
                aria-pressed={templateType === template.type}
                className={`text-[13.5px] font-medium rounded-pill px-4 py-2 border cursor-pointer transition-all ${
                  templateType === template.type
                    ? "border-brand bg-brand-light text-brand"
                    : "border-line-strong bg-white hover:border-brand/50"
                }`}
              >
                {templateType === template.type ? "✓ " : ""}
                {t(`templates.names.${template.type}`) === `templates.names.${template.type}`
                  ? template.name
                  : t(`templates.names.${template.type}`)}
              </button>
            ))}
          </div>
        </section>

        <section className="grid gap-2">
          <Badge variant="default">2 · {t("sched.frequency")}</Badge>
          <div className="flex flex-wrap gap-2">
            {INTERVALS.map((interval) => (
              <button
                key={interval.key}
                type="button"
                onClick={() => setIntervalMinutes(interval.minutes)}
                aria-pressed={intervalMinutes === interval.minutes}
                className={`text-[13.5px] font-medium rounded-pill px-4 py-2 border cursor-pointer transition-all ${
                  intervalMinutes === interval.minutes
                    ? "border-brand bg-brand-light text-brand"
                    : "border-line-strong bg-white hover:border-brand/50"
                }`}
              >
                {t(`sched.freq.${interval.key}`)}
              </button>
            ))}
          </div>
        </section>

        <Label>
          <span>{t("team.goalLabel")}</span>
          <Input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder={t("home.launch.placeholder")} />
        </Label>
        <Button onClick={() => void add()} disabled={saving || !templateType || !goal.trim()} className="justify-self-start">
          {saving ? t("setup.launching") : `⏰ ${t("sched.add")}`}
        </Button>
      </Card>

      {loading ? (
        <Card><Skeleton className="h-16 w-full" /></Card>
      ) : items.length === 0 ? (
        <EmptyState title={t("sched.title")} body={t("sched.empty")} />
      ) : (
        <div className="grid gap-3">
          {items.map((item) => (
            <Card key={item.id} className="glass-hover lift grid gap-1.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <strong className="text-[14.5px]">{item.label}</strong>
                <Badge variant={item.status === "active" ? "completed" : "failed"}>{item.status}</Badge>
              </div>
              <span className="text-[12.5px] text-muted">
                {locale.startsWith("zh") ? "下次执行" : "Next run"}:{" "}
                {new Date(item.nextRunAt).toLocaleString()}
                {item.lastStatus ? ` · last: ${item.lastStatus}` : ""}
              </span>
              <div className="pt-1">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await deleteSchedule(item.id);
                    await load();
                  }}
                >
                  {t("knowledge.delete")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </RouteLayout>
  );
}
