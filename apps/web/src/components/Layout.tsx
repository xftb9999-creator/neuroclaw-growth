import { type ReactNode, useEffect } from "react";

import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { LanguageSwitcher, useI18n } from "../lib/i18n.js";
import { navigate } from "../lib/router.js";
import type { RunStatus } from "../types.js";

function AuroraCanvas() {
  return (
    <div className="aurora-canvas" aria-hidden="true">
      <div className="aurora-blob b1" />
      <div className="aurora-blob b2" />
      <div className="aurora-blob b3" />
    </div>
  );
}

export function RouteLayout(props: { title: string; subtitle: string; children: ReactNode }) {
  const { t, embed } = useI18n();

  useEffect(() => {
    if (!embed) return;
    const post = () => {
      window.parent?.postMessage(
        { type: "neuroclaw:resize", height: document.documentElement.scrollHeight },
        "*"
      );
    };
    post();
    const observer = new ResizeObserver(post);
    observer.observe(document.body);
    return () => observer.disconnect();
  }, [embed]);

  return (
    <div className="min-h-screen flex flex-col">
      <AuroraCanvas />
      {!embed && (
        <header className="glass-nav sticky top-0 z-20">
          <div className="max-w-6xl w-full mx-auto px-6 py-3.5 flex items-center gap-5 flex-wrap max-[900px]:gap-3">
            <button
              type="button"
              className="brand-mark text-base cursor-pointer bg-transparent border-0 p-0"
              onClick={() => navigate("/home")}
              aria-label={t("common.appName")}
            >
              <span className="brand-glyph" aria-hidden="true" />
              <span>
                NeuroClaw<span className="text-brand"> Growth</span>
              </span>
            </button>

            <nav
              aria-label="Main navigation"
              className="flex items-center gap-1 ml-2 flex-wrap"
            >
              <Button variant="ghost" onClick={() => navigate("/home")}>
                {t("common.nav.home")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/templates")}>
                {t("common.nav.templates")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/profile")}>
                {t("common.nav.profile")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/agents")}>
                {t("common.nav.agents")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/history")}>
                {t("common.nav.history")}
              </Button>
              <Button variant="ghost" onClick={() => navigate("/memory")}>
                {t("common.nav.memory")}
              </Button>
            </nav>

            <div className="ml-auto flex items-center gap-2.5">
              <Button size="sm" onClick={() => navigate("/launch")} aria-label={t("launch.title")}>
                ✦ {t("launch.title")}
              </Button>
              <LanguageSwitcher />
            </div>
          </div>
        </header>
      )}

      <main className="flex-1 w-full max-w-6xl mx-auto px-6 py-8 grid gap-5 content-start fade-up">
        <div className="grid gap-1.5 mb-1">
          <h1 className="text-2xl font-bold m-0 tracking-tight">{props.title}</h1>
          <p className="text-muted m-0 text-[15px]">{props.subtitle}</p>
        </div>
        {props.children}
      </main>
    </div>
  );
}

export function ErrorBanner(props: { error: string | null }) {
  if (!props.error) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-danger-light text-danger rounded-input p-3 border border-danger/25"
    >
      {props.error}
    </div>
  );
}

export function InfoBanner(props: { message: string | null }) {
  if (!props.message) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-brand-light text-brand rounded-input p-3 border border-brand-dark/30"
    >
      {props.message}
    </div>
  );
}

export function EmptyState(props: { title: string; body: string; action?: ReactNode }) {
  return (
    <Card>
      <section aria-label={props.title} className="grid gap-2">
        <h3 className="text-lg font-semibold m-0">{props.title}</h3>
        <p className="text-muted m-0">{props.body}</p>
        {props.action && <div className="mt-2">{props.action}</div>}
      </section>
    </Card>
  );
}

export function statusToBadgeVariant(
  status: RunStatus | string
): "default" | "completed" | "waiting" | "failed" | "running" {
  switch (status) {
    case "completed":
      return "completed";
    case "waiting_approval":
      return "waiting";
    case "failed":
    case "cancelled":
      return "failed";
    case "running":
    case "queued":
    case "draft":
      return "running";
    default:
      return "default";
  }
}
