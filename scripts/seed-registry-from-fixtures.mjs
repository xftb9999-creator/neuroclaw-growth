#!/usr/bin/env node
/**
 * 0008 注册表种子脚本：把 4 组 pilot fixtures 的 Project Pack / Adapter 快照
 * 幂等写入 project_pack_registry / adapter_registry（W4 · B1-wire-first-design §4）。
 *
 * 数据流（单一真源，脚本不复制任何内核规则）：
 *   packages/shared 的 pilotSimulationIntegrationConfigs（pilot-fixtures.ts:126）
 *     → 按 projectKey 取内核派生的 pilotPackManifests / pilotAdapterManifests /
 *       pilotProjects / pilotWorkflows（同一 buildSimulationProjectIntegration 派生链）
 *     → validateAllPilotFixtures() 预检 + assertSimulationOnlyAdapter()（fail-closed）
 *     → ControlPlaneService.persistProjectPack / persistAdapterManifest
 *       （apps/control-plane/src/index.ts:2185 / :2338）
 *     → project_pack_registry / adapter_registry（migrations.ts:562 起的 0008 迁移）。
 *
 * 导入路径说明（为什么用编译产物 dist 而不是 TS 源码）：
 *   TS 源码经 tsx（`tsImport`，scripts/validate-integration-config.mjs 的既有用法）
 *   加载后，PGlite（`:memory:` / `file:` 模式）在首次查询时失败：tsx 的 CJS 钩子把
 *   PGlite 内部 `require("node:fs")` 解析成 `node:fs?tsx-namespace=...` → ENOENT
 *   （本脚本编写时实测，见下方验证证据第 1 条）。纯 node + dist 是本仓已验证可行的
 *   运行路径（与 `npm start` 消费编译产物一致）。
 *   → 运行前须 `cd p0-growth-v1 && npm run typecheck`（tsc -b 会刷新 dist）或
 *     `npm run build`；dist 缺失/缺导出时脚本以退出码 2 拒绝执行（fail-closed），
 *     src 比 dist 新时打印 stale 警告（不阻断，写入前的 dry-run 是人工核对闸门）。
 *
 * 幂等（check-then-insert + 内容哈希比对）：
 *   - 身份 = (packId, version) / (adapterId, version)，对应 0008 唯一索引
 *     idx_project_pack_registry_identity_version / idx_adapter_registry_identity_version；
 *     服务层对重复身份直接抛"already exists and is immutable"，故本脚本必须先查后插。
 *   - 逐行先读注册表：无既有行 → INSERT；有且 manifestSnapshot 的 canonical JSON
 *     与 fixture 完全一致（对 sha256 作展示）→ SKIP；不一致/绑定矛盾 → CONFLICT。
 *   - 任何 CONFLICT：dry-run 与 --confirm 均非零退出；--confirm 下整批不写（fail-closed），
 *     避免"部分写入 + 永久占用错误身份"（B1 §4 风险 R1）。
 *   - --confirm 写完后逐行回读，再次比对 canonical JSON；不一致则非零退出。
 *
 * 用法（cwd = p0-growth-v1）：
 *   node scripts/seed-registry-from-fixtures.mjs                      # dry-run（默认，不写注册表）
 *   node scripts/seed-registry-from-fixtures.mjs --confirm            # 写入
 *   node scripts/seed-registry-from-fixtures.mjs --db-url postgres://...     # 指向 PG
 *   node scripts/seed-registry-from-fixtures.mjs --db-url file:./data/neuroclaw-pg  # PGlite 持久目录
 *   node scripts/seed-registry-from-fixtures.mjs --help
 *
 * DB 解析顺序与 packages/db/src/index.ts:98-127 约定一致：
 *   --db-url > 环境变量 DATABASE_URL > ":memory:"（PGlite 内存库，进程退出即弃）。
 *   注：createDb 默认应用幂等迁移（CREATE TABLE IF NOT EXISTS），dry-run 也会执行，
 *   以便对既有库做 check-then-insert 比对；注册表数据行只有 --confirm 才写。
 *
 * 退出码：0 = 成功（dry-run 无冲突 / confirm 全部落库且回读一致）；
 *         1 = CONFLICT（哈希不一致、注册表绑定矛盾、回读校验失败）；
 *         2 = 用法或工具错误（dist 缺失/过旧、DB 不可达、迁移失败等）。
 *
 * 验证证据（作者线程实测，macOS / node v26.7.0；命令与输出见任务回执）：
 *   1. `node --check scripts/seed-registry-from-fixtures.mjs` → 通过（语法）。
 *   2. dry-run（默认 :memory:）→ 4 pack + 4 adapter 全部 INSERT，退出码 0。
 *   3. `--confirm --db-url file:<临时目录>` 连跑两遍（PGlite 持久库）：
 *      第一遍 4 pack + 4 adapter INSERT + 回读校验 4/4；第二遍全部 SKIP 且
 *      registry sha256 与 fixture 一致、回读 4/4（幂等），两次退出码均 0。
 *   4. 对种子库篡改一行 manifest_snapshot 后 dry-run → 1 CONFLICT（打印双方
 *      sha256），退出码 1，且不做任何写入（fail-closed）。
 *   5. src 与 dist 的 4 组 pack/adapter canonical sha256 全等（本脚本编写时核过，
 *      故使用 dist 不改变 fixtures 内容；dist 过旧时仍有 stale 警告兜底）。
 *   （脚本只依赖已装依赖，不新增任何包。）
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const P0_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_NAME = "seed-registry-from-fixtures";

class SeedFailure extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function log(message) {
  console.log(`[${SCRIPT_NAME}] ${message}`);
}

function warn(message) {
  console.warn(`[${SCRIPT_NAME}] WARN: ${message}`);
}

function usageText() {
  return [
    "Usage: node scripts/seed-registry-from-fixtures.mjs [--confirm] [--db-url <url>]",
    "",
    "  (default)         dry-run：只读注册表并打印将写入的行与哈希比对结果",
    "  --confirm         写入 project_pack_registry / adapter_registry（不可变，先查后插）",
    "  --db-url <url>    postgres://… / file:./path / :memory:（默认 DATABASE_URL，否则 :memory:）",
    "  --help            显示本帮助",
    "",
    "Exit codes: 0 = ok, 1 = conflict/mismatch, 2 = usage or tooling error."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { confirm: false, dbUrl: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm") {
      options.confirm = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--db-url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new SeedFailure("--db-url 需要一个取值", 2);
      }
      options.dbUrl = value;
      index += 1;
    } else if (arg.startsWith("--db-url=")) {
      options.dbUrl = arg.slice("--db-url=".length);
    } else {
      throw new SeedFailure(`未知参数：${arg}\n${usageText()}`, 2);
    }
  }
  return options;
}

/** 与 apps/control-plane/src/index.ts:469 的 canonicalJson 逐行为等价（比对口径一致）。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function snapshotHash(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function shortHash(hash) {
  return `${hash.slice(0, 16)}…`;
}

/** 隐藏 URL 中的凭据（user:pass@），避免日志泄露。 */
function sanitizeDbUrl(url) {
  return url.replace(/\/\/([^@/]+)@/, "//***@");
}

