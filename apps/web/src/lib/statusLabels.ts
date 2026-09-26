import type { Locale } from "./i18n.js";

const ZH_STATUS_LABELS: Record<string, string> = {
  draft: "草稿",
  queued: "排队中",
  running: "执行中",
  waiting_approval: "待审批",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消"
};

/**
 * Human-facing run status label (audit P0-E2 工程师语言泄漏修复)。
 * zh-CN → 中文标签;其他 locale 保持原枚举(E2E 断言依赖原文)。
 */
export function formatRunStatus(status: string, locale: Locale | string): string {
  if (locale === "zh-CN") {
    return ZH_STATUS_LABELS[status] ?? status;
  }
  return status;
}
