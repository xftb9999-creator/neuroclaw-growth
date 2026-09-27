#!/usr/bin/env node
/**
 * I-035 · RG-2b：role-grid 可执行性报告（复用 shared D5 matcher，零第二套匹配方言）。
 *
 * 规则全部来自 `packages/agent-workforce-contract/src/executability-bridge.ts`
 * （映射 + tier）与 `packages/shared/src/capability-matching.ts`（D5 判定），
 * 本脚本不携带自有规则。
 *
 * 判定语义（`.artifacts/i035-role-grid/aw1/CAPABILITIES.md:137`）：
 * - MUST=MISSING → tier C，--check 退出码非零；
 * - PARTIAL → tier B，列出前置条件；
 * - NO_BINDINGS（skills/tools 全缺省）不构成 tier 判定，不阻塞。
 *
 * Usage (from p0-growth-v1):
 *   node scripts/executability-report.mjs [--check] <profile.json> [more.json ...]
 *
 * Exit codes:
 *   0 = 报告生成完成（--check 下无 tier C）
 *   1 = --check 下存在 tier C，或任一 profile 读取/解析失败（fail-closed）
 *   2 = 用法/工具错误（无参数、tsx/桥接加载失败）
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const args = process.argv.slice(2);
const checkMode = args.includes("--check");
const profilePaths = args.filter((arg) => arg !== "--check");

if (profilePaths.length === 0) {
  console.error(
    "Usage: node scripts/executability-report.mjs [--check] <profile.json> [more.json ...]"
  );
  process.exit(2);
}

async function loadBridge() {
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport(
      "../packages/agent-workforce-contract/src/executability-bridge.ts",
      import.meta.url
    );
  } catch (error) {
    console.error(
      "[executability-report] cannot load the RG-2b bridge. " +
        "Run `npm install` in p0-growth-v1 (tsx is required to load TypeScript sources). " +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
}

function printReport(result) {
  console.log(
    `[executability-report] role=${result.role} tier=${result.verdict} blocking=${result.blocking}`
  );
  if (result.report === null) {
    console.log("  no capability bindings (skills/tools absent): nothing to match, no tier verdict");
    return;
  }

  for (const segment of result.report.segments) {
    console.log(`  segment ${segment.segment}: ${segment.status}`);
  }
  for (const item of result.report.items) {
    console.log(
      `  - [${item.weight}] ${item.capabilityRef} -> ${item.status} (evidence=${item.evidenceLevel})`
    );
    console.log(`      reason: ${item.reason}`);
    for (const precondition of item.preconditions) {
      console.log(`      precondition: ${precondition}`);
    }
    if (item.unlockHint) {
      console.log(`      unlockHint: ${item.unlockHint}`);
    }
  }
  console.log(
    `  reportVersion=${result.report.reportVersion} inputFingerprint=${result.report.inputFingerprint}`
  );
}

const bridge = await loadBridge();
let failures = 0;
let reported = 0;

for (const profilePath of profilePaths) {
  const absolutePath = path.resolve(process.cwd(), profilePath);
  try {
    const profile = JSON.parse(await readFile(absolutePath, "utf8"));
    const result = bridge.checkAgentProfileExecutability(profile);
    reported += 1;
    printReport(result);
    if (checkMode && result.blocking) {
      failures += 1;
      console.error(
        `[executability-report] BLOCKED ${profilePath}: tier C (MUST=MISSING / BLOCKED segment)`
      );
    }
  } catch (error) {
    failures += 1;
    console.error(`[executability-report] FAIL ${profilePath}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(
    `[executability-report] ${failures}/${profilePaths.length} profile(s) failed` +
      (checkMode ? " (fail-closed --check)." : " (parse/read errors; fail-closed).")
  );
  process.exit(1);
}

console.log(
  `[executability-report] ${reported}/${profilePaths.length} profile(s) ok` +
    (checkMode ? " (--check: no tier C)." : ".")
);
