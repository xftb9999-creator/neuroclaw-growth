// replay-gate (I-012, Liangyi closed loop): incident -> fixture -> replay.
//
// For every committed incident fixture this gate re-derives the run from its
// stored `run_events` log alone and compares that against the fixture's
// frozen expectations (input / step sequence / side-effect set / terminal
// state). It re-reads the log; it never re-executes side effects. Delivery
// semantics under test stay "at-least-once transport + idempotent keys +
// receiver deduplication = effectively-once evidence in the log".
//
// The verification itself is the pure-function slice exported by
// @neuroclaw/shared (`packages/shared/src/run-event-replay.ts`); this script
// is only the runner. It imports the compiled dist, so build it first:
//   npm run build            (or the lighter: npx tsc -b packages/shared)
//
// Usage:
//   node scripts/replay-gate.mjs [fixturesDir]
//     Default fixturesDir: apps/control-plane/src/__fixtures__/incidents
//     Point it at another directory to exercise the negative path (a
//     tampered copy must exit non-zero) without touching the fixtures.
//
// Exit codes: 0 = every fixture replays green + tamper self-check rejects;
//             1 = any read / parse / replay / self-check failure (fail-closed).

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const defaultFixturesDir = path.join(
  repoRoot,
  "apps",
  "control-plane",
  "src",
  "__fixtures__",
  "incidents"
);
const fixturesDir = path.resolve(process.argv[2] ?? defaultFixturesDir);

let shared;
try {
  shared = await import("@neuroclaw/shared");
} catch (error) {
  console.error(
    "[replay:gate] cannot import @neuroclaw/shared — build it first: npm run build (or: npx tsc -b packages/shared)"
  );
  console.error(`[replay:gate] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
const { incidentReplayFixtureSchema, verifyIncidentReplay } = shared;

let files;
try {
  files = readdirSync(fixturesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
} catch (error) {
  console.error(`[replay:gate] cannot read fixtures dir ${fixturesDir}`);
  console.error(`[replay:gate] ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
if (files.length === 0) {
  console.error(`[replay:gate] no *.json fixtures in ${fixturesDir}`);
  process.exit(1);
}

let failed = false;
let reference = null;

for (const file of files) {
  let fixture;
  try {
    fixture = incidentReplayFixtureSchema.parse(
      JSON.parse(readFileSync(path.join(fixturesDir, file), "utf8"))
    );
  } catch (error) {
    failed = true;
    console.error(`✗ ${file}: rejected before replay (read/parse/schema)`);
    console.error(`  ${error instanceof Error ? error.message : error}`);
    continue;
  }
  if (reference === null) reference = { file, fixture };

  const report = verifyIncidentReplay(fixture);
  if (report.ok) {
    console.log(
      `✓ ${file}: replays green — run ${fixture.source.runId}, ` +
        `${fixture.source.eventCount} events, ${fixture.expected.steps.length} steps, ` +
        `${fixture.expected.sideEffects.length} side effects`
    );
  } else {
    failed = true;
    console.error(`✗ ${file}: replay mismatch`);
    for (const mismatch of report.mismatches) console.error(`  - ${mismatch}`);
  }
}

// Tamper self-check: the green results above only mean something if this
// verifier still rejects a corrupted expectation. A gate that passes
// everything fails here instead.
if (reference !== null) {
  const tampered = structuredClone(reference.fixture);
  tampered.expected.steps = [...tampered.expected.steps, "tamper-injected-step"];
  const report = verifyIncidentReplay(tampered);
  if (report.ok) {
    failed = true;
    console.error(
      `✗ self-check: verifier accepted a tampered copy of ${reference.file} — gate is not fail-closed`
    );
  } else {
    console.log(
      `✓ self-check: tampered copy of ${reference.file} rejected (${report.mismatches.length} mismatch(es))`
    );
  }
}

if (failed) {
  console.error(`[replay:gate] FAILED — ${files.length} fixture(s) scanned in ${fixturesDir}`);
  process.exit(1);
}
console.log(
  `[replay:gate] OK — ${files.length} fixture(s) replayed and verified (fail-closed; no side effects were re-executed)`
);
