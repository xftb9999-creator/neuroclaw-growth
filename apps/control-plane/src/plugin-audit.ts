/**
 * P2-3 · control-plane 侧插件审计落盘适配器。
 *
 * 口径（与 packages/plugin-host/src/plugin-audit.ts 头注同一判据源）：
 * - 审计通道＝现有 `audit_events` 表（schema.ts:220），零新表、零新迁移；
 * - 身份打标：metadata 同时写 `pluginId`（文档别名）与 `pluginKey`（契约字段），
 *   resourceType='plugin'，action=事件码（plugin.registered/loaded/enabled/
 *   disabled/denied/rolled_back），createdAt=事件发生时刻（occurredAt，宿主时钟）；
 * - 唯一生产接线点：app.ts 挂载 `bootstrapPluginHost({ ...resolvePluginHostConfig(),
 *   auditSink: createPluginAuditSink(service.db) })`；
 * - 读侧检索面：`listPluginAuditEvents`（apps/control-plane/src/index.ts）。
 *
 * 故障语义：insert 失败向上抛出；宿主 emitPluginAudit 捕获后降级为 warn 日志
 * （审计永不反噬插件生命周期；与 middleware/audit.ts「audit logging should never
 * break the response」同口径）。本适配器不自行吞错，保留可观测性。
 */
import { randomUUID } from "node:crypto";

import { type Database, auditEvents } from "@neuroclaw/db";
import type { PluginAuditEvent, PluginAuditSink } from "@neuroclaw/plugin-host";

/** 创建插件审计 sink：事件 → `audit_events` 行（resourceType='plugin'）。 */
export function createPluginAuditSink(db: Database): PluginAuditSink {
  return async (event: PluginAuditEvent): Promise<void> => {
    const row: typeof auditEvents.$inferInsert = {
      id: `plugin_audit_${randomUUID()}`,
      workspaceId: null,
      actorId: "plugin-host",
      action: event.eventType,
      resourceType: "plugin",
      resourceId: event.pluginKey,
      metadata: JSON.stringify({
        pluginId: event.pluginKey,
        pluginKey: event.pluginKey,
        pluginVersion: event.pluginVersion,
        occurredAt: event.occurredAt,
        ...(event.code ? { code: event.code } : {}),
        ...(event.detail ? { detail: event.detail } : {})
      }),
      createdAt: event.occurredAt
    };
    await db.insert(auditEvents).values(row);
  };
}
