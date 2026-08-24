import { type ReactNode } from "react";

import { Button } from "./ui/Button.js";
import { Card } from "./ui/Card.js";
import { navigate } from "../lib/router.js";
import type { RunStatus } from "../types.js";

export function RouteLayout(props: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="min-h-screen grid grid-cols-[minmax(280px,32%)_1fr] max-[900px]:grid-cols-1">
      <aside
        className="p-8 bg-gradient-to-br from-ink to-brand-dark text-white flex flex-col gap-2"
        role="navigation"
      >
        <div className="text-2xl font-bold mb-4">NeuroClaw Growth</div>
        <h1 className="text-xl font-semibold m-0">{props.title}</h1>
        <p className="text-white/80 m-0 mb-4">{props.subtitle}</p>
        <nav aria-label="Main navigation" className="flex flex-col gap-1">
          <Button
            variant="ghost"
            className="text-white hover:bg-white/10 justify-start"
            onClick={() => navigate("/templates")}
          >
            Templates
          </Button>
          <Button
            variant="ghost"
            className="text-white hover:bg-white/10 justify-start"
            onClick={() => navigate("/history")}
          >
            History
          </Button>
          <Button
            variant="ghost"
            className="text-white hover:bg-white/10 justify-start"
            onClick={() => navigate("/memory")}
          >
            Memory
          </Button>
        </nav>
      </aside>
      <main className="p-8 grid gap-4 content-start">{props.children}</main>
    </div>
  );
}

export function ErrorBanner(props: { error: string | null }) {
  if (!props.error) return null;
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="bg-danger-light text-danger rounded-input p-3"
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
      className="bg-brand-light text-brand-dark rounded-input p-3"
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
