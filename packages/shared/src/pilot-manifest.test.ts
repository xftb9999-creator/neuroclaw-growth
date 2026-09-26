import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  loadPilotProjectKeys,
  loadPilotProjectManifest,
  parsePilotProjectManifest,
  pilotProjectManifestPath
} from "./pilot-manifest.js";
import {
  pilotAdapterManifests,
  pilotPackManifests,
  pilotProjectKeys
} from "./pilot-fixtures.js";

/**
 * P-0 清单外置 — the pilot project list must be data, and the runtime path and
 * the test path must read the same source. The evidence is that the value the
 * runtime exports is byte-for-byte the value on disk, reached through the one
 * loader both paths share.
 */

const VALID_MANIFEST = {
  schemaVersion: "1.0",
  manifestVersion: "1.0.0",
  projectKeys: ["uaos", "hesn", "ex_protocol", "bitmind"]
};

describe("P-0: pilot project manifest", () => {
  it("loads the runtime list from the manifest file on disk", () => {
    const onDisk = JSON.parse(readFileSync(pilotProjectManifestPath(), "utf8")) as {
      projectKeys: string[];
    };

    expect(onDisk.projectKeys).toEqual([...pilotProjectKeys]);
    expect([...loadPilotProjectKeys()]).toEqual(onDisk.projectKeys);
    // Same loader, same manifest: the two paths cannot drift.
    expect(loadPilotProjectManifest().projectKeys).toEqual(onDisk.projectKeys);
  });

  it("derives the runtime pilot fixtures from the loaded list", () => {
    const expected = new Set<string>(pilotProjectKeys);

    expect(new Set(Object.keys(pilotPackManifests))).toEqual(expected);
    expect(new Set(Object.keys(pilotAdapterManifests))).toEqual(expected);
  });

  it("fails closed on a manifest that cannot be trusted", () => {
    // A key outside the closed domain.
    expect(() =>
      parsePilotProjectManifest({ ...VALID_MANIFEST, projectKeys: ["uaos", "unknown_project"] })
    ).toThrow();

    // A silently-empty list would shrink the fixture set without any signal.
    expect(() => parsePilotProjectManifest({ ...VALID_MANIFEST, projectKeys: [] })).toThrow();

    // Duplicates would double-count a project.
    expect(() =>
      parsePilotProjectManifest({ ...VALID_MANIFEST, projectKeys: ["uaos", "uaos"] })
    ).toThrow();

    // An unrecognised field means the reader and the file disagree.
    expect(() =>
      parsePilotProjectManifest({ ...VALID_MANIFEST, pilotProjects: ["uaos"] })
    ).toThrow();

    expect(() => parsePilotProjectManifest({ ...VALID_MANIFEST })).not.toThrow();
  });
});
