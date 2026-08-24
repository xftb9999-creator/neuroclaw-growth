import { useMemo } from "react";

import { useI18n } from "../../lib/i18n.js";

/**
 * 内容员工富渲染:把 outputPayload.contentAngles 渲染成
 * 小红书/公众号风格的图文笔记卡片,附标题力评分与话题标签。
 */
export function ContentNoteCard(props: {
  payload: Record<string, unknown>;
  input: Record<string, unknown>;
}) {
  const { t } = useI18n();
  const angles = Array.isArray(props.payload.contentAngles)
    ? (props.payload.contentAngles as string[])
    : [];
  const channels = Array.isArray(props.payload.channelRecommendations)
    ? (props.payload.channelRecommendations as string[])
    : [];

  const audience = String(props.input.targetCustomer ?? "");
  const business = String(props.input.businessSummary ?? "");

  const hashtags = useMemo(() => {
    const seeds = [business, audience, ...channels]
      .join(" ")
      .replace(/[，。,.!?！？\s]+/g, " ")
      .split(" ")
      .map((word) => word.trim())
      .filter((word) => word.length >= 2 && word.length <= 12);
    return Array.from(new Set(seeds)).slice(0, 6).map((word) => `#${word}`);
  }, [business, audience, channels]);

  const titleScore = useMemo(() => {
    // 轻量启发式:长度适中 + 含数字/情绪词加分
    return angles.map((angle) => {
      let score = 55;
      const length = angle.length;
      if (length >= 10 && length <= 24) score += 18;
      if (/\d/.test(angle)) score += 12;
      if (/!|！|秘|必|绝|爆|干货|免费|攻略|指南/.test(angle)) score += 15;
      return Math.min(98, score);
    });
  }, [angles]);

  if (angles.length === 0) return null;

  const covers = ["📸", "🎬", "✍️", "🌟", "🧩"];

  return (
    <div className="grid gap-5 md:grid-cols-2">
      {angles.map((angle, index) => (
        <article
          key={`${index}-${angle.slice(0, 8)}`}
          className="glass glass-hover overflow-hidden lift"
        >
          <div
            className="h-28 flex items-end p-4"
            style={{
              background:
                index % 3 === 0
                  ? "linear-gradient(120deg,#ffe3d0,#ffd1b0)"
                  : index % 3 === 1
                    ? "linear-gradient(120deg,#fdeecb,#ffdf9e)"
                    : "linear-gradient(120deg,#e7f3ea,#cdebd8)"
            }}
          >
            <span className="text-4xl" aria-hidden="true">
              {covers[index % covers.length]}
            </span>
            <span className="ml-auto text-[11px] font-bold text-white bg-black/35 rounded-pill px-2.5 py-1">
              {t("render.noteTitleScore")} {titleScore[index]}
            </span>
          </div>
          <div className="p-4 grid gap-2.5">
            <h4 className="m-0 font-bold text-[16px] leading-snug tracking-tight">
              {t("render.anglePrefix")} {index + 1} · {angle}
            </h4>
            <p className="text-[13px] text-muted m-0 leading-relaxed">
              {t("render.imageIdea")}:以「{audience || business || "你的客群"}」为主角的生活化场景图,
              首图突出反差或利益点。
            </p>
            <div className="flex flex-wrap gap-1.5">
              {hashtags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="text-[12px] font-medium text-brand bg-brand-light rounded-pill px-2.5 py-0.5"
                >
                  {tag}
                </span>
              ))}
            </div>
            {index === 0 && channels.length > 0 && (
              <div className="pt-1 border-t hairline flex flex-wrap items-center gap-2">
                <span className="text-[12px] text-muted font-semibold">
                  {t("render.channels")}
                </span>
                {channels.map((channel) => (
                  <span
                    key={channel}
                    className="text-[12px] bg-surface-strong rounded-pill px-2.5 py-0.5"
                  >
                    {channel}
                  </span>
                ))}
              </div>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
