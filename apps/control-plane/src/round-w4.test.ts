import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { closeDatabase, createInMemoryDb, type Database } from "@neuroclaw/db";
import { buildSimulationProjectIntegration } from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";
import { createApp, type App } from "./app.js";

/**
 * W4 directed test — the 0008 registry HTTP surface (design B1 §4: eight routes
 * under /api/registry). Pinned here, per the E3 acceptance list:
 *
 *   ① duplicate Pack identity (`POST /api/registry/packs`) → 409 immutable conflict
 *   ② `POST /api/registry/adapters` with `simulationOnly: false` → 422 (fail-closed)
 *   ③ `POST /api/registry/projects/simulate` persists Pack AND Adapter in one flow;
 *      the adapter registry entry reverse-resolves to the same packId@version
 *   ④ repeated write/read safety: reads are deterministic, exactly one row per
 *      identity (the in-process mirror of the seed script's check-then-insert
 *      idempotency; the script's own two-run parity is verified separately)
 *   ⑤ registry writes are admin-only: viewer / operator → 403
 *   ⑥ injected DB read failure → 503 REGISTRY_SOURCE_UNAVAILABLE; the registry
 *      never silently falls back to fixtures — even though fixtures exist
 */

const originalApiKeys = process.env.NEUROCLAW_API_KEYS;
const originalRegistrySource = process.env.NEUROCLAW_REGISTRY_SOURCE;

beforeAll(() => {
  process.env.NEUROCLAW_API_KEYS =
    "w4-admin-key:admin_w4:admin,w4-operator-key:operator_w4:operator,w4-viewer-key:viewer_w4:viewer";
  delete process.env.NEUROCLAW_REGISTRY_SOURCE; // exercise the default dual read
});

afterAll(() => {
  if (originalApiKeys === undefined) {
    delete process.env.NEUROCLAW_API_KEYS;
  } else {
    process.env.NEUROCLAW_API_KEYS = originalApiKeys;
  }
  if (originalRegistrySource === undefined) {
    delete process.env.NEUROCLAW_REGISTRY_SOURCE;
  } else {
    process.env.NEUROCLAW_REGISTRY_SOURCE = originalRegistrySource;
  }
});

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setupApp(): Promise<{ app: App; service: ControlPlaneService }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db);
  return { app: createApp(service), service };
}

const ADMIN_HEADERS = { Authorization: "Bearer w4-admin-key" };
const OPERATOR_HEADERS = { Authorization: "Bearer w4-operator-key" };
const VIEWER_HEADERS = { Authorization: "Bearer w4-viewer-key" };

const CONFIG = {
  projectKey: "w4_registry",
  projectTypeKey: "engineering_os",
  packId: "pack_w4_registry",
  adapterId: "adapter_w4_registry",
  sourceSystem: "W4_SIMULATION"
};

const BUNDLE = buildSimulationProjectIntegration(
  CONFIG as Parameters<typeof buildSimulationProjectIntegration>[0]
);

const PACK_VERSION = BUNDLE.pack.version;
const PACK_WRITE_BODY = {
  pack: BUNDLE.pack,
  options: {
    project: BUNDLE.project,
    workflows: [BUNDLE.workflow],
    adapters: [BUNDLE.adapter]
  }
};

function postJson(app: App, path: string, body: unknown, headers = ADMIN_HEADERS) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function packRows(service: ControlPlaneService, packId: string, version: string) {
  return service
    .listProjectPackRegistryEntries()
    .then((entries) => entries.filter((entry) => entry.packId === packId && entry.version === version));
}

describe("W4 ③: /api/registry/projects/simulate dual persist + reverse binding", () => {
  it("persists pack and adapter in one flow; the adapter entry binds to the same packId@version", async () => {
    const { app, service } = await setupApp();
    const res = await postJson(app, "/api/registry/projects/simulate", CONFIG);
    expect(res.status).toBe(201);

    const body = (await res.json()) as {
      contractVersion: string;
      projectKey: string;
      packId: string;
      packVersion: string;
      adapterId: string;
      adapterVersion: string;
    };
    expect(body.projectKey).toBe(CONFIG.projectKey);
    expect(body.packId).toBe(CONFIG.packId);

    // Pack is visible through the read surface as a DB entry.
    const packRes = await app.request(`/api/registry/packs/${body.packId}/${body.packVersion}`, {
      headers: ADMIN_HEADERS
    });
    expect(packRes.status).toBe(200);
    const packBody = (await packRes.json()) as { pack: { source: string; projectId?: string } };
    expect(packBody.pack.source).toBe("db");
    expect(packBody.pack.projectId).toBe(BUNDLE.project.id);

    // Adapter is visible through the read surface as a DB entry…
    const adapterRes = await app.request("/api/registry/adapters", { headers: ADMIN_HEADERS });
    expect(adapterRes.status).toBe(200);
    const adapterBody = (await adapterRes.json()) as {
      items: Array<{ adapterId: string; version: string; source: string }>;
    };
    const visible = adapterBody.items.find((item) => item.adapterId === body.adapterId);
    expect(visible).toBeDefined();
    expect(visible!.source).toBe("db");
    expect(visible!.version).toBe(body.adapterVersion);

    // …and the registry entry reverse-resolves to the exact same pack identity.
    const entry = await service.getAdapterRegistryEntry(body.adapterId, body.adapterVersion);
    expect(entry).toBeDefined();
    expect(entry!.packId).toBe(body.packId);
    expect(entry!.packVersion).toBe(body.packVersion);
  });
});

