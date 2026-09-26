// CI gate (Round J, audit P0-D1): the built web bundle must never contain
// server-side secret references such as `process.env.NEUROCLAW_API_KEY`.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const distDir = path.resolve("apps/web/dist");
const forbidden = [/process\.env\.NEUROCLAW_API_KEY/, /process\.env\.\w+/];

async function collectJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsFiles(fullPath)));
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

let files;
try {
  files = await collectJsFiles(distDir);
} catch {
  console.error(`[assert-web-bundle] dist not found at ${distDir}. Run the web build first.`);
  process.exit(1);
}

if (files.length === 0) {
  console.error("[assert-web-bundle] no JS assets found in dist — build output missing?");
  process.exit(1);
}

const violations = [];
for (const file of files) {
  const content = await readFile(file, "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(content)) {
      violations.push(`${path.relative(process.cwd(), file)} matches ${pattern}`);
    }
  }
}

if (violations.length > 0) {
  console.error("[assert-web-bundle] FAILED — browser bundle contains server-only references:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}

console.log(`[assert-web-bundle] OK — ${files.length} asset(s) clean of process.env references.`);
