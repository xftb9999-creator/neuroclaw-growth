import { startTransition, useEffect, useState } from "react";
import { cloneRun } from "./lib/api.js";
import { clearRunDraft, clearWorkspaceId, navigate, parseRoute, readWorkspaceId, writeRunDraft, writeWorkspaceId } from "./lib/router.js";
import { AgentBuilderPage } from "./pages/AgentBuilderPage.js";
import { AgentsSquarePage } from "./pages/AgentsSquarePage.js";
import { AnalyticsPage } from "./pages/AnalyticsPage.js";
import { BrandProfilePage } from "./pages/BrandProfilePage.js";
import { HistoryPage } from "./pages/HistoryPage.js";
import { HomePage } from "./pages/HomePage.js";
import { InboxPage } from "./pages/InboxPage.js";
import { KnowledgePage } from "./pages/KnowledgePage.js";
import { LaunchFlowPage } from "./pages/LaunchFlowPage.js";
import { LibraryPage } from "./pages/LibraryPage.js";
import { MemoryPage } from "./pages/MemoryPage.js";
import { SchedulePage } from "./pages/SchedulePage.js";
import { TeamPage } from "./pages/TeamPage.js";
import { OnboardingPage } from "./pages/OnboardingPage.js";
import { ResultDetailPage } from "./pages/ResultDetailPage.js";
import { RunSetupPage } from "./pages/RunSetupPage.js";
import { RunStatusPage } from "./pages/RunStatusPage.js";
import { TemplatePickerPage } from "./pages/TemplatePickerPage.js";
import type { ClonedRunPayload, Route, RunRecord } from "./types.js";

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

  if (route.name === "onboarding" || !workspaceId)
    return <OnboardingPage sessionNotice={sessionNotice} onCreated={(id) => { persist(id); go("/templates"); }} />;
  if (route.name === "home")
    return <HomePage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  if (route.name === "launch")
    return (
      <LaunchFlowPage
        workspaceId={workspaceId}
        initialQuery={window.sessionStorage.getItem("neuroclaw.launchQuery") ?? ""}
        onWorkspaceMissing={recover}
        onLaunched={(id) => go(`/runs/${id}`)}
      />
    );
  if (route.name === "templates")
    return <TemplatePickerPage onSelect={(t) => go(`/runs/new/${t}`)} />;
  if (route.name === "agents")
    return <AgentsSquarePage />;
  if (route.name === "agent-new")
    return <AgentBuilderPage onCreated={() => go("/agents")} />;
  if (route.name === "library")
    return <LibraryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  if (route.name === "knowledge")
    return <KnowledgePage workspaceId={workspaceId} />;
  if (route.name === "team")
    return <TeamPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  if (route.name === "inbox")
    return <InboxPage workspaceId={workspaceId} onOpenRun={(id) => go(`/runs/${id}`)} />;
  if (route.name === "schedule")
    return <SchedulePage workspaceId={workspaceId} onWorkspaceMissing={recover} />;
  if (route.name === "analytics")
    return <AnalyticsPage workspaceId={workspaceId} />;
  if (route.name === "profile")
    return <BrandProfilePage workspaceId={workspaceId} onWorkspaceMissing={recover} />;
  if (route.name === "history")
    return <HistoryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)}
      onReuse={async (id) => { const p = (await cloneRun(id)) as ClonedRunPayload; writeRunDraft(p); go(`/runs/new/${p.templateType}`); }} />;
  if (route.name === "memory")
    return <MemoryPage workspaceId={workspaceId} onWorkspaceMissing={recover} onOpenRun={(id) => go(`/runs/${id}`)} />;
  if (route.name === "run-setup")
    return <RunSetupPage key={route.templateType} workspaceId={workspaceId} templateType={route.templateType}
      onWorkspaceMissing={recover} onCreated={(id) => go(`/runs/${id}`)} />;
  if (route.name === "run-status")
    return <RunStatusPage runId={route.runId} onViewResult={(id) => go(`/runs/${id}/result`)} onRunAgain={runAgain} />;
  return <ResultDetailPage runId={route.runId} onRunAgain={runAgain} onBackToStatus={(id) => go(`/runs/${id}`)} />;
}