function newestSourceMtimeMs(srcDir) {
  let newest = 0;
  for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const fullPath = join(entry.parentPath ?? entry.path, entry.name);
    const mtime = statSync(fullPath).mtimeMs;
    if (mtime > newest) newest = mtime;
  }
  return newest;
}

function checkDistFreshness() {
  const pairs = ["packages/shared", "packages/db", "apps/control-plane"];
  const stale = [];
  for (const packageDir of pairs) {
    const srcDir = join(P0_ROOT, packageDir, "src");
    const distFile = join(P0_ROOT, packageDir, "dist", "index.js");
    if (!existsSync(srcDir) || !existsSync(distFile)) continue;
    if (newestSourceMtimeMs(srcDir) > statSync(distFile).mtimeMs + 1000) {
      stale.push(relative(P0_ROOT, distFile));
    }
  }
  if (stale.length > 0) {
    warn(
      `dist 可能过旧（src 比产物新）：${stale.join(", ")}；建议先运行 \`npm run typecheck\`，` +
        "并务必用 dry-run 核对将写入的行。"
    );
  }
}

async function loadModules() {
  const dist = {
    shared: join(P0_ROOT, "packages/shared/dist/index.js"),
    controlPlane: join(P0_ROOT, "apps/control-plane/dist/index.js"),
    db: join(P0_ROOT, "packages/db/dist/index.js")
  };
  for (const [name, file] of Object.entries(dist)) {
    if (!existsSync(file)) {
      throw new SeedFailure(
        `${name} 编译产物缺失：${relative(P0_ROOT, file)}；先运行 \`npm run typecheck\`（tsc -b 刷新 dist）或 \`npm run build\``,
        2
      );
    }
  }

  let shared;
  let controlPlane;
  let dbModule;
  try {
    [shared, controlPlane, dbModule] = await Promise.all([
      import(pathToFileURL(dist.shared).href),
      import(pathToFileURL(dist.controlPlane).href),
      import(pathToFileURL(dist.db).href)
    ]);
  } catch (error) {
    throw new SeedFailure(
      `无法加载编译产物（先运行 \`npm run typecheck\`）：${error instanceof Error ? error.message : String(error)}`,
      2
    );
  }

  if (
    typeof shared.validateAllPilotFixtures !== "function" ||
    typeof shared.assertSimulationOnlyAdapter !== "function" ||
    !Array.isArray(shared.pilotSimulationIntegrationConfigs) ||
    !shared.pilotPackManifests ||
    !shared.pilotAdapterManifests ||
    !shared.pilotProjects ||
    !shared.pilotWorkflows
  ) {
    throw new SeedFailure("shared dist 缺少 pilot fixtures / 内核导出，产物可能过旧；请先 `npm run typecheck`", 2);
  }
  if (
    typeof controlPlane.ControlPlaneService?.prototype?.persistProjectPack !== "function" ||
    typeof controlPlane.ControlPlaneService?.prototype?.persistAdapterManifest !== "function"
  ) {
    throw new SeedFailure(
      "control-plane dist 缺少 0008 注册表 service 方法（persistProjectPack/persistAdapterManifest），产物过旧；请先 `npm run typecheck`",
      2
    );
  }
  if (typeof dbModule.createDb !== "function" || typeof dbModule.closeDatabase !== "function") {
    throw new SeedFailure("db dist 缺少 createDb/closeDatabase", 2);
  }
  return { shared, ControlPlaneService: controlPlane.ControlPlaneService, dbModule };
}

