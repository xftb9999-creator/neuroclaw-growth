import { useCallback, useEffect, useMemo, useState } from "react";

import {
  deleteKnowledgeEntry,
  listKnowledgeEntries,
  smartAddKnowledge,
  type KnowledgeRecord
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import {
  isVoiceInputSupported,
  startListening,
  type SpeechLang
} from "../lib/speech.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";

type KnowledgeGroup = "manual" | "run" | "ai";

const GROUP_META: Record<KnowledgeGroup, { icon: string; tint: string }> = {
  manual: { icon: "📌", tint: "bg-brand-light text-brand" },
  run: { icon: "🤖", tint: "bg-[#e9f6ee] text-ok" },
  ai: { icon: "✨", tint: "bg-[#f0ecff] text-[#6d5bd0]" }
};

function groupBadgeVariant(group: KnowledgeGroup): "default" | "completed" | "info" {
  if (group === "run") return "completed";
  if (group === "ai") return "info";
  return "default";
}

function groupOf(entry: KnowledgeRecord): KnowledgeGroup {
  if (entry.source === "run") return "run";
  if (entry.source === "ai") return "ai";
  return "manual";
}

export function KnowledgePage(props: { workspaceId: string }) {
  const { t, locale } = useI18n();
  const [entries, setEntries] = useState<KnowledgeRecord[]>([]);
  const [capture, setCapture] = useState("");
  const [savingCapture, setSavingCapture] = useState(false);
  const [lastAdded, setLastAdded] = useState<string | null>(null);
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listening, setListening] = useState(false);
  const voiceSupported = useMemo(() => isVoiceInputSupported(), []);

  const load = useCallback(async () => {
    try {
      const items = (await listKnowledgeEntries(props.workspaceId)) as KnowledgeRecord[];
      setEntries(items);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const submitCapture = async () => {
    const text = capture.trim();
    if (!text) return;
    setSavingCapture(true);
    setError(null);
    try {
      const created = await smartAddKnowledge({ workspaceId: props.workspaceId, text });
      setLastAdded(created.title);
      setCapture("");
      window.setTimeout(() => setLastAdded(null), 2600);
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("history.loadError"));
    } finally {
      setSavingCapture(false);
    }
  };

  const toggleMic = () => {
    if (listening) {
      setListening(false);
      return;
    }
    const lang: SpeechLang = locale === "zh-CN" ? "zh-CN" : "en-US";
    const session = startListening({
      lang,
      onInterim: (text) => setCapture((current) => `${current}${text}`),
      onFinalChunk: (text) => setCapture((current) => `${current}${text}`),
      onEnd: () => setListening(false)
    });
    if (session) {
      setListening(true);
      window.setTimeout(() => {
        session.stop();
        setListening(false);
        void submitCapture();
      }, 8000);
    }
  };

  const tagCloud = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of entries) {
      for (const tag of entry.tags) {
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  }, [entries]);

  const filtered = useMemo(() => {
    let list = entries;
    if (activeTag) list = list.filter((entry) => entry.tags.includes(activeTag));
    const q = query.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (entry) =>
          entry.title.toLowerCase().includes(q) ||
          entry.content.toLowerCase().includes(q) ||
          entry.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }
    return list;
  }, [entries, activeTag, query]);

  const grouped = useMemo(() => {
    const groups: Record<KnowledgeGroup, KnowledgeRecord[]> = { manual: [], run: [], ai: [] };
    for (const entry of filtered) groups[groupOf(entry)].push(entry);
    return groups;
  }, [filtered]);

  const refine = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/knowledge/ai-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: props.workspaceId })
      });
      if (!res.ok) throw new Error(`refine failed: ${res.status}`);
      await load();
    } catch (refineError) {
      setError(refineError instanceof Error ? refineError.message : t("history.loadError"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  return (
    <RouteLayout title={t("knowledge.title")} subtitle={t("knowledge.subtitle")}>
      <ErrorBanner error={error} />

      <Card className="p-4">
        <div className="flex gap-2.5 flex-wrap sm:flex-nowrap">
          <input
            value={capture}
            onChange={(event) => setCapture(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && capture.trim()) void submitCapture();
            }}
            placeholder={listening ? "...": t("knowledge.capture.placeholder")}
            aria-label={t("knowledge.capture.placeholder")}
            className="flex-1 min-w-[200px] border border-line bg-surface-strong/50 rounded-pill px-5 py-3.5 text-[15px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand placeholder:text-muted/70 transition-colors hover:border-line-strong"
          />
          {voiceSupported && (
            <button
              type="button"
              onClick={toggleMic}
              aria-label="voice input"
              aria-pressed={listening}
              className={`shrink-0 w-[52px] h-[52px] rounded-full border text-xl cursor-pointer transition-all ${
                listening ? "border-brand bg-brand-light text-brand animate-pulse" : "border-line-strong bg-white hover:border-brand/50"
              }`}
            >
              MIC
            </button>
          )}
          <Button onClick={() => void submitCapture()} disabled={savingCapture || !capture.trim()} size="lg" className="shrink-0">
            {savingCapture ? "..." : "+"}
          </Button>
        </div>
        <p className="m-0 mt-2 px-1 text-[12px] text-muted flex items-center justify-between gap-2 flex-wrap">
          <span>{t("knowledge.capture.hint")}</span>
          {lastAdded && (
            <span className="text-ok font-semibold">OK {lastAdded}</span>
          )}
        </p>
      </Card>

      <div className="flex items-center gap-3 flex-wrap">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search..."
          aria-label="Search knowledge"
          className="border border-line bg-white rounded-pill px-4 py-2 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-brand w-full max-w-[240px]"
        />
        {tagCloud.map(([tag, count]) => (
          <button
            key={tag}
            type="button"
            onClick={() => setActiveTag(activeTag === tag ? null : tag)}
            aria-pressed={activeTag === tag}
            className={`text-[12px] font-medium rounded-pill px-2.5 py-1 border cursor-pointer transition-colors ${
              activeTag === tag ? "border-brand bg-brand-light text-brand" : "border-line-strong bg-white text-muted hover:text-ink"
            }`}
          >
            #{tag} x{count}
          </button>
        ))}
        <Button size="sm" variant="secondary" className="ml-auto" onClick={() => void refine()} disabled={entries.length < 2}>
          {t("knowledge.refine")}
        </Button>
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={index}><Skeleton className="h-20 w-full" /></Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title={t("knowledge.title")} body={t("knowledge.empty")} />
      ) : (
        (["manual", "run", "ai"] as const).map((group) => {
          const groupEntries = grouped[group];
          if (groupEntries.length === 0) return null;
          const meta = GROUP_META[group];
          return (
            <section key={group} className="grid gap-3">
              <h3 className="m-0 text-[15px] font-bold tracking-tight flex items-center gap-2">
                <span className={`inline-flex w-7 h-7 items-center justify-center rounded-input ${meta.tint}`}>
                  {meta.icon}
                </span>
                {t(`knowledge.group.${group}`)}
                <span className="text-muted font-normal text-[12.5px]">({groupEntries.length})</span>
              </h3>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {groupEntries.map((entry) => (
                  <Card key={entry.id} className="glass-hover lift grid gap-1.5 p-4">
                    <CardHeader className="!mb-1">
                      <CardTitle className="text-[14.5px] leading-snug">{entry.title}</CardTitle>
                      <Badge variant={groupBadgeVariant(group)}>{group}</Badge>
                    </CardHeader>
                    <CardContent className="gap-1.5">
                      <p className="m-0 text-[13px] text-muted leading-relaxed line-clamp-3 whitespace-pre-wrap">
                        {entry.content}
                      </p>
                      {entry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-0.5">
                          {entry.tags.slice(0, 4).map((tag) => (
                            <button
                              key={tag}
                              type="button"
                              onClick={() => setActiveTag(tag)}
                              className="text-[11px] font-medium text-brand bg-brand-light rounded-pill px-1.5 py-0.5 cursor-pointer border-0"
                            >
                              #{tag}
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="pt-0.5 flex items-center justify-between">
                        <span className="text-[10.5px] text-muted/70">
                          {entry.runId ? entry.runId.slice(0, 16) : ""}
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={async () => {
                            await deleteKnowledgeEntry(entry.id);
                            await load();
                          }}
                        >
                          {t("knowledge.delete")}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          );
        })
      )}
    </RouteLayout>
  );
}
