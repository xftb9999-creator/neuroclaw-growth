import { type ReactNode, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { listPendingApprovals } from "../lib/api.js";
import { readWorkspaceId } from "../lib/router.js";
import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { LanguageSwitcher, useI18n } from "../lib/i18n.js";
import { navigate } from "../lib/router.js";
import type { RunStatus } from "../types.js";

// ---------------------------------------------------------------------------
// Navigation IA — 3 groups (Round L, audit P0-E5): Growth / Crew / Assets
// ---------------------------------------------------------------------------

interface NavItem {
  path: string;
  labelKey: string;
}

const NAV_GROUPS: Array<{ key: string; labelKey: string; items: NavItem[] }> = [
  {
    key: "growth",
    labelKey: "nav.group.growth",
    items: [
      { path: "/cockpit", labelKey: "common.nav.cockpit" },
      { path: "/home", labelKey: "common.nav.home" },
      { path: "/schedule", labelKey: "common.nav.schedule" },
      { path: "/analytics", labelKey: "common.nav.analytics" },
      { path: "/billing", labelKey: "nav.billing" }
    ]
  },
  {
    key: "crew",
    labelKey: "nav.group.crew",
    items: [
      { path: "/crews", labelKey: "nav.crews" },
      { path: "/agents", labelKey: "common.nav.agents" },
      { path: "/team", labelKey: "common.nav.team" },
      { path: "/workflows", labelKey: "common.nav.workflows" }
    ]
  },
  {
    key: "assets",
    labelKey: "nav.group.assets",
    items: [
      { path: "/profile", labelKey: "common.nav.profile" },
      { path: "/knowledge", labelKey: "common.nav.knowledge" },
      { path: "/library", labelKey: "common.nav.library" },
      { path: "/history", labelKey: "common.nav.history" },
      { path: "/memory", labelKey: "common.nav.memory" }
    ]
  }
];

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
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  // Inbox badge (Round P): TanStack Query polling — pauses on hidden tabs.
  const badgeQuery = useQuery({
    queryKey: ["pending-approvals-badge"],
    queryFn: async () => (await listPendingApprovals(readWorkspaceId() ?? undefined)) as unknown[],
    enabled: !embed,
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    staleTime: 10_000
  });
  const pendingCount = embed ? 0 : badgeQuery.data?.length ?? 0;

  const goAndClose = (path: string) => {
    setOpenGroup(null);
    setMobileOpen(false);
    navigate(path);
  };

  useEffect(() => {
    if (!openGroup) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenGroup(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openGroup]);

  useEffect(() => {
    if (embed) return;
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
          <div className="max-w-6xl w-full mx-auto px-6 py-3.5 flex items-center gap-4">
            <button
              type="button"
              className="brand-mark text-base cursor-pointer bg-transparent border-0 p-0 shrink-0"
              onClick={() => goAndClose("/home")}
              aria-label={t("common.appName")}
            >
              <span className="brand-glyph" aria-hidden="true" />
              <span>
                NeuroClaw<span className="text-brand"> Growth</span>
              </span>
            </button>

            {/* Desktop — three grouped dropdowns */}
            <nav
              aria-label="Main navigation"
              className="relative hidden max-[900px]:hidden min-[901px]:flex items-center gap-1 ml-2"
            >
              {NAV_GROUPS.map((group) => (
                <div key={group.key} className="relative">
                  <Button
                    variant="ghost"
                    data-testid={`nav-group-${group.key}`}
                    aria-haspopup="true"
                    aria-expanded={openGroup === group.key}
                    onClick={() => setOpenGroup(openGroup === group.key ? null : group.key)}
                  >
                    {t(group.labelKey)} ▾
                  </Button>
                  {openGroup === group.key && (
                    <div
                      data-testid={`nav-panel-${group.key}`}
                      className="absolute left-0 top-full mt-1 min-w-[168px] rounded-card bg-white border hairline shadow-lg p-1.5 grid gap-0.5 z-30"
                    >
                      {group.items.map((item) => (
                        <button
                          key={item.path}
                          type="button"
                          className="text-left text-[14px] px-3 py-2 rounded-input hover:bg-surface-strong bg-transparent border-0 cursor-pointer"
                          onClick={() => goAndClose(item.path)}
                        >
                          {t(item.labelKey)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </nav>

            {/* Right cluster — inbox bell + launch CTA + language (+ mobile hamburger) */}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => goAndClose("/inbox")}
                className="relative inline-flex items-center gap-1.5 rounded-pill px-3.5 py-2 text-[14px] font-medium text-muted hover:text-ink hover:bg-surface-strong cursor-pointer bg-transparent border-0 transition-colors"
                aria-label={t("inbox.title")}
              >
                🔔
                {pendingCount > 0 && (
                  <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 text-[11px] font-bold text-white bg-danger rounded-full">
                    {pendingCount}
                  </span>
                )}
              </button>
              <Button size="sm" className="max-[560px]:hidden" onClick={() => goAndClose("/launch")} aria-label={t("launch.title")}>
                ✦ {t("launch.title")}
              </Button>
              <span className="max-[900px]:hidden"><LanguageSwitcher /></span>
              <button
                type="button"
                className="min-[901px]:hidden inline-flex items-center justify-center w-9 h-9 rounded-input bg-transparent border border-line cursor-pointer text-[16px]"
                aria-expanded={mobileOpen}
                aria-label={mobileOpen ? t("nav.group.closeMenu") : t("nav.group.openMenu")}
                onClick={() => setMobileOpen((value) => !value)}
              >
                {mobileOpen ? "✕" : "☰"}
              </button>
            </div>

            {openGroup && (
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                className="fixed inset-0 z-10 bg-transparent border-0 cursor-default"
                onClick={() => setOpenGroup(null)}
              />
            )}
          </div>

          {/* Mobile drawer */}
          {mobileOpen && (
            <nav
              aria-label="Mobile navigation"
              data-testid="mobile-nav"
              className="min-[901px]:hidden border-t hairline bg-white/95 backdrop-blur px-6 py-4 grid gap-4 max-h-[70vh] overflow-auto"
            >
              {NAV_GROUPS.map((group) => (
                <div key={group.key} className="grid gap-1">
                  <div className="text-[12px] font-semibold text-muted uppercase tracking-wide">
                    {t(group.labelKey)}
                  </div>
                  {group.items.map((item) => (
                    <button
                      key={item.path}
                      type="button"
                      className="text-left text-[15px] py-1.5 px-2 rounded-input hover:bg-surface-strong bg-transparent border-0 cursor-pointer"
                      onClick={() => goAndClose(item.path)}
                    >
                      {t(item.labelKey)}
                    </button>
                  ))}
                </div>
              ))}
              <div className="flex items-center gap-3 pt-2 border-t hairline">
                <Button size="sm" onClick={() => goAndClose("/launch")}>
                  ✦ {t("launch.title")}
                </Button>
                <LanguageSwitcher />
              </div>
            </nav>
          )}
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