function buildRows(shared) {
  const configs = shared.pilotSimulationIntegrationConfigs;
  if (configs.length === 0) throw new SeedFailure("fixtures 为空，拒绝执行", 2);

  const preflight = shared.validateAllPilotFixtures();
  if (preflight.length !== configs.length) {
    throw new SeedFailure(`fixture 预检数量不符：${preflight.length} != ${configs.length}`, 2);
  }
  log(`fixture 预检：${preflight.length}/${configs.length} 组 simulation-only 校验通过`);

  const rows = configs.map((config) => {
    const projectKey = config.projectKey;
    const pack = shared.pilotPackManifests[projectKey];
    const adapter = shared.pilotAdapterManifests[projectKey];
    const project = shared.pilotProjects[projectKey];
    const workflow = shared.pilotWorkflows[projectKey];
    if (!pack || !adapter || !project || !workflow) {
      throw new SeedFailure(`fixture 缺少 ${projectKey} 的 pack/adapter/project/workflow`, 2);
    }
    shared.assertSimulationOnlyAdapter(adapter);
    return {
      projectKey,
      pack,
      adapter,
      project,
      workflow,
      packIdentity: `${pack.packId}@${pack.version}`,
      adapterIdentity: `${adapter.adapterId}@${adapter.version}`,
      packHash: snapshotHash(pack),
      adapterHash: snapshotHash(adapter)
    };
  });
  log(`待处理身份：${rows.map((row) => row.packIdentity).join(", ")}`);
  return rows;
}

