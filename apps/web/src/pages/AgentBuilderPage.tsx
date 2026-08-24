import { useEffect, useState } from "react";

import { createAgent, fetchMcpStatus, type McpStatusResponse } from "../lib/api.js";
import { navigate } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Badge, Input, Label } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";

type Step = "base" | "focus" | "style" | "tools" | "identity" | "confirm";

const BASES = ["content_acquisition", "private_conversion", "weekly_review"] as const;

const FOCUS_PRESETS: Record<string, string[]> = {
  "zh-CN": ["获客引流", "促单转化", "私域运营", "内容日更", "数据复盘", "活动策划"],
  "en-US": ["Acquisition", "Conversion", "Private domain", "Daily content", "Data review", "Campaigns"]
};

const STYLES = ["structured", "checklist", "copy"] as const;

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32);
}

export function AgentBuilderPage(props: { onCreated: () => void }) {
  const { t, locale } = useI18n();
  const [step, setStep] = useState<Step>("base");
  const [baseEngine, setBaseEngine] = useState<string | null>(null);
  const [focusAreas, setFocusAreas] = useState<string[]>([]);
  const [outputStyle, setOutputStyle] = useState<(typeof STYLES)[number]>("structured");
  const [toolNames, setToolNames] = useState<string[]>([]);
  const [mcp, setMcp] = useState<McpStatusResponse | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchMcpStatus()
      .then(setMcp)
      .catch(() => setMcp(null));
  }, []);

  const toggleMulti = (list: string[], value: string, setter: (next: string[]) => void) => {
    setter(list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);
  };

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await createAgent({
        slug: slugify(slug || name),
        name: name.trim(),
        baseEngine: baseEngine!,
        persona: `${t("builder.personaLead")} ${name.trim()}. ${t("builder.personaBody")} Focus: ${(FOCUS_PRESETS[locale] ?? FOCUS_PRESETS["zh-CN"]).join(", ") || focusAreas.join(", ")}. Output style: ${outputStyle}.`,
        description: focusAreas.join(" / "),
        focusAreas,
        outputStyle,
        toolNames
      });
      setDone(true);
      window.setTimeout(() => props.onCreated(), 900);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t("status.loadError"));
    } finally {
      setSubmitting(false);
    }
  };

  const choiceButton = (active: boolean) =>
    `text-[14px] font-medium rounded-input px-4 py-3 border cursor-pointer transition-all text-left ${
      active
        ? "border-brand bg-brand-light text-brand shadow-[0_4px_12px_rgba(189,79,34,0.15)]"
        : "border-line-strong bg-white hover:border-brand/50"
    }`;

  return (
    <RouteLayout title={t("builder.title")} subtitle={t("builder.subtitle")}>
      <ErrorBanner error={error} />
      {done ? (
        <Card className="p-8 text-center">
          <div className="text-4xl mb-2">🎉</div>
          <p className="m-0 font-bold">{t("builder.done")}</p>
        </Card>
      ) : (
        <Card className="p-6 grid gap-5 max-w-2xl">
          {/* Step 1 — 基座 */}
          <section className="grid gap-2.5">
            <Badge variant="default">
              1/5 · {t("builder.step.base")}
            </Badge>
            <div className="grid sm:grid-cols-3 gap-2.5">
              {BASES.map((base) => (
                <button
                  key={base}
                  type="button"
                  onClick={() => setBaseEngine(base)}
                  aria-pressed={baseEngine === base}
                  className={`${choiceButton(baseEngine === base)} grid gap-1`}
                >
                  <strong>{t(`templates.names.${base}`)}</strong>
                  <span className="text-[12px] text-muted font-normal leading-snug">
                    {t(`builder.base.${base}.d`)}
                  </span>
                </button>
              ))}
            </div>
          </section>

          {/* Step 2 — 专长 */}
          <section className={`grid gap-2.5 ${baseEngine ? "" : "opacity-40 pointer-events-none"}`}>
            <Badge variant="default">2/5 · {t("builder.step.focus")}</Badge>
            <div className="flex flex-wrap gap-2">
              {(FOCUS_PRESETS[locale] ?? FOCUS_PRESETS["zh-CN"]).map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => toggleMulti(focusAreas, preset, setFocusAreas)}
                  aria-pressed={focusAreas.includes(preset)}
                  className={choiceButton(focusAreas.includes(preset)) + " rounded-pill !py-2"}
                >
                  {focusAreas.includes(preset) ? "✓ " : ""}
                  {preset}
                </button>
              ))}
            </div>
          </section>

          {/* Step 3 — 输出风格 */}
          <section className={`grid gap-2.5 ${baseEngine ? "" : "opacity-40 pointer-events-none"}`}>
            <Badge variant="default">3/5 · {t("builder.step.style")}</Badge>
            <div className="grid sm:grid-cols-3 gap-2.5">
              {STYLES.map((style) => (
                <button
                  key={style}
                  type="button"
                  onClick={() => setOutputStyle(style)}
                  aria-pressed={outputStyle === style}
                  className={choiceButton(outputStyle === style)}
                >
                  {t(`builder.style.${style}`)}
                </button>
              ))}
            </div>
          </section>

          {/* Step 4 — 工具绑定 */}
          <section className={`grid gap-2.5 ${baseEngine ? "" : "opacity-40 pointer-events-none"}`}>
            <Badge variant="default">4/5 · {t("builder.step.toolbind")}</Badge>
            {mcp?.available && mcp.tools.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {mcp.tools.slice(0, 12).map((tool) => (
                  <button
                    key={`${tool.connection}-${tool.name}`}
                    type="button"
                    onClick={() => toggleMulti(toolNames, tool.name, setToolNames)}
                    aria-pressed={toolNames.includes(tool.name)}
                    className={choiceButton(toolNames.includes(tool.name)) + " rounded-pill !py-2"}
                    title={tool.description}
                  >
                    🧰 {tool.connection}/{tool.name}
                  </button>
                ))}
              </div>
            ) : (
              <p className="m-0 text-[13px] text-muted">{t("agents.mcpEmpty")}</p>
            )}
          </section>

          {/* Step 5 — 命名(名称类豁免自由输入)+ 确认 */}
          <section className={`grid gap-3 ${baseEngine ? "" : "opacity-40 pointer-events-none"}`}>
            <Badge variant="default">5/5 · {t("builder.step.identity")}</Badge>
            <Label>
              <span>{t("builder.field.name")}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="小红书种草官" />
            </Label>
            <Label>
              <span>{t("builder.field.slug")}</span>
              <Input
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                placeholder="xhs_seeding_pro"
              />
            </Label>

            {baseEngine && name.trim() && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant="default">{t(`templates.names.${baseEngine}`)}</Badge>
                {focusAreas.map((area) => (
                  <span key={area} className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1">
                    {area}
                  </span>
                ))}
                <span className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1">
                  {t(`builder.style.${outputStyle}`)}
                </span>
                {toolNames.length > 0 && (
                  <span className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-1">
                    🧰 ×{toolNames.length}
                  </span>
                )}
              </div>
            )}

            <Button
              size="lg"
              disabled={!baseEngine || !name.trim() || submitting}
              onClick={() => void submit()}
            >
              {submitting ? t("builder.creating") : t("builder.confirm")}
            </Button>
          </section>
        </Card>
      )}
    </RouteLayout>
  );
}

export { slugify };
