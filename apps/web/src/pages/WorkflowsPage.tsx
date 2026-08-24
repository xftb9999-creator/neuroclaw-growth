import { useEffect, useMemo, useState } from "react";

import { listTemplates } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";

interface StepDef {
  templateType: string;
  roleKey: string;
  feedFrom: string[];
}

interface TemplateLike {
  id: string;
  type: string;
  name: string;
  description?: string;
}

interface PlaybookView {
  key: string;
  name: string;
  steps: StepDef[];
  builtin: boolean;
}

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return (await res.json()) as T;
}

export function WorkflowsPage() {
  const { t } = useI18n();
  const [playbooks, setPlaybooks] = useState<PlaybookView[]>([]);
  const [templates, setTemplates] = useState<TemplateLike[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draftSteps, setDraftSteps] = useState<StepDef[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet<PlaybookView[]>("/api/playbooks"),
      listTemplates() as unknown as Promise<TemplateLike[]>
    ])
      .then(([pb, tpl]) => {
        setPlaybooks(pb);
        setTemplates(tpl as unknown as TemplateLike[]);
      })
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : t("history.loadError"))
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const outputFieldsFor = (templateType: string): string[] => {
    void templates;
    const preset: Record<string, string[]> = {
      content_acquisition: ["contentAngles", "channelRecommendations"],
      private_conversion: ["conversionDraft", "approvalPreview"],
      weekly_review: ["reviewSummary", "nextActions"]
    };
    if (preset[templateType]) return preset[templateType];
    return ["output"];
  };

  const startEdit = (playbook: PlaybookView) => {
    setEditingKey(playbook.key);
    setDraftSteps(playbook.steps.map((step) => ({ ...step })));
  };

  const save = async () => {
    if (!editingKey) return;
    try {
      await apiPut(`/api/playbooks/${editingKey}`, {
        name: playbooks.find((item) => item.key === editingKey)?.name ?? editingKey,
        steps: draftSteps.map((step, index) => ({
          ...step,
          roleKey: step.roleKey || `step${index + 1}`
        }))
      });
      const refreshed = await apiGet<PlaybookView[]>("/api/playbooks");
      setPlaybooks(refreshed);
      setEditingKey(null);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t("history.loadError"));
    }
  };

  const agentOptions = useMemo(
    () => templates.length > 0 ? templates : [],
    [templates]
  );

  return (
    <RouteLayout title={t("workflow.title")} subtitle={t("workflow.subtitle")}>
      <ErrorBanner error={error} />
      {loading ? (
        <Card><Skeleton className="h-24 w-full" /></Card>
      ) : (
        <div className="grid gap-4">
          {playbooks.map((playbook) => {
            const isEditing = editingKey === playbook.key;
            const steps = isEditing ? draftSteps : playbook.steps;
            return (
              <Card key={playbook.key} className="grid gap-3">
                <CardHeader>
                  <CardTitle className="text-[16px]">
                    🔀 {t(`team.playbook.${playbook.key}.name`) === `team.playbook.${playbook.key}.name`
                      ? playbook.name
                      : t(`team.playbook.${playbook.key}.name`)}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    {!playbook.builtin && <Badge variant="default">custom</Badge>}
                    {isEditing ? (
                      <>
                        <Button size="sm" onClick={() => void save()}>💾 {t("memory.save")}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditingKey(null)}>
                          {t("memory.cancel")}
                        </Button>
                      </>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => startEdit(playbook)}>
                        ✏️ {t("workflow.edit")}
                      </Button>
                    )}
                  </div>
                </CardHeader>

                <CardContent className="grid gap-2">
                  {steps.map((step, index) => (
                    <div key={`${index}-${step.templateType}`} className="grid gap-1.5">
                      {isEditing ? (
                        <div className="flex flex-wrap items-center gap-2 p-3 rounded-input border hairline bg-white">
                          <select
                            value={step.templateType}
                            onChange={(event) =>
                              setDraftSteps((current) =>
                                current.map((item, i) =>
                                  i === index ? { ...item, templateType: event.target.value } : item
                                )
                              )
                            }
                            className="border border-line rounded-input px-3 py-2 text-[13.5px]"
                          >
                            {(agentOptions.length > 0 ? agentOptions : []).map((option) => (
                              <option key={option.type} value={option.type}>
                                {t(`templates.names.${option.type}`) === `templates.names.${option.type}`
                                  ? option.name
                                  : t(`templates.names.${option.type}`)}
                              </option>
                            ))}
                          </select>
                          <span className="text-[12px] text-muted">
                            ← {t("workflow.feedFrom")}
                          </span>
                          {(steps.slice(0, index).flatMap((prev) => outputFieldsFor(prev.templateType))).map((field) => (
                            <button
                              key={field}
                              type="button"
                              onClick={() =>
                                setDraftSteps((current) =>
                                  current.map((item, i) =>
                                    i === index
                                      ? {
                                          ...item,
                                          feedFrom: item.feedFrom.includes(field)
                                            ? item.feedFrom.filter((f) => f !== field)
                                            : [...item.feedFrom, field]
                                        }
                                      : item
                                  )
                                )
                              }
                              aria-pressed={step.feedFrom.includes(field)}
                              className={`text-[11.5px] rounded-pill px-2 py-0.5 border cursor-pointer ${
                                step.feedFrom.includes(field)
                                  ? "border-brand bg-brand-light text-brand"
                                  : "border-line-strong bg-white text-muted"
                              }`}
                            >
                              {field}
                            </button>
                          ))}
                          {steps.length > 1 && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setDraftSteps((current) => current.filter((_, i) => i !== index))}
                            >
                              ✕
                            </Button>
                          )}
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13.5px] font-medium bg-surface-strong rounded-pill px-3 py-1.5">
                            {index + 1}. {t(`templates.names.${step.templateType}`) === `templates.names.${step.templateType}` ? step.templateType : t(`templates.names.${step.templateType}`)}
                          </span>
                          {index < steps.length - 1 && (
                            <span className="text-muted">→</span>
                          )}
                          {step.feedFrom.length > 0 && index === steps.length - 1 && (
                            <span className="text-[11.5px] text-muted">← {step.feedFrom.join(", ")}</span>
                          )}
                        </div>
                      )}
                    </div>
                  ))}

                  {isEditing && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      {(agentOptions.length > 0 ? agentOptions : [{ type: "content_acquisition" }, { type: "private_conversion" }, { type: "weekly_review" }]).map((option) => (
                        <button
                          key={`add-${option.type}`}
                          type="button"
                          onClick={() =>
                            setDraftSteps((current) => [
                              ...current,
                              { templateType: option.type, roleKey: `step${current.length + 1}`, feedFrom: [] }
                            ])
                          }
                          className="text-[12.5px] border border-dashed border-line-strong rounded-pill px-3 py-1.5 text-muted hover:text-brand hover:border-brand/50 cursor-pointer bg-transparent"
                        >
                          ＋ {t(`templates.names.${option.type}`) === `templates.names.${option.type}` ? option.type : t(`templates.names.${option.type}`)}
                        </button>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </RouteLayout>
  );
}
