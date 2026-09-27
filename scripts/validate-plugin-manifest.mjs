#!/usr/bin/env node
/**
 * P1-3 · 插件清单校验 CLI。
 *
 * 校验内核 = @neuroclaw/plugin-contract 的装载前门（本脚本零自研规则）：
 *   1. schema 严格解析（.strict()；hostApiRange 必填、非法 semver 即拒）；
 *   2. hostApiRange 与 --host-api 求交（不兼容即拒，装载前 fail-closed）；
 *   3. 权限越权静态门（simulationOnly 清单不得声明 writeScopes / sideEffects）；
 *   4. 集合级：重复 pluginKey / requires 依赖环 / 依赖缺失与版本不满足 / conflicts 命中。
 *
 * Usage (from p0-growth-v1):
 *   node scripts/validate-plugin-manifest.mjs [--host-api <semver>] <manifest.json|dir> [...]
 *
 * Directories are scanned for *.json (one level, sorted). All manifests in one
 * invocation are validated as one set: requires must be satisfied inside it.
 *
 * Exit codes: 0 = all valid; 1 = at least one rejected; 2 = usage/tooling error.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Default host API version. Until P-3 defines the host × plugin matrix this
 * mirrors the current integration contract version; pass --host-api explicitly
 * whenever the host version is known.
 */
const DEFAULT_HOST_API = "1.0.0";

async function loadKernel() {
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport("../packages/plugin-contract/src/index.ts", import.meta.url);
  } catch (error) {
    console.error(
      "[validate-plugin-manifest] cannot load @neuroclaw/plugin-contract. " +
        "Run `npm install` in p0-growth-v1 (tsx is required to load TypeScript sources). " +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
}

function usage() {
  console.log(
    [
      "Usage: node scripts/validate-plugin-manifest.mjs [--host-api <semver>] <manifest.json|dir> [...]",
      "",
      "  --host-api <semver>  Host API version the manifests must be compatible with",
      `                       (default ${DEFAULT_HOST_API}; pass explicitly for scans).`,
      "  --help               Show this help.",
      "",
      "Exit codes: 0 = all valid; 1 = at least one rejected; 2 = usage/tooling error."
    ].join("\n")
  );
}

function parseArgs(argv) {
  const result = { hostApiVersion: DEFAULT_HOST_API, paths: [], error: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--host-api") {
      const value = argv[index + 1];
      if (!value) return { ...result, error: "--host-api requires a value" };
      result.hostApiVersion = value;
      index += 1;
    } else if (arg.startsWith("--host-api=")) {
      result.hostApiVersion = arg.slice("--host-api=".length);
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg.startsWith("-")) {
      return { ...result, error: `unknown option: ${arg}` };
    } else {
      result.paths.push(arg);
    }
  }
  return result;
}

async function collectManifestFiles(targets) {
  const files = [];
  for (const target of targets) {
    const absolute = path.resolve(process.cwd(), target);
    let info;
    try {
      info = await stat(absolute);
    } catch {
      return { error: `path not found: ${target}` };
    }
    if (info.isDirectory()) {
      const entries = (await readdir(absolute)).filter((entry) => entry.endsWith(".json")).sort();
      if (entries.length === 0) return { error: `no *.json manifest files in directory: ${target}` };
      for (const entry of entries) files.push(path.join(absolute, entry));
    } else {
      files.push(absolute);
    }
  }
  return { files: [...new Set(files)].sort() };
}

function displayPath(file) {
  return path.relative(process.cwd(), file) || file;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (args.error) {
  console.error(`[validate-plugin-manifest] ${args.error}`);
  usage();
  process.exit(2);
}
if (args.paths.length === 0) {
  usage();
  process.exit(2);
}

const kernel = await loadKernel();
const collected = await collectManifestFiles(args.paths);
if (collected.error) {
  console.error(`[validate-plugin-manifest] ${collected.error}`);
  process.exit(2);
}

console.log(
  `[validate-plugin-manifest] host API version: ${args.hostApiVersion} ` +
    `(override with --host-api; P-3 will source the host matrix)`
);

const readable = [];
let failures = 0;
for (const file of collected.files) {
  try {
    readable.push({ file, input: JSON.parse(await readFile(file, "utf8")) });
  } catch (error) {
    failures += 1;
    console.error(
      `[validate-plugin-manifest] FAIL ${displayPath(file)}: MANIFEST_UNREADABLE — ` +
        `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
if (readable.length === 0) {
  console.error("[validate-plugin-manifest] no readable manifest files");
  process.exit(1);
}

const report = kernel.verifyPluginManifestSet(
  readable.map((entry) => entry.input),
  { hostApiVersion: args.hostApiVersion }
);

const indexesByKey = new Map();
readable.forEach((entry, index) => {
  const pluginKey = entry.input && typeof entry.input.pluginKey === "string" ? entry.input.pluginKey : null;
  if (pluginKey) {
    const indexes = indexesByKey.get(pluginKey) ?? [];
    indexes.push(index);
    indexesByKey.set(pluginKey, indexes);
  }
});

const failedIndexes = new Set();
for (const finding of report.findings) {
  failures += 1;
  const detailIndex = typeof finding.detail?.index === "number" ? finding.detail.index : undefined;
  if (detailIndex !== undefined) failedIndexes.add(detailIndex);
  if (finding.pluginKey) {
    for (const index of indexesByKey.get(finding.pluginKey) ?? []) failedIndexes.add(index);
  }
  const cycle = finding.detail?.cycle;
  if (Array.isArray(cycle)) {
    for (const key of cycle) {
      for (const index of indexesByKey.get(key) ?? []) failedIndexes.add(index);
    }
  }
  const location =
    detailIndex !== undefined ? displayPath(readable[detailIndex]?.file ?? "<unknown>") : "(set)";
  console.error(
    `[validate-plugin-manifest] FAIL ${location}: ${finding.code} — ${finding.message}`
  );
}

let okCount = 0;
readable.forEach((entry, index) => {
  if (failedIndexes.has(index)) return;
  const input = entry.input;
  if (input === null || typeof input !== "object") return;
  okCount += 1;
  console.log(
    `[validate-plugin-manifest] OK ${displayPath(entry.file)}: ` +
      `${input.pluginKey}@${input.pluginVersion} (hostApiRange ${input.hostApiRange})`
  );
});

console.log(
  `[validate-plugin-manifest] ${readable.length} manifest(s): ${okCount} ok, ` +
    `${readable.length - okCount} rejected; ${report.findings.length} finding(s), ` +
    `${failures - report.findings.length} unreadable`
);

process.exit(failures > 0 ? 1 : 0);
