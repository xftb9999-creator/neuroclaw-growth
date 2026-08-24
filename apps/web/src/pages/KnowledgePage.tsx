import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  listKnowledgeEntries,
  type KnowledgeRecord
} from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Input, Label, Skeleton, Textarea } from "../components/ui/Input.js";
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
  const { t } = useI18n();
  const [entries, setEntries] = useState<KnowledgeRecord[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tagsRaw, setTagsRaw] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    try {
      const items = (await listKnowledgeEntries(props.workspaceId)) as KnowledgeRecord[];
      setEntries(items);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  const add = async () => {
    if (!title.trim() || !content.trim()) return;
    setSaving(true);
    try {
      await createKnowledgeEntry({
        workspaceId: props.workspaceId,
        title: title.trim(),
        content: content.trim(),
        tags: tagsRaw
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean)
      });
      setTitle("");
      setContent("");
      setTagsRaw("");
      await load();
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : t("history.loadError"));
    } finally {
      setSaving(false);
    }
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(
      (entry) =>
        entry.title.toLowerCase().includes(q) ||
        entry.content.toLowerCase().includes(q) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  }, [entries, query]);

  const grouped = useMemo(() => {
    const groups: Record<KnowledgeGroup, KnowledgeRecord[]> = { manual: [], run: [], ai: [] };
    for (const entry of filtered) {
      groups[groupOf(entry)].push(entry);
    }
    return groups;
  }, [filtered]);

  const [refining, setRefining] = useState(false);

  const refine = useCallback(async () => {
    setRefining(true);
    setError(null);
    try {
      await fetch("/api/knowledge/ai-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: props.workspaceId })
      }).then((res) => {
        if (!res.ok) throw new Error(`refine failed: ${res.status}`);
      });
      await load();
    } catch (refineError) {
      setError(refineError instanceof Error ? refineError.message : t("history.loadError"));
    } finally {
      setRefining(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  return (
    <RouteLayout title={t("knowledge.title")} subtitle={t("knowledge.subtitle")}>
      <ErrorBanner error={error} />

      <Card className="grid gap-3">
        <Label>
          <span>{t("knowledge.addTitle")}</span>
          <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="品牌介绍 / 语气规范 / 爆款打法…" />
        </Label>
        <Label>
          <span>{t("knowledge.addContent")}</span>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            className="min-h-[88px]"
            placeholder="例:我们的客户多为 25-40 岁新手妈妈,重视安全与性价比;语气亲切,多用 emoji,不承诺绝对效果。"
          />
        </Label>
        <Label>
          <span>{t("knowledge.addTags")}</span>
          <Input value={tagsRaw} onChange={(event) => setTagsRaw(event.target.value)} placeholder="品牌, 客群" />
        </Label>
        <Button onClick={() => void add()} disabled={saving || !title.trim() || !content.trim()} className="justify-self-start">
          {saving ? t("setup.launching") : `＋ ${t("knowledge.add")}`}
        </Button>
      </Card>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="🔍 Search…"
          aria-label="Search knowledge"
          className="border border-line bg-white rounded-pill px-4 py-2 text-[14px] outline-none focus-visible:outline-2 focus-visible:outline-brand w-full max-w-xs"
        />
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] text-muted">{t("knowledge.attachedHint")}</span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void refine()}
            disabled={refining || entries.length < 2}
          >
            ✨ {refining ? t("setup.launching") : t("knowledge.refine")}
          </Button>
        </div>
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
              <div className="grid gap-4 md:grid-cols-2">
                {groupEntries.map((entry) => (
                  <Card key={entry.id} className="glass-hover lift grid gap-2">
                    <CardHeader>
                      <CardTitle className="text-[15px] leading-snug">{entry.title}</CardTitle>
                      <Badge variant={groupBadgeVariant(group)}>{group}</Badge>
                    </CardHeader>
                    <CardContent>
                      <p className="m-0 text-[13.5px] text-muted leading-relaxed line-clamp-4 whitespace-pre-wrap">
                        {entry.content}
                      </p>
                      {entry.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-1">
                          {entry.tags.map((tag) => (
                            <span
                              key={tag}
                              className="text-[11.5px] font-medium text-brand bg-brand-light rounded-pill px-2 py-0.5"
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="pt-1 flex items-center justify-between">
                        {entry.runId ? (
                          <span className="text-[11.5px] text-muted/80">↳ {entry.runId.slice(0, 18)}…</span>
                        ) : <span />}
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
