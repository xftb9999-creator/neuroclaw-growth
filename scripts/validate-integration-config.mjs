#!/usr/bin/env node
/**
 * Validates integration config JSON files through the universal
 * project-integration kernel (single source of truth). This script carries no
 * rules of its own: parsing, derivation, registration records and every
 * fail-closed gate come from `packages/shared/src/project-integration.ts`.
 *
 * Usage (from p0-growth-v1):
 *   node scripts/validate-integration-config.mjs <config.json> [more.json ...]
 *
 * Exit codes: 0 = all configs valid, 1 = at least one config rejected,
 * 2 = usage/tooling error.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const P0_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function loadKernel() {
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport("../packages/shared/src/project-integration.ts", import.meta.url);
  } catch (error) {
    console.error(
      "[validate-integration-config] cannot load the shared kernel. " +
        "Run `npm install` in p0-growth-v1 (tsx is required to load TypeScript sources). " +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
}

function printRegistration(registration) {
  const { bundle, adapterInput } = registration;
  console.log(`[validate-integration-config] OK ${bundle.projectKey}`);
  console.log(`  project:      ${bundle.project.id} (${bundle.project.name})`);
  console.log(`  pack:         ${bundle.pack.packId}@${bundle.pack.version} [${bundle.pack.status}]`);
  console.log(
    `  adapter:      ${bundle.adapter.adapterId}@${bundle.adapter.version} ` +
      `[${bundle.adapter.status}, simulationOnly=${bundle.adapter.simulationOnly}]`
  );
  console.log(`  workflow:     ${bundle.workflow.id}`);
  console.log(
    `  adapterInput: readiness=${adapterInput.readiness} ` +
      `writeScopes=${adapterInput.writeScopes.length} sideEffects=${JSON.stringify(adapterInput.sideEffects)}`
  );
}

const configPaths = process.argv.slice(2);
if (configPaths.length === 0) {
  console.error(
    "Usage: node scripts/validate-integration-config.mjs <config.json> [more.json ...]"
  );
  process.exit(2);
}

const kernel = await loadKernel();
let failures = 0;

for (const configPath of configPaths) {
  const absolutePath = path.resolve(process.cwd(), configPath);
  try {
    const config = JSON.parse(await readFile(absolutePath, "utf8"));
    const registration = kernel.buildSimulationProjectIntegrationRegistration(config);
    printRegistration(registration);
  } catch (error) {
    failures += 1;
    console.error(`[validate-integration-config] FAIL ${configPath}`);
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures > 0) {
  console.error(
    `[validate-integration-config] ${failures}/${configPaths.length} config(s) rejected (fail-closed).`
  );
  process.exit(1);
}

console.log(
  `[validate-integration-config] ${configPaths.length} config(s) registered through the universal kernel with zero kernel changes.`
);
