import { createHash } from "node:crypto";

import { intersects, satisfies, valid, validRange } from "semver";
import { z } from "zod";

/**
 * P-1 / D2 S1+S2: real semver evaluation for `compatibilityRange`
 * (B3 §D2.2 migration path, decision C-7 "compatibilityRange must be truly
 * evaluated").
 *
 * Before this module every version pin was a strict string equality and
 * `compatibilityRange` was never parsed — the "fake versioning" (假版本化)
 * this work package exists to remove. Three groups of primitives:
 *
 * - S1 · additive parseability gate: `assertSemverRange` / `semverRangeSchema`
 *   run at config/manifest parse sites; an unparseable range fails closed.
 *   The stored value stays the original string (contract stays additive).
 * - S2 · mode-switched pin comparison: `versionPinMatches` replaces the
 *   twelve strict `!==` version comparisons. Default mode `strict`
 *   reproduces today's equality byte-for-byte; `NEUROCLAW_VERSION_MODE=range`
 *   evaluates the actual version against the in-scope manifest
 *   `compatibilityRange`.
 * - 假版本化判据 3/4 (B3:125-129): `findPluginRangeConflicts` /
 *   `assertNoPluginRangeConflicts` fail-close on non-intersecting plugin
 *   requirement ranges; `buildPluginLock` is a pure, deterministically
 *   ordered projection whose fingerprint is recomputable on any machine.
 *
 * Deliberately out of scope here: full dependency-tree solving and lock-file
 * persistence (D2 S3 / stage P-3). Depth stays at the flat plugin layer.
 */

export type VersionMode = "strict" | "range";

function currentEnv(): Record<string, string | undefined> {
  // Browser bundles have no `process`; absence must stay the safe default.
  return typeof process !== "undefined" && process.env ? process.env : {};
}

/**
 * Resolve the version evaluation mode (D2 S2 switch).
 * Absent or unknown values resolve to `strict` — zero behaviour change is
 * the default, flipping to `range` is always explicit.
 */
export function getVersionMode(
  env: Readonly<Record<string, string | undefined>> = currentEnv()
): VersionMode {
  return env.NEUROCLAW_VERSION_MODE === "range" ? "range" : "strict";
}

/**
 * S1 · assert that `range` is a parseable semver range.
 * Returns the range unchanged; throws fail-closed otherwise. Empty or
 * whitespace-only input is rejected explicitly (the semver library treats
 * `""` as the permissive `*` range, which would silently accept garbage).
 */
export function assertSemverRange(range: string): string {
  if (range.trim().length === 0) {
    throw new Error("Invalid semver range: empty range is not allowed");
  }
  if (validRange(range) === null) {
    throw new Error(`Invalid semver range: ${JSON.stringify(range)}`);
  }
  return range;
}

/** Non-throwing companion of {@link assertSemverRange}. */
export function isValidSemverRange(range: string): boolean {
  try {
    assertSemverRange(range);
    return true;
  } catch {
    return false;
  }
}

/**
 * Zod string schema implementing the S1 gate at parse sites: any config or
 * manifest carrying an unparseable range fails validation (callers surface
 * that as 422 / thrown error — fail-closed, never a silent fallback).
 */
export const semverRangeSchema = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    try {
      assertSemverRange(value);
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "Invalid semver range"
      });
    }
  });

/**
 * Evaluate `version` against `range`. Fail-closed: any invalid input
 * (unparseable range, non-semver version) yields `false`, never `true`.
 */
export function versionSatisfiesRange(version: string, range: string): boolean {
  try {
    return satisfies(version, range);
  } catch {
    return false;
  }
}

/**
 * S2 · the mode-switched version pin comparison that replaces strict `!==`.
 *
 * - `strict` (default): `actual === expected` — exactly today's behaviour.
 * - `range`: when a manifest `compatibilityRange` is in scope, `actual` must
 *   satisfy it; without a range in scope the comparison stays strict (a
 *   loosened pin always requires an explicit range, never an implicit one).
 *
 * Fail-closed: unparseable range or non-semver `actual` in `range` mode is a
 * mismatch (`false`), so a broken range can never widen acceptance.
 */
