#!/usr/bin/env node
// 发布 @neuroclaw/shared 的发布产物（tarball），供 p1-venture-os 以 file: 依赖消费。
//
// 设计约束（D6 / P0-1 方案 b）：
//   - p0 源码零改动：本脚本只读 p0 的 packages/shared，不写 p0 任何文件；
//   - 发布产物落在 p1-venture-os/_vendor/（p1 的写集内），保证可复现、可回滚；
//   - 发布前校验 dist 入口存在且非空，并断言 tarball 内确实含 dist/，
//     避免发布「缺 dist 的空壳产物」导致消费方 import 失败（防静默假绿）。
//
// 【p0 发布缺陷修复（R2/R3）】
//   R2：`npm pack --workspace @neuroclaw/shared` 曾产出**不含 dist/** 的 tarball ——
//       packages/shared 自身无 .npmignore/files，npm 因而继承 p0-growth-v1/.gitignore
//       的 `dist/` 规则。已在 packages/shared/package.json 补 `files: ["dist","src",...]`
//       （files 白名单优先于 .gitignore），p0 自然 pack 产物现含 dist（实测 60 条）。
//   R3：tarball package.json 未声明运行时依赖 `zod`，而 dist 首行 `import { z } from "zod"`
//       → 清单不自洽。已补 `dependencies: { "zod": "^4.1.5" }`。
//   因此本脚本不再使用「暂存目录 pack」规避，直接对 p0 包自身打包 ——
//   产物即 p0 的真实发布产物，与源码无漂移。
//
// 用法：node p0-growth-v1/scripts/pack-shared.mjs

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const p0Root = resolve(here, "..");
const repoRoot = resolve(p0Root, "..");
const sharedDir = resolve(p0Root, "packages/shared");
const vendorDir = resolve(repoRoot, "p1-venture-os/_vendor");

function fail(msg) {
  console.error(`[pack-shared] ERROR: ${msg}`);
  process.exit(2);
}

const pkg = JSON.parse(readFileSync(join(sharedDir, "package.json"), "utf8"));
if (!pkg.name || !pkg.version) fail("packages/shared/package.json 缺少 name/version");

// --- 0. 发布清单自洽性前置校验（R2/R3 回归守卫）---
if (!Array.isArray(pkg.files) || !pkg.files.includes("dist")) {
  fail("packages/shared/package.json 缺少 files 白名单（须含 dist），否则 pack 产物将不含 dist");
}
if (!pkg.dependencies?.zod) {
  fail("packages/shared/package.json 未声明运行时依赖 zod（dist 首行 import { z } from \"zod\"）");
}

// --- 1. 发布产物前置校验：dist 必须存在且非空 ---
for (const rel of [pkg.main ?? "./dist/index.js", pkg.types ?? "./dist/index.d.ts"]) {
  const entry = resolve(sharedDir, rel);
  if (!existsSync(entry)) fail(`发布产物缺失：${relative(repoRoot, entry)}（请先构建 p0 shared）`);
  if (statSync(entry).size === 0) fail(`发布产物为空文件：${relative(repoRoot, entry)}`);
}

// --- 2. 清理旧产物 ---
mkdirSync(vendorDir, { recursive: true });
const tarballPrefix = pkg.name.replace(/^@/, "").replace(/\//, "-");
for (const f of readdirSync(vendorDir)) {
  if (f.startsWith(`${tarballPrefix}-`) && f.endsWith(".tgz")) {
    rmSync(join(vendorDir, f));
    console.log(`[pack-shared] 清理旧产物 ${relative(repoRoot, join(vendorDir, f))}`);
  }
}

// --- 3. 打包：直接对 p0 包自身 pack（不再走暂存目录规避）---
execFileSync("npm", ["pack", sharedDir, "--pack-destination", vendorDir], {
  cwd: p0Root,
  stdio: "inherit",
});

const produced = readdirSync(vendorDir).filter(
  (f) => f.startsWith(`${tarballPrefix}-`) && f.endsWith(".tgz"),
);
if (produced.length !== 1) fail(`期望产出 1 个 tarball，实际 ${produced.length}`);

// --- 4. 产物断言：tarball 必须含 dist 入口，否则视为空壳产物 ---
const tarball = join(vendorDir, produced[0]);
const listing = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" }).split("\n");
for (const required of ["package/package.json", "package/dist/index.js", "package/dist/index.d.ts"]) {
  if (!listing.includes(required)) fail(`产物缺少必需条目 ${required}：${relative(repoRoot, tarball)}`);
}
// 清单数据须随产物发布：pilot 清单经 ../src/manifests 回退路径读取
const manifestEntry = "package/src/manifests/pilot-projects.json";
if (!listing.includes(manifestEntry)) fail(`产物缺少清单数据 ${manifestEntry}`);

// --- 5. 清单自洽断言：产物内 package.json 须声明 zod（R3）---
const packedPkg = JSON.parse(
  execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf8" }),
);
if (!packedPkg.dependencies?.zod) {
  fail("产物 package.json 未声明 zod 依赖，作为可发布包清单不自洽（R3 回归）");
}

const sha256 = createHash("sha256").update(readFileSync(tarball)).digest("hex");
console.log(`[pack-shared] 产物：${relative(repoRoot, tarball)}`);
console.log(`[pack-shared] sha256：${sha256}`);
console.log(`[pack-shared] dist 条目数：${listing.filter((l) => l.startsWith("package/dist/")).length}`);
console.log(`[pack-shared] 声明依赖：${JSON.stringify(packedPkg.dependencies)}`);
console.log(`[pack-shared] 依赖写法："${pkg.name}": "file:_vendor/${produced[0]}"`);
