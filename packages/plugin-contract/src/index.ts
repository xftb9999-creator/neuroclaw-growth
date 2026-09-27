/**
 * @neuroclaw/plugin-contract · P1-1/P1-2 barrel。
 * PluginManifest 契约（plugin.md §3.1 唯一权威方言；canonical 名自本包起）。
 * 规格来源、复用与边界详见 ./plugin-manifest.ts 头注；
 * 装载前 semver 强制求值（P1-2）见 ./host-compatibility.ts 头注。
 */
export * from "./plugin-manifest.js";
export * from "./host-compatibility.js";