export function versionPinMatches(
  actual: string,
  expected: string,
  compatibilityRange?: string
): boolean {
  if (getVersionMode() === "range" && compatibilityRange !== undefined) {
    return versionSatisfiesRange(actual, compatibilityRange);
  }
  return actual === expected;
}

export interface PluginRequirementSource {
  id: string;
  requires?: Readonly<Record<string, string>>;
}

export interface PluginRangeConflict {
  dependency: string;
  left: { id: string; range: string };
  right: { id: string; range: string };
}

/**
 * 假版本化判据 3 (B3:128): two plugins requiring non-intersecting ranges for
 * the same dependency. Returns conflicts in a machine-stable order (plain
 * code-unit sorts — no locale dependence), so the same inputs produce the
 * same report on any machine. An unparseable requirement range throws
 * fail-closed instead of being skipped.
 */
export function findPluginRangeConflicts(
  plugins: readonly PluginRequirementSource[]
): PluginRangeConflict[] {
  const byDependency = new Map<string, { id: string; range: string }[]>();
  const ordered = [...plugins].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const plugin of ordered) {
    const requires = plugin.requires ?? {};
    for (const dependency of Object.keys(requires).sort()) {
      const range = assertSemverRange(requires[dependency]!);
      const sources = byDependency.get(dependency) ?? [];
      sources.push({ id: plugin.id, range });
      byDependency.set(dependency, sources);
    }
  }

  const conflicts: PluginRangeConflict[] = [];
  for (const dependency of [...byDependency.keys()].sort()) {
    const sources = byDependency.get(dependency)!;
    for (let i = 0; i < sources.length; i += 1) {
      for (let j = i + 1; j < sources.length; j += 1) {
        const left = sources[i]!;
        const right = sources[j]!;
        if (!intersects(left.range, right.range)) {
          conflicts.push({ dependency, left, right });
        }
      }
    }
  }
  return conflicts;
}

/**
 * Fail-closed loader gate for 假版本化判据 3: throws when any pair of plugins
 * demands mutually unsatisfiable ranges for the same dependency.
 */
export function assertNoPluginRangeConflicts(
  plugins: readonly PluginRequirementSource[]
): void {
  const conflicts = findPluginRangeConflicts(plugins);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map(
        (conflict) =>
          `${conflict.dependency} (${conflict.left.id}@${conflict.left.range} vs ` +
          `${conflict.right.id}@${conflict.right.range})`
      )
      .join("; ");
    throw new Error(`Incompatible plugin requirement ranges: ${detail}`);
  }
}

export interface PluginLockEntry {
  id: string;
  version: string;
  /** Sorted by key so serialization does not depend on input order. */
  requires: Record<string, string>;
}

export interface PluginLock {
  lockVersion: "plugin-lock.v1";
  /** Sorted by id then version (code-unit order — locale independent). */
  plugins: PluginLockEntry[];
  /** SHA-256 of the canonical body (everything except this field). */
  fingerprint: string;
}

export type PluginLockInput = PluginRequirementSource & { version: string };

/**
 * 假版本化判据 4 (B3:129): project an already-resolved plugin set into a
 * lock document that any machine recomputes byte-identically. Pure function:
 * same set (in any input order) ⇒ same entries, same canonical JSON, same
 * fingerprint. Versions and requirement ranges are validated fail-closed
 * first; solving/depth-limit belongs to D2 S3 (stage P-3) and is not done
 * here.
 */
export function buildPluginLock(plugins: readonly PluginLockInput[]): PluginLock {
  const entries: PluginLockEntry[] = [...plugins]
    .map((plugin) => {
      if (valid(plugin.version) === null) {
        throw new Error(
          `Plugin ${plugin.id} has an invalid semver version: ${JSON.stringify(plugin.version)}`
        );
      }
      const requires: Record<string, string> = {};
      for (const key of Object.keys(plugin.requires ?? {}).sort()) {
        requires[key] = assertSemverRange(plugin.requires![key]!);
      }
      return { id: plugin.id, version: plugin.version, requires };
    })
    .sort((a, b) => {
      if (a.id !== b.id) return a.id < b.id ? -1 : 1;
      return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
    });

  const body = { lockVersion: "plugin-lock.v1" as const, plugins: entries };
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return { ...body, fingerprint };
}
