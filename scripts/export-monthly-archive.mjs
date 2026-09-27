#!/usr/bin/env node
/**
 * I-017 L0 月度档案导出脚本（Q1=C 内部运营先行；GM 裁决见
 * ../../../.artifacts/i017-format/options.md，相对本仓根为 ../.artifacts/i017-format/options.md）。
 *
 * 数据流（单一真源，脚本不复制任何内核规则）：
 *   ControlPlaneService.aggregateMonthlyArchive（apps/control-plane/src/index.ts:4481）
 *     → buildMonthlyArchive（apps/control-plane/src/monthly-archive.ts）
 *       → 按 workspace + period 聚合 runs / approval_requests / artifacts /
 *         memory_records / audit_events / work_items 的「档案中间模型」
 *     → 本脚本：dry-run 打印摘要；--confirm --out <path> 写 JSON 并回读校验。
 *
 * 本脚本只做「读 + 落盘」，不发明任何对客字段契约：
 *   format_version / archive_id / batches[] / client_name 与对客渲染属 L3/L4；
 *   universal 口径（evidence_records/receipts 写接线）不在此实现（v1.5 候选）。
 *   已知歧义（batch_no 规则 / approver 归属 / drafts 抽取）见 monthly-archive.ts
 *   文件头与任务回执 ambiguity 清单。
 *
 * 导入路径说明（为什么用编译产物 dist 而不是 TS 源码）：
 *   与 scripts/seed-registry-from-fixtures.mjs 同因：tsx 的 CJS 钩子会让 PGlite
 *   内部 `require("node:fs")` 解析失败（ENOENT）；纯 node + dist 是本仓已验证
 *   可行的运行路径。运行前须 `npm run typecheck`（tsc -b 刷新 dist）；dist 缺失
 *   或缺导出时以退出码 2 拒绝执行（fail-closed）。
 *
 * 过滤口径（2026-09-27 实测修复，勿回退 like 前缀）：
 *   物理列 created_at 为 TIMESTAMPTZ（packages/db/src/migrations.ts BASELINE），
 *   而 schema.ts 声明 text()——`like` 前缀过滤在 PG 上无 `timestamptz ~~ text`
 *   算子（42883）。读路径使用月界 gte/lt（左闭右开，见 monthly-archive.ts
 *   periodBounds），且对 PGlite 读回的会话时区文本做 ISO-8601 UTC 归一
 *   （monthly-archive.ts normalizeTimestamp；读契约见 packages/db/src/index.ts:87-94）。
 *   业务月界默认 +08（Asia/Shanghai；GM 2026-09-27 裁决 A4），--tz-offset 显式覆盖。
 *
 * 幂等/写入（fail-closed）：
 *   - 默认 dry-run：只读聚合 + 摘要打印，不写任何文件；
 *   - --confirm 须与 --out 同用；输出文件已存在则拒绝覆盖（exit 1）；
 *   - 写入后回读 JSON 并核对 workspaceId/period/totals/runs.length，不一致即 exit 1，
 *     不留「已覆盖/半写」状态（写入为单次 writeFileSync，仅新建路径）。
 *
 * 用法（cwd = p0-growth-v1）：
 *   node scripts/export-monthly-archive.mjs --workspace-id ws_x --period 2026-08
 *        # dry-run（默认）：只读聚合 + 摘要打印
 *   node scripts/export-monthly-archive.mjs --workspace-id ws_x --period 2026-08 \
 *        --out ../.artifacts/archive/ws_x-2026-08.json --confirm
 *        # 写 JSON + 回读校验
 *   node scripts/export-monthly-archive.mjs --workspace-id ws_x --period 2026-08 \
 *        --tz-offset 0     # 显式 UTC 月界（默认 480 = +08:00 Asia/Shanghai）
 *   node scripts/export-monthly-archive.mjs --db-url file:./data/neuroclaw-pg ...
 *   node scripts/export-monthly-archive.mjs --help
 *
 * DB 解析顺序与 packages/db/src/index.ts:107-109 约定一致：
 *   --db-url > 环境变量 DATABASE_URL > ":memory:"。
 *
 * 退出码：0 = 成功（dry-run 摘要 / confirm 写入且回读一致）；
 *         1 = 业务拒绝或校验失败（workspace 不存在、输出已存在拒绝覆盖、回读不一致）；
 *         2 = 用法或工具错误（缺参/period 非法、dist 缺失或过旧、DB 不可达、聚合异常）。
 *
 * 验证证据（作者线程实测，macOS / node v26.7.0；原始日志见
 * ../.artifacts/i017-l0/smoke/*.log 与 ../.artifacts/i017-l0/EVIDENCE.md）：
 *   1. `node --check scripts/export-monthly-archive.mjs` → 通过（语法）。
 *   2. 冒烟（PGlite file 库，种子 smoke/seed-smoke.mjs：1 workspace / 1 run /
 *      1 audit，period=2026-08）：
 *      - dry-run 摘要 totals.runs=1 / auditEvents=1，exit 0；
 *      - `--confirm --out` 写入 1334 bytes 且回读校验一致，exit 0；
 *      - 重跑同一 out → 拒绝覆盖 exit 1（fail-closed）；
 *      - 缺参 exit 2；非法 period（2026-13）exit 2；未知 workspace exit 1。
 *   3. 时间读回归一：run0.createdAt=2026-08-05T09:00:00.000Z、
 *      audit0.createdAt=2026-08-05T09:01:00.000Z（PGlite 会话时区文本已归一）。
 *   （脚本只依赖已装依赖，不新增任何包。）
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const P0_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT_NAME = "export-monthly-archive";
const RUN_IDS_PREVIEW_LIMIT = 10;

class ExportFailure extends Error {
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
    "Usage: node scripts/export-monthly-archive.mjs --workspace-id <id> --period <YYYY-MM> [--tz-offset <minutes>] [--out <path> --confirm] [--db-url <url>]",
    "",
    "  --workspace-id <id>  （必填）workspace/租户 ID",
    "  --period <YYYY-MM>   （必填）档案期（月）",
    "  --tz-offset <min>    业务月界时区偏移（分钟，东为正；默认 480 = +08:00 Asia/Shanghai；0 = UTC）",
    "  --out <path>         输出 JSON 路径（需 --confirm 才写；已存在则拒绝覆盖）",
    "  --confirm            写入 --out 并回读校验（默认 dry-run：只读 + 摘要）",
    "  --db-url <url>       postgres://… / file:./path / :memory:（默认 DATABASE_URL，否则 :memory:）",
    "  --help               显示本帮助",
    "",
    "Exit codes: 0 = ok, 1 = rejected/verification failed, 2 = usage or tooling error."
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    workspaceId: undefined,
    period: undefined,
    tzOffset: undefined,
    out: undefined,
    confirm: false,
    dbUrl: undefined,
    help: false
  };
  const valued = new Map([
    ["--workspace-id", "workspaceId"],
    ["--period", "period"],
    ["--tz-offset", "tzOffset"],
    ["--out", "out"],
    ["--db-url", "dbUrl"]
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm") {
      options.confirm = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (valued.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new ExportFailure(`${arg} 需要一个取值`, 2);
      }
      options[valued.get(arg)] = value;
      index += 1;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const eq = arg.indexOf("=");
      const key = arg.slice(0, eq);
      if (!valued.has(key)) {
        throw new ExportFailure(`未知参数：${arg}\n${usageText()}`, 2);
      }
      options[valued.get(key)] = arg.slice(eq + 1);
    } else {
      throw new ExportFailure(`未知参数：${arg}\n${usageText()}`, 2);
    }
  }
  return options;
}

/** 隐藏 URL 中的凭据（user:pass@），避免日志泄露（与 seed-registry 脚本一致）。 */
function sanitizeDbUrl(url) {
  return url.replace(/\/\/([^@/]+)@/, "//***@");
}

