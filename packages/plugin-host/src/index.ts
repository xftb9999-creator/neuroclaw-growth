/**
 * @neuroclaw/plugin-host · P2-1 barrel。
 * PluginHost 装载器：扫描 → 集合校验（P1-2 门）→ 注册（enabled=false）→
 * 显式激活（单件门 → 动态 import → 生命周期钩子）。设计语义与安全边界详见
 * ./plugin-host.ts 头注。
 */
export * from "./plugin-host.js";
