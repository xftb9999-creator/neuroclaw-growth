import { runDraftStorageKey, workspaceStorageKey } from "./workspace.js";
import type { ClonedRunPayload, Route, TemplateType } from "../types.js";

export function parseRoute(pathname: string): Route {
  if (pathname === "/onboarding") return { name: "onboarding" };
  if (pathname === "/" || pathname === "/home") return { name: "home" };
  if (pathname === "/templates") return { name: "templates" };
  if (pathname === "/profile") return { name: "profile" };
  if (pathname === "/launch") return { name: "launch" };
  if (pathname === "/history") return { name: "history" };
  if (pathname === "/memory") return { name: "memory" };

  const runSetupMatch = pathname.match(/^\/runs\/new\/([^/]+)$/);
  if (runSetupMatch) {
    return { name: "run-setup", templateType: runSetupMatch[1] as TemplateType };
  }

  const resultMatch = pathname.match(/^\/runs\/([^/]+)\/result$/);
  if (resultMatch) {
    return { name: "result", runId: resultMatch[1] };
  }

  const runMatch = pathname.match(/^\/runs\/([^/]+)$/);
  if (runMatch) {
    return { name: "run-status", runId: runMatch[1] };
  }

  return { name: "onboarding" };
}

export function navigate(path: string): void {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function readWorkspaceId(): string | null {
  return window.localStorage.getItem(workspaceStorageKey);
}

export function writeWorkspaceId(workspaceId: string): void {
  window.localStorage.setItem(workspaceStorageKey, workspaceId);
}

export function clearWorkspaceId(): void {
  window.localStorage.removeItem(workspaceStorageKey);
}

export function writeRunDraft(payload: ClonedRunPayload): void {
  window.localStorage.setItem(runDraftStorageKey, JSON.stringify(payload));
}

export function readRunDraft(templateType: TemplateType): ClonedRunPayload | null {
  const raw = window.localStorage.getItem(runDraftStorageKey);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as ClonedRunPayload;
    return parsed.templateType === templateType ? parsed : null;
  } catch {
    return null;
  }
}

export function clearRunDraft(): void {
  window.localStorage.removeItem(runDraftStorageKey);
}
