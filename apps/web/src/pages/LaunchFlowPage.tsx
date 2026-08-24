import { useCallback, useEffect, useMemo, useState } from "react";

import { createRun, listTemplates } from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Badge } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";
import type { TemplateType } from "../types.js";

type StepKind = "intent" | "audience" | "channels" | "product" | "confirm";

interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  text?: string;
  choices?: string[];
  multi?: boolean;
  step?: StepKind;
}

const AUDIENCE_OPTIONS = [
  "本地周边 3 公里",
  "新手妈妈 / 宝爸",
  "年轻白领女性",
  "线上全国客户",
  "企业 / B 端客户"
];

const CHANNEL_OPTIONS = ["小红书", "公众号", "企微私域", "抖音", "email"];

const PRODUCT_BY_INTENT: Record<TemplateType, string[]> = {
  content_acquisition: ["开业宣传", "种草笔记", "活动推广"],
  private_conversion: ["新品促单", "沉睡客户唤醒", "活动邀约"],
  weekly_review: ["本周复盘"]
};

const INTENT_KEYWORDS: Array<{ type: TemplateType; re: RegExp }> = [
  { type: "weekly_review", re: /(复盘|周报|周度|总结数据|review|weekly)/ },
  { type: "private_conversion", re: /(转化|私域|成交|逼单|唤醒|邀约|conversion|dm)/ },
  { type: "content_acquisition", re: /(写|内容|笔记|文章|种草|获客|开业|宣传|content|post)/ }
];

function detectIntent(query: string): TemplateType {
  for (const rule of INTENT_KEYWORDS) {
    if (rule.re.test(query)) return rule.type;
  }
  return "content_acquisition";
}

/**
 * J2-C 智能匹配:目标文本 × 全量智能体(内置+定制)关键词重合度排序。
 * 定制智能体命中度更高时优先生效,实现"最佳工作流适配"。
 */