/** 分钟偏移 → "UTC+08:00" 日志标签（东为正）。 */
function formatTzOffsetLabel(offsetMinutes) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `UTC${sign}${hh}:${mm}`;
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
  const packages = ["packages/db", "apps/control-plane"];
  const stale = [];
  for (const packageDir of packages) {
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
        "并务必用 dry-run 核对导出内容。"
    );
  }
}

async function loadModules() {
  const dist = {
    controlPlane: join(P0_ROOT, "apps/control-plane/dist/index.js"),
    monthlyArchive: join(P0_ROOT, "apps/control-plane/dist/monthly-archive.js"),
    db: join(P0_ROOT, "packages/db/dist/index.js")
  };
  for (const [name, file] of Object.entries(dist)) {
    if (!existsSync(file)) {
      throw new ExportFailure(
        `${name} 编译产物缺失：${relative(P0_ROOT, file)}；先运行 \`npm run typecheck\`（tsc -b 刷新 dist）或 \`npm run build\``,
        2
      );
    }
  }

  let controlPlane;
  let monthlyArchive;
  let dbModule;
  try {
    [controlPlane, monthlyArchive, dbModule] = await Promise.all([
      import(pathToFileURL(dist.controlPlane).href),
      import(pathToFileURL(dist.monthlyArchive).href),
      import(pathToFileURL(dist.db).href)
    ]);
  } catch (error) {
    throw new ExportFailure(
      `无法加载编译产物（先运行 \`npm run typecheck\`）：${error instanceof Error ? error.message : String(error)}`,
      2
    );
  }

  if (typeof controlPlane.ControlPlaneService?.prototype?.aggregateMonthlyArchive !== "function") {
    throw new ExportFailure(
      "control-plane dist 缺少 aggregateMonthlyArchive（产物过旧）；请先 `npm run typecheck`",
      2
    );
  }
  if (typeof monthlyArchive.assertArchivePeriod !== "function") {
    throw new ExportFailure(
      "control-plane dist 缺少 monthly-archive.assertArchivePeriod（产物过旧）；请先 `npm run typecheck`",
      2
    );
  }
  if (typeof dbModule.createDb !== "function" || typeof dbModule.closeDatabase !== "function") {
    throw new ExportFailure("db dist 缺少 createDb/closeDatabase", 2);
  }
  return {
    ControlPlaneService: controlPlane.ControlPlaneService,
    assertArchivePeriod: monthlyArchive.assertArchivePeriod,
    dbModule
  };
}

