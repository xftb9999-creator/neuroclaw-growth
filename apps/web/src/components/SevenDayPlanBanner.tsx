import { useMemo } from "react";

import { useI18n } from "../lib/i18n.js";
import { navigate } from "../lib/router.js";
import { Button } from "./ui/Button.js";
import type { RunRecord } from "../types.js";

const DAY_MS = 86_400_000;
const CREATED_AT_KEY = "neuroclaw.workspaceCreatedAt";

/**
 * 「我的 7 天计划」横幅(Round L, audit P0-E1):
 * 把「7 天见效」承诺产品化——Day N 进度 + 今日待办 + 快捷入口。
 * 静态里程碑 v1;后续接入渠道数据后升级为动态验收。
 */
export function SevenDayPlanBanner(props: { runs: RunRecord[] }) {
  const { t } = useI18n();

  const startedAt = useMemo(() => {
    const stored = (() => {
      try {
        return window.localStorage.getItem(CREATED_AT_KEY);
      } catch {
        return null;
      }
    })();
    if (stored && Number.isFinite(Date.parse(stored))) return stored;

    const earliest = props.runs
      .map((run) => run.createdAt ?? "")
      .filter(Boolean)
      .sort()
      .at(0);
    return earliest && Number.isFinite(Date.parse(earliest)) ? earliest : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.runs.length]);

  const state = useMemo(() => {
    if (!startedAt) {
      return { day: 0, progress: 0, finished: false };
    }
    const elapsed = Date.now() - Date.parse(startedAt);
    const dayIndex = Math.floor(elapsed / DAY_MS);
    if (elapsed < 0) return { day: 1, progress: 0, finished: false };
    if (dayIndex >= 7) return { day: 7, progress: 100, finished: true };
    return {
      day: Math.min(7, Math.max(1, dayIndex + 1)),
      progress: Math.round((Math.min(7, dayIndex + 1) / 7) * 100),
      finished: false
    };
  }, [startedAt]);

  const hasRuns = props.runs.length > 0;

  return (
    <section
      data-testid="seven-day-plan"
      aria-label={t("plan.banner.title")}
      className="rounded-card border hairline bg-white shadow-sm p-5 grid gap-3"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span
          aria-hidden="true"
          className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-brand-light text-brand text-[15px] font-bold"
        >
          7
        </span>
        <h2 className="text-[16.5px] font-bold m-0">{t("plan.banner.title")}</h2>
        {!state.finished && startedAt && (
          <span className="text-[12.5px] text-muted">
            {t("plan.banner.dayLabel", { day: state.day })}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2">
          {!hasRuns && (
            <Button size="sm" onClick={() => navigate("/launch")}>
              {t("plan.banner.startCta")}
            </Button>
          )}
          {hasRuns && (
            <Button size="sm" variant="outline" onClick={() => navigate("/history")}>
              {t("plan.banner.viewHistory")}
            </Button>
          )}
        </div>
      </div>

      {/* 进度条 */}
      <div
        role="progressbar"
        aria-label={t("plan.banner.progressAria")}
        aria-valuenow={state.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-2 rounded-pill bg-surface-strong overflow-hidden"
      >
        <div
          className="h-full rounded-pill bg-gradient-to-r from-brand to-brand-dark transition-all duration-500"
          style={{ width: `${Math.max(4, state.progress)}%` }}
        />
      </div>

      {/* 今日待办 */}
      <p className="m-0 text-[14px]">
        {state.finished ? (
          <span className="text-ok font-medium">✓ {t("plan.banner.finished")}</span>
        ) : (
          <>
            <span className="text-muted mr-1.5">{t("plan.banner.todoLabel")}:</span>
            <span className="font-medium">{t(`plan.banner.todo.${state.day}`)}</span>
          </>
        )}
      </p>
    </section>
  );
}