function useSmartAgentPick(query: string | undefined) {
  const [catalog, setCatalog] = useState<Array<{ type: string; name: string; description?: string }>>([]);
  const [picked, setPicked] = useState<TemplateType | null>(null);
  const [pickedName, setPickedName] = useState<string | null>(null);

  useEffect(() => {
    listTemplates()
      .then((items) => {
        const list = items as Array<{ type: string; name: string; description?: string }>;
        setCatalog(list);
        if (!query) return;
        const q = query.toLowerCase();
        let best: { type: string; score: number } | null = null;
        for (const item of list) {
          const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase();
          let score = 0;
          for (const word of q.split(/[\s,，。.;；]+/).filter(Boolean)) {
            if (haystack.includes(word) || haystack.includes(word.slice(0, Math.min(4, word.length)))) {
              score += 2;
            }
          }
          if (item.type === detectIntent(query)) score += 3; // 内置意图保底
          if (!best || score > best.score) best = { type: item.type, score };
        }
        if (best) {
          const match = list.find((item) => item.type === best!.type);
          setPicked((match?.type ?? null) as TemplateType | null);
          setPickedName(match?.name ?? null);
        }
      })
      .catch(() => {
        // catalog optional — fallback to regex intent only
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  return { catalog, picked, pickedName };
}

let messageId = 0;
const nextId = () => ++messageId;

export function LaunchFlowPage(props: {
  initialQuery?: string;
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onLaunched: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [freeText, setFreeText] = useState(props.initialQuery ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [step, setStep] = useState<StepKind>("intent");
  const [intent, setIntent] = useState<TemplateType | null>(null);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const smart = useSmartAgentPick(props.initialQuery);

  // 智能匹配置顶:若定制智能体胜出,覆盖正则意图
  useEffect(() => {
    if (smart.picked) {
      setIntent((current) => current ?? null);
      setIntent(smart.picked as TemplateType);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [smart.picked]);

  const pushAssistant = useCallback((text: string, choices: string[] | undefined, kind: StepKind, multi = false) => {
    setMessages((current) => [...current, { id: nextId(), role: "assistant", text, choices, step: kind, multi }]);
  }, []);

  const startWithQuery = useCallback(
    (query: string) => {
      const detected = detectIntent(query);
      setIntent(detected);
      setAnswers((current) => ({ ...current, goal: [query] }));
      setMessages([
        { id: nextId(), role: "user", text: query },
        {
          id: nextId(),
          role: "assistant",
          text: t("launch.ack." + detected),
          step: "intent"
        }
      ]);
      setSelected([]);
      setStep("audience");
      pushAssistant(t("launch.ask.audience"), AUDIENCE_OPTIONS, "audience");
    },
    [pushAssistant, t]
  );

  // Seed the conversation once on mount.
  useEffect(() => {
    const query = props.initialQuery?.trim();
    if (query) {
      window.sessionStorage.removeItem("neuroclaw.launchQuery");
      startWithQuery(query);
    } else {
      setStep("intent");
      pushAssistant(t("launch.welcome"), undefined, "intent");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleChoice = (choice: string, multi: boolean) => {
    if (!multi) {
      setSelected([choice]);
      return;
    }
    setSelected((current) =>
      current.includes(choice)
        ? current.filter((item) => item !== choice)
        : [...current, choice]
    );
  };

  const advance = () => {
    const answer = [...selected];
    if (answer.length === 0) return;

    setMessages((current) => [
      ...current,
      { id: nextId(), role: "user", text: answer.join("、") }
    ]);
    const nextAnswers = { ...answers, [step]: answer };
    setAnswers(nextAnswers);
    setSelected([]);

    if (step === "audience") {
      setStep("channels");
      pushAssistant(t("launch.ask.channels"), CHANNEL_OPTIONS, "channels", true);
      return;
    }

    if (step === "channels") {
      setStep("product");
      pushAssistant(t("launch.ask.product"), PRODUCT_BY_INTENT[intent ?? "content_acquisition"], "product");
      return;
    }

    if (step === "product") {
      setStep("confirm");
      pushAssistant(t("launch.ask.confirm"), undefined, "confirm");
    }
  };

  const summaryChips = useMemo(
    () => [
      ...(answers.goal ?? []),
      ...(answers.audience ?? []),
      ...(answers.channels ?? []),
      ...(answers.product ?? [])
    ],
    [answers]
  );

  const launch = async () => {
    if (!intent) return;
    setError(null);
    setLaunching(true);
    try {
      const run = (await createRun({
        workspaceId: props.workspaceId,
        templateType: intent,
        input: {
          businessSummary: (answers.goal ?? []).join("; "),
          targetCustomer: (answers.audience ?? []).join(", "),
          preferredChannels: answers.channels ?? [],
          ...(intent === "content_acquisition"
            ? { contentGoal: (answers.product ?? []).join(", ") || "growth content" }
            : intent === "private_conversion"
              ? { offerAsset: (answers.product ?? []).join(", ") || "limited offer" }
              : { metricsWindowDays: 7 })
        }
      })) as { id: string };
      props.onLaunched(run.id);
    } catch (launchError) {
      if (isWorkspaceMissingError(launchError)) {
        props.onWorkspaceMissing(t("setup.workspaceExpired"));
        return;
      }
      setError(launchError instanceof Error ? launchError.message : t("status.loadError"));
    } finally {
      setLaunching(false);
    }
  };

  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");

  return (
    <RouteLayout title={t("launch.title")} subtitle={t("launch.subtitle")}>
      <Card className="p-0 overflow-hidden">
        {/* 消息流 */}
        <div className="p-5 grid gap-4 max-h-[52vh] overflow-y-auto">
          {messages.map((message) =>
            message.role === "user" ? (
              <div key={message.id} className="flex justify-end">
                <div className="max-w-[80%] bg-gradient-to-br from-brand to-brand-dark text-white rounded-[16px_4px_16px_16px] px-4 py-2.5 text-[14.5px] shadow-sm">
                  {message.text}
                </div>
              </div>
            ) : (
              <div key={message.id} className="flex gap-2.5 items-start">
                <span className="chat-avatar" aria-hidden="true">🤖</span>
                <div className="grid gap-2.5 max-w-[85%]">
                  {message.text && (
                    <div className="chat-bubble-in">{message.text}</div>
                  )}
                  {message.choices && message.step !== "confirm" && (
                    <div className="flex flex-wrap gap-2 pl-1">
                      {message.choices.map((choice) => {
                        const active = selected.includes(choice);
                        return (
                          <button
                            key={choice}
                            type="button"
                            onClick={() => toggleChoice(choice, !!message.multi)}
                            aria-pressed={active}
                            className={`text-[13.5px] font-medium rounded-pill px-4 py-2 border cursor-pointer transition-all ${
                              active
                                ? "border-brand bg-brand-light text-brand shadow-[0_4px_12px_rgba(189,79,34,0.18)]"
                                : "border-line-strong bg-white text-ink hover:border-brand/50"
                            }`}
                          >
                            {active ? "✓ " : ""}
                            {choice}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            )
          )}

          {/* 确认摘要卡 */}
          {step === "confirm" && (
            <div className="flex gap-2.5 items-start">
              <span className="chat-avatar" aria-hidden="true">🤖</span>
              <Card className="p-4 max-w-[85%] grid gap-3">
                <Badge variant="default">
                  {smart.pickedName ?? (intent ? t(`templates.names.${intent}`) : intent)}
                </Badge>
                <div className="flex flex-wrap gap-1.5">
                  {summaryChips.map((chip) => (
                    <span
                      key={chip}
                      className="text-[12.5px] font-medium bg-surface-strong rounded-pill px-2.5 py-1"
                    >
                      {chip}
                    </span>
                  ))}
                </div>
                <Button onClick={() => void launch()} disabled={launching} size="lg">
                  {launching ? t("setup.launching") : `${t("home.launch.button")} 🚀`}
                </Button>
              </Card>
            </div>
          )}
        </div>

        {/* 底部操作区 */}
        <div className="border-t hairline p-4 bg-white/70 grid gap-2.5">
          <ErrorBanner error={error} />
          {step === "intent" && !props.initialQuery && (
            <div className="flex gap-2.5 flex-wrap sm:flex-nowrap">
              <input
                value={freeText}
                onChange={(event) => setFreeText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && freeText.trim()) startWithQuery(freeText.trim());
                }}
                placeholder={t("home.launch.placeholder")}
                aria-label={t("home.launch.placeholder")}
                className="flex-1 min-w-[220px] border border-line bg-surface-strong/40 rounded-pill px-5 py-3 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand placeholder:text-muted/70"
              />
              <Button size="lg" className="shrink-0" onClick={() => freeText.trim() && startWithQuery(freeText.trim())}>
                ✦
              </Button>
            </div>
          )}
          {(step === "audience" || step === "channels" || step === "product") && (
            <Button
              size="lg"
              disabled={selected.length === 0}
              onClick={advance}
              className="w-full"
              aria-label={t("launch.confirmChoice")}
            >
              {t("launch.confirmChoice")} ({selected.length})
            </Button>
          )}
          {step === "confirm" && lastAssistant && (
            <Button variant="ghost" onClick={() => { setStep("intent"); setIntent(null); setAnswers({}); setMessages([]); pushAssistant(t("launch.welcome"), undefined, "intent"); }}>
              ↺ {t("launch.restart")}
            </Button>
          )}
        </div>
      </Card>
    </RouteLayout>
  );
}
