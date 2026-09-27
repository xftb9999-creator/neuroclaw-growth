/**
 * @neuroclaw/plugin-host · barrel（P2-1 装载器 + P2-2 能力句柄）。
 * PluginHost：扫描 → 集合校验（P1-2 门）→ 注册（enabled=false）→ 显式激活
 * （单件门 → 能力授予门 → 动态 import → 能力句柄发放 → 生命周期钩子）。
 * 设计语义与安全边界详见 ./plugin-host.ts 与 ./capability-handle.ts 头注。
 */
export * from "./plugin-host.js";
export * from "./capability-handle.js";
export * from "./plugin-audit.js";
