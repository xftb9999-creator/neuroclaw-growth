// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import {
  clearRunDraft,
  clearWorkspaceId,
  navigate,
  parseRoute,
  readRunDraft,
  readWorkspaceId,
  writeRunDraft,
  writeWorkspaceId
} from "./router.js";

describe("parseRoute", () => {
  it("maps every static route", () => {
    expect(parseRoute("/onboarding").name).toBe("onboarding");
    expect(parseRoute("/").name).toBe("home");
    expect(parseRoute("/home").name).toBe("home");
    expect(parseRoute("/templates").name).toBe("templates");
    expect(parseRoute("/profile").name).toBe("profile");
    expect(parseRoute("/launch").name).toBe("launch");
    expect(parseRoute("/agents").name).toBe("agents");
    expect(parseRoute("/agents/new").name).toBe("agent-new");
    expect(parseRoute("/workflows").name).toBe("workflows");
    expect(parseRoute("/library").name).toBe("library");
    expect(parseRoute("/knowledge").name).toBe("knowledge");
    expect(parseRoute("/team").name).toBe("team");
    expect(parseRoute("/inbox").name).toBe("inbox");
    expect(parseRoute("/schedule").name).toBe("schedule");
    expect(parseRoute("/analytics").name).toBe("analytics");
    expect(parseRoute("/billing").name).toBe("billing");
    expect(parseRoute("/history").name).toBe("history");
    expect(parseRoute("/memory").name).toBe("memory");
  });

  it("extracts dynamic params", () => {
    const setup = parseRoute("/runs/new/content_acquisition");
    expect(setup).toEqual({ name: "run-setup", templateType: "content_acquisition" });

    const result = parseRoute("/runs/run_abc/result");
    expect(result).toEqual({ name: "result", runId: "run_abc" });

    const status = parseRoute("/runs/run_abc");
    expect(status).toEqual({ name: "run-status", runId: "run_abc" });

    const detail = parseRoute("/team/team_1");
    expect(detail).toEqual({ name: "team-detail", teamId: "team_1" });

    const results = parseRoute("/team/team_1/results");
    expect(results).toEqual({ name: "team-results", teamId: "team_1" });
  });

  it("falls back to onboarding for unknown paths", () => {
    expect(parseRoute("/definitely/not/a/route")).toEqual({ name: "onboarding" });
  });
});

describe("workspace + draft storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips workspace id", () => {
    expect(readWorkspaceId()).toBeNull();
    writeWorkspaceId("ws_123");
    expect(readWorkspaceId()).toBe("ws_123");
    clearWorkspaceId();
    expect(readWorkspaceId()).toBeNull();
  });

  it("readRunDraft only matches the requested template type", () => {
    const payload = {
      templateType: "content_acquisition" as const,
      input: { businessSummary: "x" },
      sourceRunId: "run_1"
    };
    writeRunDraft(payload);

    expect(readRunDraft("content_acquisition")).toMatchObject(payload);
    expect(readRunDraft("weekly_review")).toBeNull();

    window.localStorage.setItem("neuroclaw.runDraft", "{not-json");
    expect(readRunDraft("content_acquisition")).toBeNull();

    clearRunDraft();
    expect(readRunDraft("content_acquisition")).toBeNull();
  });
});

describe("navigate", () => {
  it("pushes history state and dispatches popstate", async () => {
    let popped = 0;
    const handler = () => { popped += 1; };
    window.addEventListener("popstate", handler);
    const before = popped;

    navigate("/history");
    // Allow any queued listeners (from unrelated modules) to flush first.
    await Promise.resolve();

    expect(popped).toBe(before + 1);
    expect(window.location.pathname).toBe("/history");
    window.removeEventListener("popstate", handler);
  });
});
