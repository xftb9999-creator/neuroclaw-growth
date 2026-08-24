import { useEffect, useMemo, useState } from "react";

import { listRunHistory, listWorkspaceMemory } from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { navigate } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton, Textarea } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";
import type { MemoryRecord, RunRecord } from "../types.js";

const TONE_STORAGE_PREFIX = "neuroclaw.tone.";

function topUnique(values: string[], limit = 4): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = value.trim();
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value]) => value);
}

export function BrandProfilePage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
}) {
  const { t } = useI18n();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toneDraft, setToneDraft] = useState("");
  const [toneSaved, setToneSaved] = useState(false);

  useEffect(() => {
    try {
      setToneDraft(window.localStorage.getItem(TONE_STORAGE_PREFIX + props.workspaceId) ?? "");
    } catch {
      // storage unavailable
    }
  }, [props.workspaceId]);

  const load = async () => {
    try {
      const [runItems, memoryItems] = await Promise.all([
        listRunHistory(props.workspaceId),
        listWorkspaceMemory(props.workspaceId)
      ]);
      setRuns(runItems as RunRecord[]);
      setMemories(memoryItems as MemoryRecord[]);
      setError(null);
    } catch (loadError) {
      if (isWorkspaceMissingError(loadError)) {
        props.onWorkspaceMissing(t("history.workspaceExpired"));
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  const positioning = useMemo(
    () => topUnique(runs.map((run) => String(run.input.businessSummary ?? ""))),
    [runs]
  );
  const audience = useMemo(
    () => topUnique(runs.map((run) => String(run.input.targetCustomer ?? ""))),
    [runs]
  );
  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      const list = run.input.preferredChannels;
      if (!Array.isArray(list)) continue;
      for (const channel of list) {
        const key = String(channel).trim();
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  }, [runs]);
  const pinned = memories.filter((record) => record.isPinned && !record.isSuppressed);

  const saveTone = () => {
    try {
      window.localStorage.setItem(TONE_STORAGE_PREFIX + props.workspaceId, toneDraft);
      setToneSaved(true);
      window.setTimeout(() => setToneSaved(false), 2000);
    } catch {
      // storage unavailable
    }
  };

  const chipRow = (values: string[], tint: string) =>
    values.length === 0 ? null : (
      <div className="flex flex-wrap gap-2">
        {values.map((value) => (
          <span
            key={value}
            className={`text-[13.5px] font-medium rounded-pill px-3.5 py-1.5 ${tint}`}
          >
            {value}
          </span>
        ))}
      </div>
    );

  return (
    <RouteLayout title={t("profile.title")} subtitle={t("profile.subtitle")}>
      <ErrorBanner error={error} />
      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}>
              <Skeleton className="h-24 w-full" />
            </Card>
          ))}
        </div>
      ) : runs.length === 0 && memories.length === 0 ? (
        <EmptyState title={t("profile.empty")} body={t("home.recentEmpty.body")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>🎯 {t("profile.positioning")}</CardTitle>
              <Badge variant="default">{t("profile.fromRuns")}</Badge>
            </CardHeader>
            <CardContent>
              {chipRow(positioning, "bg-brand-light text-brand") ?? (
                <p className="m-0 text-muted text-sm">{t("profile.empty")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>👥 {t("profile.audience")}</CardTitle>
              <Badge variant="default">{t("profile.fromRuns")}</Badge>
            </CardHeader>
            <CardContent>
              {chipRow(audience, "bg-[#e9f6ee] text-ok") ?? (
                <p className="m-0 text-muted text-sm">{t("profile.empty")}</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>📡 {t("profile.channels")}</CardTitle>
            </CardHeader>
            <CardContent>
              {channels.length === 0 ? (
                <p className="m-0 text-muted text-sm">{t("profile.empty")}</p>
              ) : (
                <div className="grid gap-2.5">
                  {channels.map(([channel, count]) => {
                    const max = Math.max(...channels.map(([, c]) => c));
                    return (
                      <div key={channel} className="grid gap-1">
                        <div className="flex justify-between text-[13px]">
                          <span className="font-medium">{channel}</span>
                          <span className="text-muted">×{count}</span>
                        </div>
                        <div className="h-2 rounded-pill bg-surface-strong overflow-hidden">
                          <div
                            className="h-full rounded-pill bg-gradient-to-r from-brand to-ember"
                            style={{ width: `${Math.max(12, (count / max) * 100)}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>✍️ {t("profile.tone")}</CardTitle>
              {toneSaved && <Badge variant="completed">{t("profile.toneSaved")}</Badge>}
            </CardHeader>
            <CardContent>
              <Textarea
                value={toneDraft}
                onChange={(event) => setToneDraft(event.target.value)}
                placeholder={t("profile.tonePlaceholder")}
                aria-label={t("profile.tone")}
                className="min-h-[96px]"
              />
              <Button size="sm" variant="secondary" onClick={saveTone} className="justify-self-start">
                {t("profile.toneSave")}
              </Button>
            </CardContent>
          </Card>

          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle>📌 {t("profile.pinned")}</CardTitle>
              <Button size="sm" variant="ghost" onClick={() => navigate("/memory")}>
                {t("profile.manageMemory")} →
              </Button>
            </CardHeader>
            <CardContent>
              {pinned.length === 0 ? (
                <p className="m-0 text-muted text-sm">{t("profile.empty")}</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-3">
                  {pinned.slice(0, 4).map((record) => (
                    <div key={record.id} className="border hairline rounded-input p-3.5 bg-white">
                      <Badge variant="default">{t(`templates.names.${record.templateType}`)}</Badge>
                      <p className="m-0 mt-2 text-[14px] leading-relaxed">{record.summary}</p>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </RouteLayout>
  );
}