async function evaluateRow(service, row) {
  const result = { row, packAction: null, adapterAction: null, packNote: "", adapterNote: "" };

  const packEntry = await service.getProjectPackRegistryEntry(row.pack.packId, row.pack.version);
  if (!packEntry) {
    result.packAction = "INSERT";
    result.packNote = "无既有行";
  } else if (canonicalJson(packEntry.manifestSnapshot) === canonicalJson(row.pack)) {
    result.packAction = "SKIP";
    result.packNote = `内容哈希一致（registry sha256=${shortHash(snapshotHash(packEntry.manifestSnapshot))}）`;
  } else {
    result.packAction = "CONFLICT";
    result.packNote =
      `内容哈希不一致：fixture sha256=${row.packHash} vs registry sha256=${snapshotHash(packEntry.manifestSnapshot)}`;
  }

  const adapterEntry = await service.getAdapterRegistryEntry(row.adapter.adapterId, row.adapter.version);
  if (adapterEntry && !packEntry) {
    result.adapterAction = "CONFLICT";
    result.adapterNote = "adapter_registry 存在行但 project_pack_registry 缺行（注册表状态矛盾）";
  } else if (!adapterEntry) {
    result.adapterAction = "INSERT";
    result.adapterNote = "无既有行";
  } else if (adapterEntry.packId !== row.pack.packId || adapterEntry.packVersion !== row.pack.version) {
    result.adapterAction = "CONFLICT";
    result.adapterNote =
      `pack 绑定不一致：registry=${adapterEntry.packId}@${adapterEntry.packVersion} vs fixture=${row.packIdentity}`;
  } else if (canonicalJson(adapterEntry.manifestSnapshot) === canonicalJson(row.adapter)) {
    result.adapterAction = "SKIP";
    result.adapterNote = `内容哈希一致（registry sha256=${shortHash(snapshotHash(adapterEntry.manifestSnapshot))}）`;
  } else {
    result.adapterAction = "CONFLICT";
    result.adapterNote =
      `内容哈希不一致：fixture sha256=${row.adapterHash} vs registry sha256=${snapshotHash(adapterEntry.manifestSnapshot)}`;
  }

  return result;
}

function printPlan(evaluations) {
  log("将处理的行（身份 / 作用域 / 内容哈希 / 决策）：");
  for (const evaluation of evaluations) {
    const { row } = evaluation;
    log(
      `  pack    ${row.packIdentity}  project=${row.pack.projectId}  status=${row.pack.status}  ` +
        `sha256=${shortHash(row.packHash)}  -> ${evaluation.packAction}（${evaluation.packNote}）`
    );
    log(
      `  adapter ${row.adapterIdentity}  pack=${row.packIdentity}  status=${row.adapter.status}  ` +
        `simulationOnly=${row.adapter.simulationOnly}  sha256=${shortHash(row.adapterHash)}  -> ` +
        `${evaluation.adapterAction}（${evaluation.adapterNote}）`
    );
  }
}

function summarize(evaluations, actionKey) {
  const counts = { INSERT: 0, SKIP: 0, CONFLICT: 0 };
  for (const evaluation of evaluations) counts[evaluation[actionKey]] += 1;
  return counts;
}

