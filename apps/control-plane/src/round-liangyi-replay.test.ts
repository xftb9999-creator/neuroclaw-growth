import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";

import { closeDatabase, createInMemoryDb, runEvents, type Database } from "@neuroclaw/db";
import {
  exportRunEventReplay,
  incidentReplayFixtureSchema,
  verifyIncidentReplay,
  type IncidentReplayFixture
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";

/**
 * 梁一闭环 local slice — 「事故 → 夹具 → 重放」三件套 (B1 §6, `B1:206-214`).
 *
 * The `replay-gate` CI job itself is **unauthorized** (stop-line: a CI push is
 * outside the grant), so this file is the local half of the loop:
 *
 *  1. committed incident fixtures under `__fixtures__/incidents/` all replay
 *     green through the shared pure functions (no DB, no control plane);
 *  2. the exporter really is the `SELECT * ... ORDER BY sequence` projection —
 *     a real W1 run row is exported, replayed, and checked field-for-field
 *     against the durable `runs` row.
 *
 * Event payloads for delivery (`transport / recipientHash / contentDigest /
 * deliveryOutcome`) belong to W2's outbox and are absent from W1 logs, so
 * every fixture here expects an empty side-effect set.
 */

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setup(): Promise<{ db: Database; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  return { db, service: await ControlPlaneService.create(undefined, db) };
}

const FIXTURE_DIR = new URL("./__fixtures__/incidents/", import.meta.url);

function committedFixtures(): Array<{ file: string; fixture: IncidentReplayFixture }> {
  const files = readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort();
  return files.map((file) => ({
    file,
    fixture: incidentReplayFixtureSchema.parse(
      JSON.parse(readFileSync(new URL(file, FIXTURE_DIR), "utf8")) as unknown
    )
  }));
}

async function rowsFor(db: Database, runId: string) {
  const rows = await db.select().from(runEvents).where(eq(runEvents.runId, runId));
  return rows.sort((a, b) => a.sequence - b.sequence);
}

describe("梁一: committed incident fixtures replay green", () => {
  it("replays every fixture in __fixtures__/incidents/", () => {
    const fixtures = committedFixtures();
    expect(fixtures.length).toBeGreaterThan(0);

    for (const { file, fixture } of fixtures) {
      const report = verifyIncidentReplay(fixture);
      expect(report.mismatches, `${file} must replay green`).toEqual([]);
      expect(report.ok, `${file} must replay green`).toBe(true);
      expect(fixture.source.table, file).toBe("run_events");
      expect(fixture.source.eventCount, file).toBe(fixture.events.length);
    }

    // The slice ships a genuine failure, not only happy-path goldens.
    expect(
      fixtures.some(({ fixture }) => fixture.expected.run.status === "failed"),
      "at least one committed fixture must be a failed run"
    ).toBe(true);
  });

  it("rejects a tampered copy of a committed fixture", () => {
    const [first] = committedFixtures();
    expect(first).toBeDefined();

    const tampered: IncidentReplayFixture = {
      ...first!.fixture,
      expected: {
        ...first!.fixture.expected,
        run: { ...first!.fixture.expected.run, status: "completed" }
      }
    };
    // completed is a terminal state only reachable if the log says so — for a
    // failed-run fixture the replay must not be able to produce it.
    if (first!.fixture.expected.run.status !== "completed") {
      const report = verifyIncidentReplay(tampered);
      expect(report.ok).toBe(false);
      expect(report.mismatches.join("\n")).toMatch(/run:/);
    }
  });
});

describe("梁一: exporter over a real W1 log", () => {
  it("exports a preflight-denied incident and replays it green", async () => {
    const { db, service } = await setup();
    const workspace = await service.createWorkspace(
      { name: "Liangyi Incident Lab", plan: "team" },
      "dev"
    );
    // `forbidden` is the blocked keyword `evaluateRunPolicy` denies on, so the
    // run fails in preflight — a real, network-free W1 failure.
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "content_acquisition",
      input: {
        businessSummary: "forbidden keyword blocked by preflight policy",
        targetCustomer: "SMB operators",
        preferredChannels: ["email"],
        contentGoal: "hooks"
      }
    });
    expect(run.status).toBe("failed");
    expect(run.failureReason).toBe("Run denied by preflight policy");

    const rows = await rowsFor(db, run.id);
    expect(rows.map((row) => row.eventType)).toEqual(["growth.run.run_failed"]);

    const fixture = exportRunEventReplay(rows, {
      name: "incident-preflight-deny",
      description: "Preflight policy denied the run before any step executed."
    });

    expect(fixture.source.runId).toBe(run.id);
    expect(fixture.expected.steps).toEqual([]);
    expect(fixture.expected.sideEffects).toEqual([]);
    expect(fixture.expected.run.failureReason).toBe("Run denied by preflight policy");

    const report = verifyIncidentReplay(fixture);
    expect(report).toEqual({ ok: true, mismatches: [] });

    // The log alone must reproduce the durable row, field for field.
    expect(fixture.expected.run).toEqual(await service.getRun(run.id));
  });

  it("exports an approval-rejected incident (multi-event) and replays it green", async () => {
    const { db, service } = await setup();
    const workspace = await service.createWorkspace(
      { name: "Liangyi Rejection Lab", plan: "growth" },
      "dev"
    );
    const run = await service.createRun({
      workspaceId: workspace.id,
      templateType: "private_conversion",
      input: {
        businessSummary: "Liangyi gated send",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "Concierge conversion path",
        recipientEmail: "ops@example.com"
      }
    });
    expect(run.status).toBe("waiting_approval");

    const rejected = await service.updateApproval(run.id, {
      approved: false,
      reviewerId: "op_liangyi",
      note: "Incident review: send blocked"
    });
    expect(rejected.status).toBe("cancelled");

    const rows = await rowsFor(db, run.id);
    expect(rows.length).toBeGreaterThan(1);

    const fixture = exportRunEventReplay(rows, {
      name: "incident-approval-rejected",
      description: "Approval rejected: the gated notification never executed."
    });

    expect(fixture.expected.steps).toContain("preview-send");
    expect(fixture.expected.run.status).toBe("cancelled");
    expect(fixture.expected.run.approvalStatus).toBe("rejected");
    // No delivery: W1 payloads carry no W2 side-effect fields, and the gated
    // step never ran — the empty set is the honest expectation.
    expect(fixture.expected.sideEffects).toEqual([]);
    expect(verifyIncidentReplay(fixture)).toEqual({ ok: true, mismatches: [] });
    expect(fixture.expected.run).toEqual(await service.getRun(run.id));
  });
});