function summarizeArchive(archive) {
  const totals = archive.totals;
  log(
    `workspace=${archive.workspaceId} period=${archive.period} generatedAt=${archive.generatedAt}`
  );
  log(
    `totals: runs=${totals.runs} degradedRuns=${totals.degradedRuns} workItems=${totals.workItems} ` +
      `approvals=${totals.approvals} artifacts=${totals.artifacts} memoryRecords=${totals.memoryRecords} ` +
      `auditEvents=${totals.auditEvents}`
  );
  const runIds = archive.runs.map((bundle) => bundle.run.runId);
  const preview = runIds.slice(0, RUN_IDS_PREVIEW_LIMIT).join(", ");
  const suffix =
    runIds.length > RUN_IDS_PREVIEW_LIMIT ? ` … (+${runIds.length - RUN_IDS_PREVIEW_LIMIT} more)` : "";
  log(`runIds(${runIds.length}): ${preview}${suffix}`);
}

function writeArchiveFile(filePath, archive) {
  if (existsSync(filePath)) {
    throw new ExportFailure(`输出文件已存在，拒绝覆盖（fail-closed）：${filePath}`, 1);
  }
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    throw new ExportFailure(`输出目录不存在：${parent}（请先创建）`, 2);
  }
  const json = `${JSON.stringify(archive, null, 2)}\n`;
  writeFileSync(filePath, json, "utf8");
  log(`已写入 ${filePath}（${Buffer.byteLength(json, "utf8")} bytes）`);
}

