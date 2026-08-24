import { useState } from "react";

import { createWorkspace } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input, Label } from "../components/ui/Input.js";
import { ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";
import type { WorkspacePlan } from "../types.js";

const selectClass =
  "w-full border border-line bg-white rounded-input px-4 py-3 text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand transition-colors hover:border-line-strong";

const tileTints = [
  "bg-[#fff0e7] text-brand",
  "bg-[#fdf5e3] text-warn",
  "bg-[#e9f6ee] text-ok",
  "bg-[#f0ecff] text-[#6d5bd0]"
] as const;

export function OnboardingPage(props: {
  sessionNotice: string | null;
  onCreated: (workspaceId: string) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<WorkspacePlan>("growth");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  return (
    <RouteLayout title={t("onboarding.title")} subtitle={t("onboarding.subtitle")}>
      <section className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] items-start max-[1100px]:grid-cols-1">
        <div className="grid gap-7 fade-up">
          <div className="grid gap-4">
            <span className="inline-flex w-fit items-center gap-2 rounded-pill border border-brand-dark/40 bg-brand-light px-3.5 py-1.5 text-[13px] font-semibold text-brand">
              <span className="pulse-dot inline-block w-2 h-2 rounded-full bg-ember" aria-hidden="true" />
              {t("onboarding.hero.badge")}
            </span>
            <h2 className="text-4xl leading-[1.12] font-extrabold m-0 tracking-tight max-[900px]:text-3xl">
              {t("onboarding.hero.title1")}
              <br />
              <span className="text-gradient">{t("onboarding.hero.title2")}</span>
            </h2>
            <p className="text-muted text-[15px] leading-relaxed m-0 max-w-xl">
              {t("onboarding.hero.desc")}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {(
              [
                ["templates", "◆"],
                ["approval", "⛨"],
                ["memory", "❖"],
                ["embed", "⧉"]
              ] as const
            ).map(([key, glyph], index) => (
              <div key={key} className="glass glass-hover p-4 grid gap-1 lift">
                <span
                  className={`inline-flex w-8 h-8 items-center justify-center rounded-input font-bold ${tileTints[index]}`}
                  aria-hidden="true"
                >
                  {glyph}
                </span>
                <strong className="text-[15px]">{t(`onboarding.feat.${key}.t`)}</strong>
                <span className="text-muted text-[13px] leading-snug">
                  {t(`onboarding.feat.${key}.d`)}
                </span>
              </div>
            ))}
          </div>
        </div>

        <Card className="lg:sticky lg:top-24">
          <form
            className="grid gap-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              setIsSubmitting(true);

              try {
                if (!name.trim()) {
                  throw new Error(t("onboarding.nameRequired"));
                }

                const workspace = (await createWorkspace({ name, plan })) as { id: string };
                props.onCreated(workspace.id);
              } catch (error) {
                setError(error instanceof Error ? error.message : t("templates.loadError"));
              } finally {
                setIsSubmitting(false);
              }
            }}
          >
            <InfoBanner message={props.sessionNotice} />
            <ErrorBanner error={error} />
            <Label>
              <span>{t("onboarding.nameLabel")}</span>
              <Input
                data-testid="workspace-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Growth Lab"
              />
            </Label>
            <Label>
              <span>{t("onboarding.planLabel")}</span>
              <select
                value={plan}
                onChange={(event) => setPlan(event.target.value as WorkspacePlan)}
                className={selectClass}
                aria-label={t("onboarding.planLabel")}
              >
                <option value="growth">Growth</option>
                <option value="starter">Starter</option>
              </select>
            </Label>
            <Button
              data-testid="create-workspace"
              type="submit"
              size="lg"
              disabled={isSubmitting}
              aria-label={isSubmitting ? t("onboarding.creatingAria") : t("onboarding.createdAria")}
            >
              {isSubmitting ? t("onboarding.creating") : t("onboarding.create")}
            </Button>
          </form>
        </Card>
      </section>
    </RouteLayout>
  );
}
