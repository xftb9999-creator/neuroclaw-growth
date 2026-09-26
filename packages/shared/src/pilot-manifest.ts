import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * P-0 清单外置（B3 C5 / 附 1「P-0 清单外置」）。
 *
 * Before this module the pilot project list was a compile-time constant
 * (`pilot-fixtures.ts:46`), so the only way to see the list was to read the
 * source. The list is now data: it lives in `manifests/pilot-projects.json`
 * and every consumer — the runtime fixtures that derive the pilot bundles and
 * the tests that assert on them — goes through `loadPilotProjectManifest()`.
 * There is exactly one loader, so the two paths cannot drift.
 *
 * Fail-closed: an unreadable file, malformed JSON, an empty list, a duplicate
 * key, or a key outside the closed `PilotProjectKey` domain all reject. A
 * silently-partial manifest would quietly shrink the pilot fixture set.
 */

const MANIFEST_FILE = "manifests/pilot-projects.json";

/**
 * `import.meta.url` resolves to `src/` under vitest/tsx and to `dist/` after
 * `tsc -b`. The first candidate covers both when the manifest sits next to the
 * compiled module; the second is the source-tree fallback for `dist/`.
 */
const MANIFEST_CANDIDATES = [`./${MANIFEST_FILE}`, `../src/${MANIFEST_FILE}`] as const;

export const pilotProjectKeySchema = z.enum(["uaos", "hesn", "ex_protocol", "bitmind"]);
export type PilotProjectKey = z.infer<typeof pilotProjectKeySchema>;

export const pilotProjectManifestSchema = z
  .object({
    schemaVersion: z.string().min(1),
    manifestVersion: z.string().min(1),
    description: z.string().optional(),
    projectKeys: z.array(pilotProjectKeySchema).min(1)
  })
  .strict()
  .refine(
    (manifest) => new Set(manifest.projectKeys).size === manifest.projectKeys.length,
    "projectKeys must not contain duplicates"
  );
export type PilotProjectManifest = z.infer<typeof pilotProjectManifestSchema>;

/** Parse and validate a manifest payload. Exported so fail-closed cases are testable. */
export function parsePilotProjectManifest(raw: unknown): PilotProjectManifest {
  return pilotProjectManifestSchema.parse(raw);
}

let cachedManifest: PilotProjectManifest | undefined;
let cachedManifestPath: string | undefined;

/**
 * Read the pilot project manifest from disk. Errors from every candidate are
 * collected and rethrown together so a failure names the paths it tried
 * instead of only the last one.
 */
export function loadPilotProjectManifest(): PilotProjectManifest {
  if (cachedManifest) return cachedManifest;

  const failures: string[] = [];
  for (const relative of MANIFEST_CANDIDATES) {
    const url = new URL(relative, import.meta.url);
    try {
      const parsed = parsePilotProjectManifest(JSON.parse(readFileSync(url, "utf8")));
      cachedManifest = parsed;
      cachedManifestPath = fileURLToPath(url);
      return parsed;
    } catch (error) {
      failures.push(`${fileURLToPath(url)}: ${(error as Error).message}`);
    }
  }

  throw new Error(
    `Unable to load the pilot project manifest (${MANIFEST_FILE}). Tried:\n${failures.join("\n")}`
  );
}

/** The pilot project keys, in manifest order. */
export function loadPilotProjectKeys(): readonly PilotProjectKey[] {
  return loadPilotProjectManifest().projectKeys;
}

/** Absolute path of the manifest that was actually loaded. */
export function pilotProjectManifestPath(): string {
  loadPilotProjectManifest();
  return cachedManifestPath!;
}
