import { lazy, startTransition, Suspense, useEffect, useState } from "react";
import { cloneRun } from "./lib/api.js";
import { clearRunDraft, clearWorkspaceId, navigate, parseRoute, readWorkspaceId, writeRunDraft, writeWorkspaceId } from "./lib/router.js";
import type { ClonedRunPayload, Route, RunRecord } from "./types.js";

// Route-level code splitting (Round P, audit P1-3): every page is a lazy
// chunk; the shell (react/query/i18n/layout/api) stays in the entry bundle.
const AgentBuilderPage = lazy(() => import("./pages/AgentBuilderPage.js").then((m) => ({ default: m.AgentBuilderPage })));
const AgentsSquarePage = lazy(() => import("./pages/AgentsSquarePage.js").then((m) => ({ default: m.AgentsSquarePage })));
const AnalyticsPage = lazy(() => import("./pages/AnalyticsPage.js").then((m) => ({ default: m.AnalyticsPage })));
const BillingPage = lazy(() => import("./pages/BillingPage.js").then((m) => ({ default: m.BillingPage })));
const CockpitPage = lazy(() => import("./pages/CockpitPage.js").then((m) => ({ default: m.CockpitPage })));
const CrewsPage = lazy(() => import("./pages/CrewsPage.js").then((m) => ({ default: m.CrewsPage })));
const BrandProfilePage = lazy(() => import("./pages/BrandProfilePage.js").then((m) => ({ default: m.BrandProfilePage })));
const HistoryPage = lazy(() => import("./pages/HistoryPage.js").then((m) => ({ default: m.HistoryPage })));
const HomePage = lazy(() => import("./pages/HomePage.js").then((m) => ({ default: m.HomePage })));
const InboxPage = lazy(() => import("./pages/InboxPage.js").then((m) => ({ default: m.InboxPage })));
const KnowledgePage = lazy(() => import("./pages/KnowledgePage.js").then((m) => ({ default: m.KnowledgePage })));
const LaunchFlowPage = lazy(() => import("./pages/LaunchFlowPage.js").then((m) => ({ default: m.LaunchFlowPage })));
const LibraryPage = lazy(() => import("./pages/LibraryPage.js").then((m) => ({ default: m.LibraryPage })));
const MemoryPage = lazy(() => import("./pages/MemoryPage.js").then((m) => ({ default: m.MemoryPage })));
const SchedulePage = lazy(() => import("./pages/SchedulePage.js").then((m) => ({ default: m.SchedulePage })));
const TeamPage = lazy(() => import("./pages/TeamPage.js").then((m) => ({ default: m.TeamPage })));
const WorkflowsPage = lazy(() => import("./pages/WorkflowsPage.js").then((m) => ({ default: m.WorkflowsPage })));
const OnboardingPage = lazy(() => import("./pages/OnboardingPage.js").then((m) => ({ default: m.OnboardingPage })));
const ResultDetailPage = lazy(() => import("./pages/ResultDetailPage.js").then((m) => ({ default: m.ResultDetailPage })));
const RunSetupPage = lazy(() => import("./pages/RunSetupPage.js").then((m) => ({ default: m.RunSetupPage })));
const RunStatusPage = lazy(() => import("./pages/RunStatusPage.js").then((m) => ({ default: m.RunStatusPage })));
const TemplatePickerPage = lazy(() => import("./pages/TemplatePickerPage.js").then((m) => ({ default: m.TemplatePickerPage })));

function PageFallback() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="grid gap-3 py-10">
      <div className="h-6 w-40 rounded-input bg-surface-strong animate-pulse" />
      <div className="h-4 w-3/4 rounded-input bg-surface-strong animate-pulse" />
      <div className="h-32 w-full rounded-card bg-surface-strong animate-pulse" />
    </div>
  );
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [workspaceId, setWorkspaceId] = useState<string | null>(() => readWorkspaceId());
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const go = (path: string) => startTransition(() => { navigate(path); setRoute(parseRoute(path)); });
  const persist = (id: string) => { writeWorkspaceId(id); setWorkspaceId(id); setSessionNotice(null); };
  const recover = (msg: string) => {
    clearWorkspaceId(); clearRunDraft(); setWorkspaceId(null); setSessionNotice(msg);
    startTransition(() => { navigate("/onboarding"); setRoute({ name: "onboarding" }); });
  };
  const runAgain = (run: RunRecord) => {
    writeRunDraft({ templateType: run.templateType, input: run.input, sourceRunId: run.id });
    go(`/runs/new/${run.templateType}`);
  };

  let page = <PageFallback />;
  if (route.name === "onboarding" || !workspaceId)
    page = <OnboardingPage sessionNotice={sessionNotice} onCreated={(id) => { persist(id); go("/templates"); }} />;
  else if (route.name === "home")
    page = <HomePage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "cockpit")
    page = <CockpitPage workspaceId={workspaceId} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "launch")
    page = (
      <LaunchFlowPage
        workspaceId={workspaceId}
        initialQuery={window.sessionStorage.getItem("neuroclaw.launchQuery") ?? ""}
        onWorkspaceMissing={recover}
        onLaunched={(id) => go(`/runs/${id}`)}
      />
    );
  else if (route.name === "templates")
    page = <TemplatePickerPage onSelect={(t) => go(`/runs/new/${t}`)} />;
  else if (route.name === "agents")
    page = <AgentsSquarePage />;
  else if (route.name === "agent-new")
    page = <AgentBuilderPage onCreated={() => go("/agents")} />;
  else if (route.name === "workflows")
    page = <WorkflowsPage />;
  else if (route.name === "library")
    page = <LibraryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "knowledge")
    page = <KnowledgePage workspaceId={workspaceId} />;
  else if (route.name === "team")
    page = <TeamPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "team-detail")
    page = <TeamPage key={route.teamId} teamId={route.teamId} focus="pipeline" workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "team-results")
    page = <TeamPage key={`r-${route.teamId}`} teamId={route.teamId} focus="results" workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "inbox")
    page = <InboxPage workspaceId={workspaceId} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "schedule")
    page = <SchedulePage workspaceId={workspaceId} onWorkspaceMissing={recover} />;
  else if (route.name === "analytics")
    page = <AnalyticsPage workspaceId={workspaceId} />;
  else if (route.name === "billing")
    page = <BillingPage workspaceId={workspaceId} />;
  else if (route.name === "crews")
    page = <CrewsPage />;
  else if (route.name === "profile")
    page = <BrandProfilePage workspaceId={workspaceId} onWorkspaceMissing={recover} />;
  else if (route.name === "history")
    page = <HistoryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)}
      onReuse={async (id) => { const p = (await cloneRun(id)) as ClonedRunPayload; writeRunDraft(p); go(`/runs/new/${p.templateType}`); }} />;
  else if (route.name === "memory")
    page = <MemoryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "run-setup")
    page = <RunSetupPage key={route.templateType} workspaceId={workspaceId} templateType={route.templateType}
      onWorkspaceMissing={recover} onCreated={(id) => go(`/runs/${id}`)} />;
  else if (route.name === "run-status")
    page = <RunStatusPage runId={route.runId} onViewResult={(id) => go(`/runs/${id}/result`)} onRunAgain={runAgain} />;
  else
    page = <ResultDetailPage runId={route.runId} onRunAgain={runAgain} onBackToStatus={(id) => go(`/runs/${id}`)} />;

  return <Suspense fallback={<PageFallback />}>{page}</Suspense>;
}
