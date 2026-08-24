import { useEffect, useMemo, useState } from "react";

import { deleteArtifact, listArtifacts, type ArtifactRecord } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";

const KIND_TINT: Record<string, string> = {
  note: "bg-[#fff0e7] text-brand",
  copy: "bg-[#e9f6ee] text-ok",
  report: "bg-[#f0ecff] text-[#6d5bd0]",
  generic: "bg-surface-strong text-muted"
};

export function LibraryPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [items, setItems] = useState<ArtifactRecord[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listArtifacts(props.workspaceId)
      .then((items) => setItems(items as ArtifactRecord[]))
      .catch((loadError) => {
        if ((loadError as { code?: string }).code === "WORKSPACE_NOT_FOUND") {
          props.onWorkspaceMissing(t("history.workspaceExpired"));
          return;
        }
        setError(loadError instanceof Error ? loadError.message : t("history.loadError"));
      })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((item) => item.kind === filter)),
    [items, filter]
  );

  const download = (artifact: ArtifactRecord) => {
    const blob = new Blob([JSON.stringify(artifact.payload, null, 2)], {
      type: "application/json"
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${artifact.kind}-${artifact.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <RouteLayout title={t("library.title")} subtitle={t("library.subtitle")}>
      <ErrorBanner error={error} />

      <div className="flex flex-wrap gap-2">
        {(["all", "note", "copy", "report"] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => setFilter(kind)}
            aria-pressed={filter === kind}
            className={`text-[13px] font-medium rounded-pill px-3.5 py-1.5 border cursor-pointer transition-colors ${
              filter === kind
                ? "border-brand bg-brand-light text-brand"
                : "border-line-strong bg-white hover:border-brand/40"
            }`}
          >
            {t(`library.filter.${kind}`)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="grid md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <Card key={index}><Skeleton className="h-20 w-full" /></Card>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState title={t("library.title")} body={t("library.empty")} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {filtered.map((artifact) => (
            <Card key={artifact.id} className="glass-hover lift grid gap-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span
                  className={`text-[12px] font-bold rounded-pill px-2.5 py-1 ${KIND_TINT[artifact.kind] ?? KIND_TINT.generic}`}
                >
                  {t(`library.filter.${artifact.kind}`)}
                </span>
                <Badge variant="default">{t(`templates.names.${artifact.agentType}`)}</Badge>
              </div>
              <h4 className="m-0 font-semibold text-[15px] leading-snug line-clamp-2">
                {artifact.title}
              </h4>
              {artifact.summary && artifact.summary !== artifact.title && (
                <p className="m-0 text-[13px] text-muted leading-relaxed line-clamp-2">
                  {artifact.summary}
                </p>
              )}
              <div className="flex flex-wrap gap-2 pt-1 border-t hairline">
                <Button size="sm" variant="secondary" onClick={() => props.onOpenRun(artifact.runId)}>
                  {t("library.open")}
                </Button>
                <Button size="sm" variant="outline" onClick={() => download(artifact)}>
                  ⬇ {t("library.download")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    await deleteArtifact(artifact.id);
                    await new Promise((resolve) => setTimeout(resolve, 50));
                    setItems((current) => current.filter((item) => item.id !== artifact.id));
                  }}
                >
                  {t("knowledge.delete")}
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {!loading && items.length > 0 && (
        <p className="m-0 text-[12px] text-muted">{items.length} artifacts</p>
      )}
    </RouteLayout>
  );
}
