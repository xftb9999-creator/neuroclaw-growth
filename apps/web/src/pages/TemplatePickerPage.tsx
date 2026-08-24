import { useEffect, useState } from "react";

import { listTemplates } from "../lib/api.js";
import { Button } from "../components/ui/Button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/Card.js";
import { Badge, Skeleton } from "../components/ui/Input.js";
import { ErrorBanner, RouteLayout } from "../components/Layout.js";
import type { TemplateRecord, TemplateType } from "../types.js";

export function TemplatePickerPage(props: { onSelect: (templateType: TemplateType) => void }) {
  const [templates, setTemplates] = useState<TemplateRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    listTemplates()
      .then((items) => {
        setTemplates(items as TemplateRecord[]);
        setError(null);
      })
      .catch((error: unknown) =>
        setError(error instanceof Error ? error.message : "Failed to load templates")
      )
      .finally(() => setLoading(false));
  }, []);

  return (
    <RouteLayout
      title="Choose Your First Template"
      subtitle="Pick one of the three P0 launch templates and move straight into run setup."
    >
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
                  <Badge variant="info">{template.type.replaceAll("_", " ")}</Badge>
                </CardHeader>
                <CardTitle>{template.name}</CardTitle>
                <CardContent>
                  <p className="text-sm text-muted m-0">Version {template.version}</p>
                  <Button
                    data-testid={`select-${template.type}`}
                    onClick={() => props.onSelect(template.type)}
                    aria-label={`Configure ${template.name} run`}
                  >
                    Configure Run
                  </Button>
                </CardContent>
              </Card>
            ))}
      </div>
    </RouteLayout>
  );
}
