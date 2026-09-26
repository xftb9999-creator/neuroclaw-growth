/**
 * W1a close-out — independent, dist-level reproduction harness.
 *
 * Runs against the BUILT public API (the same surface QA used to reproduce
 * R-W1a), not against the test-only internals. Three claims:
 *
 *   1. the invariant that made the pre-fix path hard-fail is real and enforced
 *      (`sourceEventRefs` must be unique);
 *   2. after the fix, a stream containing two byte-identical events persists
 *      successfully, yields unique event ids, and appends exactly one row;
 *   3. `rebuildRunFromEvents(log)` equals the `runs` row field for field.
 *
 * Run: cd p0-growth-v1 && node tests/w1a2-repro.mjs
 */
import assert from "node:assert/strict";

import { closeDatabase, createInMemoryDb, runEvents } from "@neuroclaw/db";
import { replayCheckpointSchema, rebuildRunFromEvents } from "@neuroclaw/shared";
import { ControlPlaneService } from "../apps/control-plane/dist/index.js";

const base = {
  id: "checkpoint_probe",
  schemaVersion: "1.0",
  scope: { workspaceId: "ws_probe" },
  createdBy: "probe",
  createdAt: "2026-09-23T00:00:00Z",
  updatedAt: "2026-09-23T00:00:00Z",
  sourceRefs: ["probe:1"],
  runId: "run_probe",
  workItemId: "work_item_run_probe",
  attemptId: "attempt_probe",
  sequence: 1,
  workflowVersion: "1.0.0",
  stateHash: "0".repeat(64),
  status: "WRITABLE",
  metadata: {}
};

// [1] the invariant the pre-fix code violated
let invariantMessage = "";
try {
  replayCheckpointSchema.parse({ ...base, sourceEventRefs: ["evt_a", "evt_a"] });
} catch (error) {
  invariantMessage = error.issues?.[0]?.message ?? String(error);
}
assert.equal(invariantMessage, "sourceRefs must be unique");
console.log(`[1] duplicate sourceEventRefs rejected by the contract: "${invariantMessage}"`);

const db = await createInMemoryDb();
try {
  const service = await ControlPlaneService.create(undefined, db);
  const workspace = await service.createWorkspace({ name: "W1a probe", plan: "team" }, "dev");
  const run = await service.createRun({
    workspaceId: workspace.id,
    templateType: "content_acquisition",
    input: {
      businessSummary: "probe",
      targetCustomer: "SMB",
      preferredChannels: ["email"],
      contentGoal: "hooks"
    }
  });

  const rowsBefore = await db.select().from(runEvents);
  const before = rowsBefore.filter((row) => row.runId === run.id);
  const events = await service.listRunRuntimeEvents(run.id);

  // [2] two byte-identical events in one stream
  const probe = { type: "contract_validated", runId: run.id, details: "R-W1a duplicate probe" };
  const result = await service.persistRuntimeEventStream(run, [...events, probe, probe]);

  assert.equal(new Set(result.eventIds).size, result.eventIds.length, "event ids must be unique");
  assert.equal(result.eventIds.length, events.length + 1, "the duplicate must collapse to one event");

  const rowsAfter = (await db.select().from(runEvents)).filter((row) => row.runId === run.id);
  assert.equal(rowsAfter.length, before.length + 1, "exactly one row is appended");
  console.log(
    `[2] duplicate stream persisted: ids=${result.eventIds.length} unique=${new Set(result.eventIds).size} rows ${before.length} -> ${rowsAfter.length}`
  );

  const replay = await service.replayRunFromCheckpoint(run.id);
  assert.deepEqual(replay, await service.listRunRuntimeEvents(run.id));
  console.log(`[2b] replay after the duplicate stream is still consistent (${replay.length} events)`);

  // [3] parity. Compared under JSON semantics: `rowToRun` sets absent optional
  // columns to `undefined` keys, which JSON (the wire/storage representation)
  // drops — the only difference between the two objects.
  const persisted = await service.getRun(run.id);
  const history = await service.listRunEventHistory(run.id);
  const rebuilt = rebuildRunFromEvents(history);
  const asJson = (value) => JSON.parse(JSON.stringify(value));
  assert.deepEqual(asJson(rebuilt), asJson(persisted));
  assert.deepEqual(Object.keys(asJson(rebuilt)).sort(), Object.keys(asJson(persisted)).sort());
  console.log(
    `[3] parity OK: rebuildRunFromEvents(${history.length} events) === runs row (${Object.keys(asJson(persisted)).length} JSON fields)`
  );
} finally {
  await closeDatabase(db);
}
