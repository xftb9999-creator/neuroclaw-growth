import { useEffect, useState } from "react";

import {
  deleteMemoryRecord,
  listWorkspaceMemory,
  updateMemoryRecord
} from "../lib/api.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader } from "../components/ui/Card.js";
import { Badge, Skeleton, Textarea } from "../components/ui/Input.js";
import { EmptyState, ErrorBanner, RouteLayout } from "../components/Layout.js";
import type { MemoryRecord } from "../types.js";

export function MemoryPage(props: {
  workspaceId: string;
  onWorkspaceMissing: (message: string) => void;
  onOpenRun: (runId: string) => void;
}) {
  const { t } = useI18n();
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftSummary, setDraftSummary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    try {
      const items = (await listWorkspaceMemory(props.workspaceId)) as MemoryRecord[];
      setRecords(items);
      setError(null);
    } catch (loadError) {
      if (isWorkspaceMissingError(loadError)) {
        props.onWorkspaceMissing(t("memory.workspaceExpired"));
        return;
      }
      setError(loadError instanceof Error ? loadError.message : t("memory.loadError"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.workspaceId]);

  const startEdit = (record: MemoryRecord) => {
    setEditingId(record.id);
    setDraftSummary(record.summary);
  };

  return (
    <RouteLayout title={t("memory.title")} subtitle={t("memory.subtitle")}>
      <ErrorBanner error={error} />
      {loading && (
        <div
          role="status"
          aria-live="polite"
          aria-busy={loading}
          className="grid gap-4"
        >
          {Array.from({ length: 2 }).map((_, index) => (
            <Card key={`skeleton-${index}`}>
              <div className="grid gap-3">
                <div className="flex items-center justify-between gap-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-10 w-28" />
                </div>
                <Skeleton className="h-5 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            </Card>
          ))}
        </div>
      )}
      {!loading && records.length === 0 ? (
        <EmptyState title={t("memory.emptyTitle")} body={t("memory.emptyBody")} />
      ) : (
        !loading && (
          <div className="grid gap-4">
            {records.map((record) => (
              <Card key={record.id}>
                <CardHeader>
                  <div className="grid gap-1">
                    <Badge variant="info">{record.type.replaceAll("_", " ")}</Badge>
                    <h3 className="text-base font-semibold m-0">
                      {record.templateType.replaceAll("_", " ")}
                    </h3>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => props.onOpenRun(record.sourceRunId)}
                      aria-label={t("memory.sourceRunAria")}
                    >
                      {t("memory.sourceRun")}
                    </Button>
                    <Button
                      data-testid={`pin-${record.id}`}
                      variant={record.isPinned ? "outline" : "primary"}
                      size="sm"
                      onClick={async () => {
                        await updateMemoryRecord(record.id, { isPinned: !record.isPinned });
                        await load();
                      }}
                    >
                      {record.isPinned ? t("memory.unpin") : t("memory.pin")}
                    </Button>
                    <Button
                      data-testid={`suppress-${record.id}`}
                      variant="secondary"
                      size="sm"
                      onClick={async () => {
                        await updateMemoryRecord(record.id, {
                          isSuppressed: !record.isSuppressed
                        });
                        await load();
                      }}
                    >
                      {record.isSuppressed ? t("memory.unsuppress") : t("memory.suppress")}
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {editingId === record.id ? (
                    <div className="grid gap-3">
                      <Textarea
                        data-testid={`edit-memory-${record.id}`}
                        value={draftSummary}
                        onChange={(event) => setDraftSummary(event.target.value)}
                        aria-label={t("memory.editAria")}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          onClick={async () => {
                            await updateMemoryRecord(record.id, { summary: draftSummary });
                            setEditingId(null);
                            await load();
                          }}
                        >
                          {t("memory.save")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setEditingId(null)}
                        >
                          {t("memory.cancel")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-ink m-0">{record.summary}</p>
                  )}

                  <div className="flex flex-wrap gap-2">
                    {editingId !== record.id && (
                      <Button
                        data-testid={`edit-${record.id}`}
                        variant="secondary"
                        size="sm"
                        onClick={() => startEdit(record)}
                      >
                        {t("memory.edit")}
                      </Button>
                    )}
                    <Button
                      data-testid={`delete-${record.id}`}
                      variant="danger"
                      size="sm"
                      onClick={async () => {
                        await deleteMemoryRecord(record.id);
                        await load();
                      }}
                    >
                      {t("memory.delete")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )
      )}
    </RouteLayout>
  );
}
