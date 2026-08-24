import { useEffect, useState } from "react";

import { listTemplates } from "../lib/api.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";
import type { TemplateRecord, TemplateType } from "../types.js";

export function TemplatePickerPage(props: { onSelect: (templateType: TemplateType) => void }) {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTemplates()
      .then((items) => {
        setTemplates(items as TemplateRecord[]);
        setError(null);
      })
      .catch((loadError: unknown) =>
        setError(
          loadError instanceof Error ? loadError.message : t("templates.loadError")
        )
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <RouteLayout title={t("templates.title")} subtitle={t("templates.subtitle")}>
      <ErrorBanner error={error} />
      <div
        role="status"
        aria-live="polite"
        aria-busy={loading}
        className="grid gap-4 md:grid-cols-2 lg:grid-cols-3"
      >
        {loading
          ? Array.from({ length: 3 }).map((_, index) => (
              <Card key={`skeleton-${index}`}>
                <div className="grid gap-3">
                  <Skeleton className="h-5 w-28" />
                  <Skeleton className="h-6 w-3/4" />
                  <Skeleton className="h-4 w-1/2" />
                  <Skeleton className="h-10 w-32" />
                </div>
              </Card>
            ))
          : templates.map((template) => (
              <Card key={template.id}>
                <CardHeader>
                  <Badge variant="default">{t(`templates.names.${template.type}`)}</Badge>
                </CardHeader>
                <CardTitle>{t(`templates.names.${template.type}`)}</CardTitle>
                <CardContent>
                  <p className="text-sm text-muted m-0">
                    {t("templates.version")} {template.version}
                  </p>
                  <Button
                    data-testid={`select-${template.type}`}
                    onClick={() => props.onSelect(template.type)}
                    aria-label={`${t("templates.configure")}: ${t(`templates.names.${template.type}`)}`}
                  >
                    {t("templates.configure")}
                  </Button>
                </CardContent>
              </Card>
            ))}
      </div>
    </RouteLayout>
  );
}