describe("W4 ①: immutable Pack identity", () => {
  it("rejects a second write of the same packId@version with 409 REGISTRY_CONFLICT", async () => {
    const { app, service } = await setupApp();
    const first = await postJson(app, "/api/registry/packs", PACK_WRITE_BODY);
    expect(first.status).toBe(201);

    const duplicate = await postJson(app, "/api/registry/packs", PACK_WRITE_BODY);
    expect(duplicate.status).toBe(409);
    const body = (await duplicate.json()) as { code: string; message: string };
    expect(body.code).toBe("REGISTRY_CONFLICT");
    expect(body.message).toContain("immutable");

    // The refused duplicate left exactly one row behind.
    expect(await packRows(service, CONFIG.packId, PACK_VERSION)).toHaveLength(1);
  });
});

describe("W4 ②: adapter fail-closed gate", () => {
  it("rejects simulationOnly:false with 422 and persists nothing", async () => {
    const { app } = await setupApp();
    const liveIntentAdapter: Record<string, unknown> = {
      ...(BUNDLE.adapter as unknown as Record<string, unknown>),
      simulationOnly: false
    };
    const res = await postJson(app, "/api/registry/adapters", {
      pack: BUNDLE.pack,
      adapter: liveIntentAdapter
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe("REGISTRY_ADAPTER_NOT_SIMULATION_ONLY");
    expect(body.message).toContain("simulationOnly");

    const list = await app.request("/api/registry/adapters", { headers: ADMIN_HEADERS });
    const listBody = (await list.json()) as { items: Array<{ adapterId: string }> };
    expect(listBody.items.filter((item) => item.adapterId === CONFIG.adapterId)).toHaveLength(0);
  });
});

describe("W4 ④: repeated write/read safety", () => {
  it("keeps repeated reads byte-identical and never duplicates a persisted pack", async () => {
    const { app, service } = await setupApp();
    const first = await postJson(app, "/api/registry/packs", PACK_WRITE_BODY);
    expect(first.status).toBe(201);

    // Repeated reads are deterministic (detail and merged list).
    const detailUrl = `/api/registry/packs/${CONFIG.packId}/${PACK_VERSION}`;
    const read1 = await app.request(detailUrl, { headers: ADMIN_HEADERS });
    const text1 = await read1.text();
    const read2 = await app.request(detailUrl, { headers: ADMIN_HEADERS });
    const text2 = await read2.text();
    expect(read1.status).toBe(200);
    expect(read2.status).toBe(200);
    expect(text2).toBe(text1);

    const list1 = await app.request("/api/registry/packs", { headers: ADMIN_HEADERS });
    const listText1 = await list1.text();
    const list2 = await app.request("/api/registry/packs", { headers: ADMIN_HEADERS });
    const listText2 = await list2.text();
    expect(listText1).toBe(listText2);

    // Dual read dedupes the identity: db wins, exactly one merged entry.
    const merged = JSON.parse(listText1) as {
      items: Array<{ packId: string; version: string; source: string }>;
    };
    const matches = merged.items.filter(
      (item) => item.packId === CONFIG.packId && item.version === PACK_VERSION
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("db");

    // DB-level: exactly one immutable row for this identity.
    expect(await packRows(service, CONFIG.packId, PACK_VERSION)).toHaveLength(1);
  });
});

describe("W4 ⑤: registry write RBAC", () => {
  it("denies viewer and operator writes with 403 while still allowing viewer reads", async () => {
    const { app } = await setupApp();
    const viewer = await postJson(app, "/api/registry/packs", PACK_WRITE_BODY, VIEWER_HEADERS);
    expect(viewer.status).toBe(403);
    expect(((await viewer.json()) as { code: string }).code).toBe("AUTH_FORBIDDEN");

    // registry:write is admin-only, so operators are denied too.
    const operator = await postJson(app, "/api/registry/packs", PACK_WRITE_BODY, OPERATOR_HEADERS);
    expect(operator.status).toBe(403);

    // registry:read includes viewer (RBAC asymmetry pinned on purpose).
    const read = await app.request("/api/registry/packs", { headers: VIEWER_HEADERS });
    expect(read.status).toBe(200);
  });
});

describe("W4 ⑥: read failure is fail-closed", () => {
  it("returns 503 REGISTRY_SOURCE_UNAVAILABLE with no fixture fallback on DB read error", async () => {
    const { app, service } = await setupApp();
    const spy = vi
      .spyOn(service, "listRegistryPacks")
      .mockRejectedValue(new Error("w4-injected-db-failure"));
    try {
      const res = await app.request("/api/registry/packs", { headers: ADMIN_HEADERS });
      expect(res.status).toBe(503);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.code).toBe("REGISTRY_SOURCE_UNAVAILABLE");
      expect(String(body.message)).toContain("w4-injected-db-failure");
      expect(body.items).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("fixture");

      // Coverage reads go through the same fail-closed path.
      const coverage = await app.request("/api/registry/coverage", { headers: ADMIN_HEADERS });
      expect(coverage.status).toBe(503);
    } finally {
      spy.mockRestore();
    }

    // Counterfactual: fixture data *is* reachable on the healthy path, so the
    // 503 above was a real refusal to fall back — not an empty registry.
    const healthy = await app.request("/api/registry/packs", { headers: ADMIN_HEADERS });
    expect(healthy.status).toBe(200);
    const healthyBody = (await healthy.json()) as { items: Array<{ source: string }> };
    expect(healthyBody.items.some((item) => item.source === "fixture")).toBe(true);
  });
});
