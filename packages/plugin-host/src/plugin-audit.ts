/**
 * P2-3 · 插件级审计事件模型与落盘接缝。
 *
 * 口径来源（先核实后动笔）：
 * - `plugin-roadmap.md:299`（P2-3：装载/启用/禁用/越权拒绝/回滚事件按 `pluginId` 落
 *   审计（复用现有 audit 通道）；验收＝审计记录可查且含 `pluginId`；负向用例产生
 *   拒绝事件）；
 * - `plugin.md §5` 机制 5（审计事件按 `pluginId` 打标：装载、启用、禁用、越权拒绝、
 *   回滚全部落审计）；
 * - `p2-readiness` §1 门禁 5（复用现有 audit 通道；五类事件按 `pluginId` 打标）。
 *
 * 术语对齐（零方言变更）：文档口径的 `pluginId` ＝ 清单身份字段 `pluginKey`
 * （P1-1 冻结方言，`packages/plugin-contract/src/plugin-manifest.ts`）。宿主侧事件
 * 类型使用 `pluginKey`；落盘适配器（apps/control-plane）在审计元数据中同时写入
 * `pluginId`（文档别名）与 `pluginKey`（契约字段）两键，两处引用都可检索。
 *
 * 事件类（文档五类 ↔ 本模块六个事件码）：
 * - 装载 ＝ `registered`（进入宿主 registry，enabled=false）+ `loaded`（动态 import
 *   与 onLoad 完成）；默认零激活部署下 `registered` 仍落审计（可见性），import 不发生；
 * - 启用 ＝ `enabled`；禁用 ＝ `disabled`；
 * - 越权拒绝 ＝ `denied`（装载期门拒绝 ＋ 调用边界越权拒绝，携带明确错误码）；
 * - 回滚 ＝ `rolled_back`（激活失败回滚：import 失败／钩子失败后撤销句柄与状态回退）。
 *   P5-2 升级回滚（`rollbackPlan`）复用同一事件码。
 *
 * 安全语义（硬约束）：
 * 1. **审计不改变门序**：事件发射只发生在门判定之后、抛出之前（或状态落定之后），
 *    绝不先放行后补审计；被门拒绝的路径 `importAttempted` 恒为 false。
 * 2. **审计永不反噬生命周期**：sink 同步抛错或 Promise 拒绝均被捕获并降级为宿主
 *    warn 日志（与 control-plane 既有审计中间件「audit logging should never break
 *    the response」同口径）。
 * 3. **未接线 = 不落审计**：sink 缺省时事件被丢弃；生产接线在 app.ts 唯一挂载点
 *    （`createPluginAuditSink`），落现有 `audit_events` 通道。
 * 4. **无身份不落**：扫描期被拒且无法解析出 `pluginKey` 的文件不产生审计事件
 *    （无 `pluginId` 可打标）；其证据保留在 init 报告与日志中。
 */

/** P2-3 审计事件码（六码覆盖文档五类事件，见头注）。 */
export type PluginAuditEventType =
  | "plugin.registered"
  | "plugin.loaded"
  | "plugin.enabled"
  | "plugin.disabled"
  | "plugin.denied"
  | "plugin.rolled_back";

/** 单个插件审计事件（宿主侧形状；落盘映射见 control-plane 适配器）。 */
export interface PluginAuditEvent {
  eventType: PluginAuditEventType;
  /** 插件身份（文档口径 `pluginId` ＝ 契约 `pluginKey`）。 */
  pluginKey: string;
  pluginVersion: string | null;
  /** 事件发生时刻（宿主时钟，ISO-8601 UTC）。 */
  occurredAt: string;
  /** 拒绝/回滚的明确错误码（成功类事件缺省）。 */
  code?: string;
  /** 附加证据（stage/file/operation/scope/cause 等，JSON 可序列化）。 */
  detail?: Record<string, unknown>;
}

/**
 * 审计落盘接缝。返回 Promise 时宿主不等待（fire-and-forget），拒绝会被捕获降级为
 * warn 日志；实现方无需自行吞错（但自行吞错亦不违反语义）。
 */
export type PluginAuditSink = (event: PluginAuditEvent) => void | Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 安全发射：sink 缺省＝丢弃；同步抛错／异步拒绝均走 `onError`（永不向生命周期抛错）。
 */
export function emitPluginAudit(
  sink: PluginAuditSink | undefined,
  event: PluginAuditEvent,
  onError?: (message: string) => void
): void {
  if (!sink) return;
  try {
    const outcome = sink(event);
    if (outcome && typeof (outcome as Promise<void>).then === "function") {
      void (outcome as Promise<void>).catch((error) => {
        onError?.(errorMessage(error));
      });
    }
  } catch (error) {
    onError?.(errorMessage(error));
  }
}
