// Verify the secret-free release manifest and every referenced web asset.
// This is intentionally independent from the writer so a malformed manifest
// cannot make the release gate pass merely because it was generated locally.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "apps/web/dist");
const manifestPath = path.join(distDir, "release-manifest.json");

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest.schemaVersion !== 1 ||
  manifest.package !== "neuroclaw-growth-p0" ||
  typeof manifest.packageVersion !== "string" ||
  typeof manifest.lockfileSha256 !== "string" ||
  !Array.isArray(manifest.assets) ||
  typeof manifest.buildId !== "string"
) {
  throw new Error("release manifest shape is invalid");
}

const actualLockfileSha256 = await sha256File(path.join(repoRoot, "package-lock.json"));
if (actualLockfileSha256 !== manifest.lockfileSha256) {
  throw new Error("release manifest lockfile hash does not match package-lock.json");
}

const payload = {
  schemaVersion: manifest.schemaVersion,
  package: manifest.package,
  packageVersion: manifest.packageVersion,
  lockfileSha256: manifest.lockfileSha256,
  assets: manifest.assets
};
const expectedBuildId = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
if (expectedBuildId !== manifest.buildId) {
  throw new Error("release manifest buildId does not match its payload");
}

for (const asset of manifest.assets) {
  if (
    !asset ||
    typeof asset.path !== "string" ||
    !Number.isInteger(asset.bytes) ||
    typeof asset.sha256 !== "string"
  ) {
    throw new Error("release manifest contains an invalid asset entry");
  }
  const assetPath = path.resolve(distDir, asset.path);
  if (assetPath !== distDir && !assetPath.startsWith(`${distDir}${path.sep}`)) {
    throw new Error(`release manifest asset escapes dist: ${asset.path}`);
  }
  const details = await stat(assetPath);
  if (!details.isFile() || details.size !== asset.bytes) {
    throw new Error(`release manifest size mismatch: ${asset.path}`);
  }
  if ((await sha256File(assetPath)) !== asset.sha256) {
    throw new Error(`release manifest hash mismatch: ${asset.path}`);
  }
}

console.log(
  `[release-manifest] verified buildId=${manifest.buildId}, assets=${manifest.assets.length}`
);
