import { useEffect, useMemo, useState } from "react";

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
        <span className="text-[12.5px] text-muted">{t("knowledge.attachedHint")}</span>
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
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((entry) => (
            <Card key={entry.id} className="glass-hover lift grid gap-2">
              <CardHeader>
                <CardTitle className="text-[15.5px] leading-snug">{entry.title}</CardTitle>
                <Badge variant="default">{entry.source}</Badge>
              </CardHeader>
              <CardContent>
                <p className="m-0 text-[13.5px] text-muted leading-relaxed line-clamp-4">
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
                <div className="pt-1">
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
      )}
    </RouteLayout>
  );
}
