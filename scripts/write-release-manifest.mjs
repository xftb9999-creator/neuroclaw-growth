// Produce a traceable, secret-free manifest for the user-facing build.
// The manifest fingerprints the lockfile and every web asset except itself.
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "apps/web/dist");
const manifestPath = path.join(distDir, "release-manifest.json");

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function collectFiles(dir, prefix = "") {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const relativePath = path.join(prefix, entry.name);
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath, relativePath)));
    } else if (entry.isFile() && entry.name !== "release-manifest.json") {
      files.push({ path: relativePath.split(path.sep).join("/"), fullPath });
    }
  }
  return files;
}

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const files = (await collectFiles(distDir)).sort((a, b) => a.path.localeCompare(b.path));
const assets = [];
for (const file of files) {
  const details = await stat(file.fullPath);
  assets.push({
    path: file.path,
    bytes: details.size,
    sha256: await sha256File(file.fullPath)
  });
}

const payload = {
  schemaVersion: 1,
  package: "neuroclaw-growth-p0",
  packageVersion: packageJson.version,
  lockfileSha256: await sha256File(path.join(repoRoot, "package-lock.json")),
  assets
};
const buildId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");

await writeFile(
  manifestPath,
  `${JSON.stringify({ ...payload, buildId }, null, 2)}\n`,
  "utf8"
);

console.log(
  `[release-manifest] wrote ${path.relative(repoRoot, manifestPath)} ` +
  `(buildId=${buildId}, assets=${assets.length})`
);
