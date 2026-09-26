#!/usr/bin/env node
/**
 * One-command onboarding skeleton generator for the universal integration
 * kernel. The generated skeleton is data + docs only: a config JSON template
 * and a README with the validation command. All rules (projectKey format,
 * simulation-safe defaults, fail-closed gates) come from the kernel via
 * `validate-integration-config.mjs`; this script duplicates none of them.
 *
 * Usage (from p0-growth-v1):
 *   node scripts/onboard-project.mjs <projectKey> [--name <display name>]
 *     [--type <projectTypeKey>] [--out <dir>] [--force]
 *
 * Defaults: --type <projectKey>_simulation, --out ./examples/<projectKey>.
 * The generated config is validated immediately after generation.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const P0_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VALIDATOR_PATH = fileURLToPath(new URL("./validate-integration-config.mjs", import.meta.url));

function usage() {
  console.error(
    "Usage: node scripts/onboard-project.mjs <projectKey> [--name <display name>] " +
      "[--type <projectTypeKey>] [--out <dir>] [--force]"
  );
}

async function loadKernel() {
  try {
    const { tsImport } = await import("tsx/esm/api");
    return await tsImport("../packages/shared/src/project-integration.ts", import.meta.url);
  } catch (error) {
    console.error(
      "[onboard-project] cannot load the shared kernel. Run `npm install` in p0-growth-v1. " +
        `Cause: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(2);
  }
}

const [projectKey, ...rest] = process.argv.slice(2);
if (!projectKey || projectKey.startsWith("--")) {
  usage();
  process.exit(2);
}

let displayName;
let projectTypeKey;
let outDirArg;
let force = false;

for (let index = 0; index < rest.length; index += 1) {
  const flag = rest[index];
  const value = rest[index + 1];
  if (flag === "--name" && value) {
    displayName = value;
    index += 1;
  } else if (flag === "--type" && value) {
    projectTypeKey = value;
    index += 1;
  } else if (flag === "--out" && value) {
    outDirArg = value;
    index += 1;
  } else if (flag === "--force") {
    force = true;
  } else {
    console.error(`[onboard-project] unknown or incomplete flag: ${flag}`);
    usage();
    process.exit(2);
  }
}

const kernel = await loadKernel();
const parsedKey = kernel.integrationProjectKeySchema.safeParse(projectKey);
if (!parsedKey.success) {
  console.error(
    `[onboard-project] invalid projectKey '${projectKey}': ${parsedKey.error.issues
      .map((issue) => issue.message)
      .join("; ")}`
  );
  process.exit(2);
}

const config = {
  projectKey,
  projectTypeKey: projectTypeKey ?? `${projectKey}_simulation`,
  packId: `pack_${projectKey}_simulation`,
  adapterId: `adapter_${projectKey}_simulation`,
  sourceSystem: `${projectKey.toUpperCase()}_SIMULATION`,
  projectName: displayName ?? `${projectKey} integration`,
  // Explicit for readability; this is also the kernel default and any other
  // value is rejected fail-closed.
  budgetPolicy: { mode: "SIMULATION_ONLY" }
};

const outRoot = outDirArg
  ? path.resolve(process.cwd(), outDirArg)
  : path.resolve(process.cwd(), "examples", projectKey);
const configPath = path.join(outRoot, "project.integration.json");
const readmePath = path.join(outRoot, "README.md");

if (existsSync(configPath) && !force) {
  console.error(
    `[onboard-project] ${configPath} already exists; pass --force to overwrite the generated skeleton.`
  );
  process.exit(2);
}

const readme = `# ${projectKey} · 接入骨架（simulation-only）

由 \`p0-growth-v1/scripts/onboard-project.mjs\` 生成。本目录只有配置与说明，不含任何内核代码。

## 文件

- \`project.integration.json\` — 接入配置。5 个必填身份字段之外的字段全部有
  simulation-safe 默认值（见 \`${P0_ROOT}packages/shared/src/project-integration.ts\`）。

## 校验（一行命令）

\`\`\`sh
cd "${P0_ROOT}"
node scripts/validate-integration-config.mjs "${configPath}"
\`\`\`

## 注册（应用侧代码）

\`\`\`ts
import { readFileSync } from "node:fs";
import {
  createSimulationIntegrationRegistry,
  buildSimulationAdapterInputs
} from "@neuroclaw/shared";

const config = JSON.parse(readFileSync("${configPath}", "utf8"));
const registry = createSimulationIntegrationRegistry();
const registration = registry.register(config); // 已注册则 fail-closed
const adapterInputs = buildSimulationAdapterInputs({
  [registration.projectKey]: registration.bundle.adapter
});
\`\`\`

## 口径

- **零内核改动**：新项目只加配置；内核不出现任何项目名分支。
- **fail-closed**：writeScopes / authRequirements 非空、sideEffects 非 ["none"]、
  adapter 非 SANDBOXED、budgetPolicy.mode 非 SIMULATION_ONLY、未知字段等一律报错。
- **simulationOnly**：不接真实渠道、凭据、生产数据。

完整指南：\`${P0_ROOT}docs/onboarding.md\`
`;

await mkdir(outRoot, { recursive: true });
await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
await writeFile(readmePath, readme, "utf8");

console.log(`[onboard-project] generated ${configPath}`);
console.log(`[onboard-project] generated ${readmePath}`);

const validation = spawnSync(process.execPath, [VALIDATOR_PATH, configPath], {
  cwd: P0_ROOT,
  stdio: "inherit"
});
if (validation.status !== 0) {
  console.error(
    "[onboard-project] generated skeleton failed validation; fix project.integration.json and rerun the validator."
  );
  process.exit(validation.status ?? 1);
}

console.log(`[onboard-project] skeleton ready: ${outRoot}`);
