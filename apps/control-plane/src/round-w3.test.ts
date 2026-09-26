import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { closeDatabase, createInMemoryDb, type Database } from "@neuroclaw/db";
import {
  assertSimulationProjectIntegrationConsistency,
  type SimulationProjectIntegrationBundle
} from "@neuroclaw/shared";
import { ControlPlaneService } from "./index.js";
import { createApp, type App } from "./app.js";

/**
 * W3 directed test — the project-integration kernel wired to the control-plane
 * HTTP surface (design B1 §W3: four routes under /api/integration).
 *
 * Pinned here: the happy path of all four routes, RBAC for
 * `integration:read` / `integration:validate`, the fail-closed rejections
 * (non-simulation budget, write intent, unknown fields), 404 for unknown
 * project keys, `contractVersion` on every response, and the red line that no
 * route accepts an adapter manifest as caller input.
 */

const originalApiKeys = process.env.NEUROCLAW_API_KEYS;

beforeAll(() => {
  process.env.NEUROCLAW_API_KEYS =
    "w3-admin-key:admin_w3:admin,w3-operator-key:operator_w3:operator,w3-viewer-key:viewer_w3:viewer";
});

afterAll(() => {
  if (originalApiKeys === undefined) {
    delete process.env.NEUROCLAW_API_KEYS;
  } else {
    process.env.NEUROCLAW_API_KEYS = originalApiKeys;
  }
});

const openDatabases: Database[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) await closeDatabase(openDatabases.pop()!);
});

async function setupApp(): Promise<{ app: App; service: ControlPlaneService; db: Database }> {
  const db = await createInMemoryDb();
  openDatabases.push(db);
  const service = await ControlPlaneService.create(undefined, db);
  return { app: createApp(service), service, db };
}

const ADMIN_HEADERS = { Authorization: "Bearer w3-admin-key" };
const OPERATOR_HEADERS = { Authorization: "Bearer w3-operator-key" };
const VIEWER_HEADERS = { Authorization: "Bearer w3-viewer-key" };

const VALID_CONFIG = {
  projectKey: "w3_validate",
  projectTypeKey: "engineering_os",
  packId: "pack_w3_validate",
  adapterId: "adapter_w3_validate",
  sourceSystem: "W3_SIMULATION"
};

function postValidate(app: App, body: unknown, headers = ADMIN_HEADERS) {
  return app.request("/api/integration/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

describe("W3: POST /api/integration/validate", () => {
  it("accepts a legal simulation config and passes consistency validation", async () => {
    const { app } = await setupApp();
    const res = await postValidate(app, VALID_CONFIG);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      contractVersion: string;
      bundle: SimulationProjectIntegrationBundle;
      adapterInput: { simulationOnly: boolean; writeScopes: string[] };
    };
    expect(body.contractVersion).toBe("1.0.0");
    expect(body.bundle.projectKey).toBe("w3_validate");
    expect(body.adapterInput.simulationOnly).toBe(true);
    expect(body.adapterInput.writeScopes).toEqual([]);
    expect(() => assertSimulationProjectIntegrationConsistency(body.bundle)).not.toThrow();
  });

  it("rejects a non-SIMULATION_ONLY budget policy with 422 and the kernel message", async () => {
    const { app } = await setupApp();
    const res = await postValidate(app, { ...VALID_CONFIG, budgetPolicy: { mode: "LIVE" } });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { message: string };
    expect(body.message).toBe(
      "Simulation integrations require budgetPolicy.mode = SIMULATION_ONLY"
    );
  });

  it("fails closed on write scope intent with 422", async () => {
    const { app } = await setupApp();
    const res = await postValidate(app, { ...VALID_CONFIG, writeScopes: ["external:write"] });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { message: string };
    expect(body.message).toContain("write scopes");
  });

  it("rejects adapter-manifest style payloads via the strict config schema", async () => {
    const { app } = await setupApp();
    const res = await postValidate(app, { ...VALID_CONFIG, simulationOnly: false });
    expect(res.status).toBe(422);

    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("lets operators validate but denies viewers with 403 (permission table enforced)", async () => {
    const { app } = await setupApp();
    const operator = await postValidate(app, VALID_CONFIG, OPERATOR_HEADERS);
    expect(operator.status).toBe(200);

    const viewer = await postValidate(app, VALID_CONFIG, VIEWER_HEADERS);
    expect(viewer.status).toBe(403);

    const body = (await viewer.json()) as { code: string };
    expect(body.code).toBe("AUTH_FORBIDDEN");
  });
});

describe("W3: GET /api/integration reads", () => {
  it("lists the four pilot projects with summary fields", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/integration/projects", { headers: VIEWER_HEADERS });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      contractVersion: string;
      projects: Array<Record<string, string>>;
    };
    expect(body.contractVersion).toBe("1.0.0");
    expect(body.projects.map((project) => project.projectKey).sort()).toEqual([
      "bitmind",
      "ex_protocol",
      "hesn",
      "uaos"
    ]);
    const uaos = body.projects.find((project) => project.projectKey === "uaos");
    expect(uaos).toMatchObject({
      projectId: "prj_uaos",
      packId: "pack_uaos_engineering",
      packVersion: "1.0.0",
      typeKey: "engineering_os",
      status: "ACTIVE"
    });
  });

  it("serves one bundle by key and returns 404 for an unknown key", async () => {
    const { app } = await setupApp();
    const ok = await app.request("/api/integration/projects/uaos", { headers: VIEWER_HEADERS });
    expect(ok.status).toBe(200);

    const okBody = (await ok.json()) as {
      contractVersion: string;
      bundle: SimulationProjectIntegrationBundle;
    };
    expect(okBody.contractVersion).toBe("1.0.0");
    expect(okBody.bundle.projectKey).toBe("uaos");
    expect(() => assertSimulationProjectIntegrationConsistency(okBody.bundle)).not.toThrow();

    const missing = await app.request("/api/integration/projects/no_such_project", {
      headers: VIEWER_HEADERS
    });
    expect(missing.status).toBe(404);

    const missingBody = (await missing.json()) as { code: string };
    expect(missingBody.code).toBe("INTEGRATION_PROJECT_NOT_FOUND");
  });

  it("strips the hard-coded readiness/evidenceAt constants from adapters", async () => {
    const { app } = await setupApp();
    const res = await app.request("/api/integration/adapters", { headers: VIEWER_HEADERS });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      contractVersion: string;
      adapters: Array<Record<string, unknown>>;
    };
    expect(body.contractVersion).toBe("1.0.0");
    expect(body.adapters).toHaveLength(4);
    for (const adapter of body.adapters) {
      expect(adapter.simulationOnly).toBe(true);
      expect(adapter.writeScopes).toEqual([]);
      expect(adapter).not.toHaveProperty("readiness");
      expect(adapter).not.toHaveProperty("evidenceAt");
    }
  });

  it("keeps the route surface free of adapter manifest inputs (red line)", () => {
    const source = readFileSync(new URL("./app.ts", import.meta.url), "utf8");
    expect(source).not.toContain("adapterManifestSchema");
    expect(source).not.toMatch(/AdapterManifest/);
  });
});