async function confirmWrites(service, evaluations) {
  for (const evaluation of evaluations) {
    const { row } = evaluation;
    if (evaluation.packAction === "INSERT") {
      await service.persistProjectPack(row.pack, {
        project: row.project,
        workflows: [row.workflow],
        adapters: [row.adapter]
      });
      log(`INSERT pack ${row.packIdentity}（project=${row.pack.projectId}）`);
    } else {
      log(`SKIP pack ${row.packIdentity}（已存在且内容哈希一致）`);
    }

    if (evaluation.adapterAction === "INSERT") {
      await service.persistAdapterManifest(row.adapter, {
        pack: row.pack,
        project: row.project,
        workflows: [row.workflow]
      });
      log(`INSERT adapter ${row.adapterIdentity}（pack=${row.packIdentity}）`);
    } else {
      log(`SKIP adapter ${row.adapterIdentity}（已存在且内容哈希一致）`);
    }
  }

  for (const evaluation of evaluations) {
    const { row } = evaluation;
    const packEntry = await service.getProjectPackRegistryEntry(row.pack.packId, row.pack.version);
    const adapterEntry = await service.getAdapterRegistryEntry(row.adapter.adapterId, row.adapter.version);
    if (!packEntry || canonicalJson(packEntry.manifestSnapshot) !== canonicalJson(row.pack)) {
      throw new SeedFailure(`回读校验失败：pack ${row.packIdentity} 与 fixture 哈希不一致`, 1);
    }
    if (
      !adapterEntry ||
      canonicalJson(adapterEntry.manifestSnapshot) !== canonicalJson(row.adapter) ||
      adapterEntry.packId !== row.pack.packId ||
      adapterEntry.packVersion !== row.pack.version
    ) {
      throw new SeedFailure(`回读校验失败：adapter ${row.adapterIdentity} 与 fixture 不一致`, 1);
    }
  }
  log(`回读校验通过：${evaluations.length}/${evaluations.length} 组 pack+adapter 与 fixture canonical JSON 一致`);
}

async function run(options) {
  const { shared, ControlPlaneService, dbModule } = await loadModules();
  checkDistFreshness();

  const rows = buildRows(shared);

  const dbUrl = options.dbUrl ?? process.env.DATABASE_URL ?? ":memory:";
  log(options.confirm ? "MODE: --confirm（写入注册表数据行）" : "MODE: dry-run（默认；写入需 --confirm）");
  log(
    `db: ${sanitizeDbUrl(dbUrl)}` +
      (dbUrl === ":memory:" ? "（PGlite 内存库，进程退出即弃）" : "") +
      "；createDb 将应用幂等迁移（仅建缺失表）"
  );

  const db = await dbModule.createDb({ url: dbUrl });
  try {
    const service = await ControlPlaneService.create(undefined, db);

    const evaluations = [];
    for (const row of rows) {
      evaluations.push(await evaluateRow(service, row));
    }
    printPlan(evaluations);

    const conflicts = evaluations.filter(
      (evaluation) => evaluation.packAction === "CONFLICT" || evaluation.adapterAction === "CONFLICT"
    );
    if (conflicts.length > 0) {
      throw new SeedFailure(
        `检测到 ${conflicts.length} 处 CONFLICT（哈希不一致或注册表绑定矛盾），拒绝写入（fail-closed）`,
        1
      );
    }

    const packCounts = summarize(evaluations, "packAction");
    const adapterCounts = summarize(evaluations, "adapterAction");
    const totalInserts = packCounts.INSERT + adapterCounts.INSERT;
    const totalSkips = packCounts.SKIP + adapterCounts.SKIP;

    if (!options.confirm) {
      log(
        `DRY-RUN 完成：待写入 ${packCounts.INSERT} pack + ${adapterCounts.INSERT} adapter（共 ${totalInserts} 行），` +
          `已存在且一致 ${totalSkips} 行；未写入任何数据（加 --confirm 才写）`
      );
      return 0;
    }

    await confirmWrites(service, evaluations);
    log(
      `confirm 完成：INSERT ${packCounts.INSERT} pack + ${adapterCounts.INSERT} adapter，` +
        `SKIP ${packCounts.SKIP} pack + ${adapterCounts.SKIP} adapter`
    );
    return 0;
  } finally {
    await dbModule.closeDatabase(db);
  }
}

try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usageText());
  } else {
    process.exitCode = await run(options);
  }
} catch (error) {
  if (error instanceof SeedFailure) {
    console.error(`[${SCRIPT_NAME}] ERROR: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(`[${SCRIPT_NAME}] ERROR: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 2;
  }
}
