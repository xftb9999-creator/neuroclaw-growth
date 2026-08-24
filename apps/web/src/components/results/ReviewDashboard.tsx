import { useMemo, useState } from "react";

import { useI18n } from "../../lib/i18n.js";

interface MetricEntry {
  name: string;
  value: string;
  delta?: string;
  direction?: "up" | "down" | "flat";
}

/**
 * 复盘员工富渲染:reviewSummary + nextActions 渲染成
 * 迷你仪表盘(指标趋势 + 可勾选行动清单)。
 */
export function ReviewDashboard(props: {
  payload: Record<string, unknown>;
  input: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const [done, setDone] = useState<Record<number, boolean>>({});

  const summary = String(props.payload.reviewSummary ?? "").trim();
  const actions = Array.isArray(props.payload.nextActions)
    ? (props.payload.nextActions as string[])
    : [];

  const metrics = useMemo<MetricEntry[]>(() => {
    const raw = props.input.metrics;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => {
        const deltaRaw = entry.delta === undefined ? undefined : String(entry.delta);
        let direction: MetricEntry["direction"] = "flat";
        if (deltaRaw) {
          if (/^\+|up|↑|增长|上升/.test(deltaRaw)) direction = "up";
          else if (/^-|down|↓|下降|下滑/.test(deltaRaw)) direction = "down";
        }
        return {
          name: String(entry.name ?? "-"),
          value: String(entry.value ?? "-"),
          delta: deltaRaw,
          direction
        };
      });
  }, [props.input.metrics]);

  const completedCount = actions.filter((_, index) => done[index]).length;
  const allDone = actions.length > 0 && completedCount === actions.length;

  return (
    <div className="grid gap-5">
      {metrics.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {metrics.map((metric) => (
            <div key={metric.name} className="glass p-3.5 lift">
              <div className="text-[12px] font-semibold text-muted">{metric.name}</div>
              <div className="text-2xl font-extrabold tracking-tight mt-1">{metric.value}</div>
              {metric.delta && (
                <div
                  className={`text-[12.5px] font-bold mt-0.5 ${
                    metric.direction === "up"
                      ? "text-ok"
                      : metric.direction === "down"
                        ? "text-danger"
                        : "text-muted"
                  }`}
                >
                  {metric.direction === "up" ? "▲" : metric.direction === "down" ? "▼" : "■"}{" "}
                  {metric.delta}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {summary && (
        <div className="glass p-5">
          <h4 className="m-0 mb-2 text-[13px] font-bold text-brand uppercase tracking-wide">
            {t("render.reviewSummary")}
          </h4>
          <p className="m-0 text-[15px] leading-relaxed">{summary}</p>
        </div>
      )}

      {actions.length > 0 && (
        <div className="glass p-5">
          <div className="flex items-center justify-between mb-3">
            <h4 className="m-0 text-[13px] font-bold text-brand uppercase tracking-wide">
              {t("render.actions")}
            </h4>
            <span
              className={`text-[12px] font-semibold rounded-pill px-2.5 py-1 ${
                allDone ? "bg-ok-light text-ok" : "bg-surface-strong text-muted"
              }`}
            >
              {completedCount}/{actions.length} {t("render.checkAll")}
            </span>
          </div>
          <ul className="m-0 p-0 list-none grid gap-2">
            {actions.map((action, index) => (
              <li key={`${index}-${action.slice(0, 8)}`}>
                <label className="flex items-start gap-3 p-3 rounded-input border hairline bg-white cursor-pointer hover:border-line-strong transition-colors">
                  <input
                    type="checkbox"
                    checked={!!done[index]}
                    onChange={(event) =>
                      setDone((current) => ({ ...current, [index]: event.target.checked }))
                    }
                    className="mt-0.5 w-4 h-4 accent-[var(--color-brand)]"
                  />
                  <span
                    className={`text-[14.5px] leading-snug ${
                      done[index] ? "line-through text-muted/70" : ""
                    }`}
                  >
                    {action}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
