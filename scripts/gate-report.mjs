// Gate R1 baseline reader (Round M, deliverable 55 §2).
// Reads north-star metrics from a running control-plane and prints a
// Markdown block ready to paste into deliverables/55-gate-r1-exit-review.md §3.
//
// Env:
//   NEUROCLAW_GATE_BASE_URL  default http://localhost:8787
//   NEUROCLAW_GATE_API_KEY   admin API key (required for global view)
//   NEUROCLAW_GATE_DAYS      window, default 30
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Minimal .env loader (no deps): same directory as repo root .env
async function loadDotEnv() {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(path.resolve(__dirname, "../.env"), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      if (!(key in process.env)) process.env[key] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // no .env — rely on real env vars
  }
}

const baseUrl = (process.env.NEUROCLAW_GATE_BASE_URL ?? "http://localhost:8787").replace(/\/$/, "");
const apiKey = process.env.NEUROCLAW_GATE_API_KEY;
const days = Number(process.env.NEUROCLAW_GATE_DAYS ?? 30);

if (!apiKey) {
  console.error("[gate:r1] NEUROCLAW_GATE_API_KEY is required (global view is admin-only).");
  process.exit(1);
}

let northstar;
try {
  const res = await fetch(`${baseUrl}/api/analytics/northstar?days=${days}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  northstar = await res.json();
} catch (error) {
  console.error(`[gate:r1] failed to read ${baseUrl}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

const sample = northstar.workspacesCreatedInWindow ?? 0;
const sufficient = sample >= 30;
const rate = (value) => (value === null || value === undefined ? "null (insufficient-sample)" : `${value}%`);

console.log(`### Day7 基线快照（${new Date().toISOString().slice(0, 10)}，窗口 ${northstar.windowDays} 天）`);
console.log();
console.log(`- workspacesCreatedInWindow: **${sample}** ${sufficient ? "✓" : "⚠ insufficient-sample (<30)"}`);
console.log(`- activationRate: **${rate(northstar.activationRate)}**`);
console.log(`- day7SuccessRate: **${rate(northstar.day7SuccessRate)}**`);
const totals = Object.entries(northstar.totals ?? {}).sort((a, b) => b[1] - a[1]);
if (totals.length > 0) {
  console.log(`- event totals: ${totals.map(([type, count]) => `\`${type}\`×${count}`).join(", ")}`);
}