function verifyReadBack(filePath, archive) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new ExportFailure(
      `回读失败（JSON 不可解析）：${error instanceof Error ? error.message : String(error)}`,
      1
    );
  }
  const checks = [
    ["workspaceId", parsed.workspaceId === archive.workspaceId],
    ["period", parsed.period === archive.period],
    ["totals.runs", parsed.totals?.runs === archive.totals.runs],
    ["totals.auditEvents", parsed.totals?.auditEvents === archive.totals.auditEvents],
    ["runs.length", Array.isArray(parsed.runs) && parsed.runs.length === archive.runs.length]
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    throw new ExportFailure(`回读校验失败：${failed.join(", ")} 与聚合结果不一致`, 1);
  }
  log("回读校验通过：workspaceId / period / totals / runs.length 与聚合结果一致");
}

async function run(options) {
  if (!options.workspaceId) {
    throw new ExportFailure(`--workspace-id 必填\n${usageText()}`, 2);
  }
  if (!options.period) {
    throw new ExportFailure(`--period 必填\n${usageText()}`, 2);
  }
  if (options.confirm && !options.out) {
    throw new ExportFailure("--confirm 需要与 --out 同用（默认 dry-run 不写文件）", 2);
  }

  const { ControlPlaneService, assertArchivePeriod, dbModule } = await loadModules();
  checkDistFreshness();

  let period;
  try {
    period = assertArchivePeriod(options.period);
  } catch (error) {
    throw new ExportFailure(error instanceof Error ? error.message : String(error), 2);
  }

  const tzOffsetRaw = options.tzOffset ?? "480";
  const tzOffsetMinutes = Number(tzOffsetRaw);
  if (!Number.isInteger(tzOffsetMinutes) || tzOffsetMinutes < -720 || tzOffsetMinutes > 840) {
    throw new ExportFailure(
      `--tz-offset 须为 -720..840 的整数分钟数（东为正；默认 480 = +08:00）：${tzOffsetRaw}`,
      2
    );
  }

  const dbUrl = options.dbUrl ?? process.env.DATABASE_URL ?? ":memory:";
  log(
    options.confirm
      ? `MODE: --confirm（写 ${resolve(process.cwd(), options.out)}）`
      : "MODE: dry-run（默认；写文件需 --out + --confirm）"
  );
  log(
    `业务月界 tz-offset=${tzOffsetMinutes} 分钟（${formatTzOffsetLabel(tzOffsetMinutes)}；默认 480=+08:00）`
  );
  log(
    `db: ${sanitizeDbUrl(dbUrl)}` +
      (dbUrl === ":memory:" ? "（PGlite 内存库，进程退出即弃；无数据时导出为空档案）" : "")
  );

  const db = await dbModule.createDb({ url: dbUrl });
  try {
    const service = await ControlPlaneService.create(undefined, db);

    let archive;
    try {
      archive = await service.aggregateMonthlyArchive(
        options.workspaceId,
        period,
        tzOffsetMinutes
      );
    } catch (error) {
      if (error && typeof error === "object" && error.code === "WORKSPACE_NOT_FOUND") {
        throw new ExportFailure(
          `workspace 不存在，拒绝导出（fail-closed）：${options.workspaceId}`,
          1
        );
      }
      throw error;
    }
    summarizeArchive(archive);

    if (!options.confirm) {
      if (options.out) {
        log(`DRY-RUN：将写入 ${resolve(process.cwd(), options.out)}（加 --confirm 才写）`);
      }
      log("DRY-RUN 完成：未写入任何文件");
      return 0;
    }

    const outPath = resolve(process.cwd(), options.out);
    writeArchiveFile(outPath, archive);
    verifyReadBack(outPath, archive);
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
  if (error instanceof ExportFailure) {
    console.error(`[${SCRIPT_NAME}] ERROR: ${error.message}`);
    process.exitCode = error.exitCode;
  } else {
    console.error(
      `[${SCRIPT_NAME}] ERROR: ${error instanceof Error ? error.stack : String(error)}`
    );
    process.exitCode = 2;
  }
}
