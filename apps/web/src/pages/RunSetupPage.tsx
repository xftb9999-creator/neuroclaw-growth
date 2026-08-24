import { useEffect, useState } from "react";

import { createRun } from "../lib/api.js";
import {
  createEmptyFormValues,
  denormalizeFormInput,
  getTemplateFormFields,
  normalizeFormInput,
  type FormFieldConfig,
  type TemplateFormType
} from "../lib/forms.js";
import { isWorkspaceMissingError } from "../lib/workspace.js";
import { clearRunDraft, readRunDraft } from "../lib/router.js";
import { useI18n } from "../lib/i18n.js";
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input, Label, Textarea } from "../components/ui/Input.js";
import { ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";
import type { TemplateType } from "../types.js";

function validateRequiredValues(
  fields: FormFieldConfig[],
  values: Record<string, string>,
  fieldRequiredTemplate: (label: string) => string
): string | null {
  for (const field of fields) {
    const raw = values[field.name] ?? "";

    if (!field.required) continue;

    const label = field.label;

    if (field.type === "channels") {
      if (
        raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean).length === 0
      ) {
        return fieldRequiredTemplate(label);
      }
      continue;
    }

    if (!raw.trim()) {
      return fieldRequiredTemplate(label);
    }
  }

  return null;
}

export function RunSetupPage(props: {
  workspaceId: string;
  templateType: TemplateType;
  onWorkspaceMissing: (message: string) => void;
  onCreated: (runId: string) => void;
}) {
  const { t } = useI18n();
  const fields = getTemplateFormFields(props.templateType as TemplateFormType);
  const [values, setValues] = useState<Record<string, string>>(() =>
    createEmptyFormValues(props.templateType as TemplateFormType)
  );
  const [prefillLabel, setPrefillLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setValues(createEmptyFormValues(props.templateType as TemplateFormType));
    setPrefillLabel(null);

    const draft = readRunDraft(props.templateType);
    if (!draft) {
      return;
    }

    setValues(denormalizeFormInput(props.templateType as TemplateFormType, draft.input));
    setPrefillLabel(t("setup.prefill", { runId: draft.sourceRunId }));
    clearRunDraft();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.templateType]);

  const fieldLabel = (name: string, fallback: string) => t(`fields.${name}`) === `fields.${name}`
    ? fallback
    : t(`fields.${name}`);

  return (
    <RouteLayout title={t("setup.title")} subtitle={t("setup.subtitle")}>
      <Card>
        <form
          className="grid gap-4 max-w-3xl"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setIsSubmitting(true);

            try {
              const validationError = validateRequiredValues(
                fields.map((field) => ({
                  ...field,
                  label: fieldLabel(field.name, field.label)
                })),
                values,
                (label) => t("setup.fieldRequired", { field: label })
              );
              if (validationError) {
                throw new Error(validationError);
              }

              const run = (await createRun({
                workspaceId: props.workspaceId,
                templateType: props.templateType,
                input: normalizeFormInput(props.templateType as TemplateFormType, values)
              })) as { id: string };

              props.onCreated(run.id);
            } catch (error) {
              if (isWorkspaceMissingError(error)) {
                props.onWorkspaceMissing(t("setup.workspaceExpired"));
                return;
              }
              setError(error instanceof Error ? error.message : t("status.loadError"));
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <ErrorBanner error={error} />
          {prefillLabel && <InfoBanner message={prefillLabel} />}
          {fields.map((field) => (
            <Label key={field.name}>
              <span>{fieldLabel(field.name, field.label)}</span>
              {field.type === "textarea" ? (
                <Textarea
                  data-testid={`field-${field.name}`}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              ) : (
                <Input
                  data-testid={`field-${field.name}`}
                  type={field.type === "number" ? "number" : "text"}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [field.name]: event.target.value }))
                  }
                />
              )}
            </Label>
          ))}
          <Button
            data-testid="launch-run"
            type="submit"
            disabled={isSubmitting}
            aria-label={isSubmitting ? t("setup.launchingAria") : t("setup.launchedAria")}
          >
            {isSubmitting ? t("setup.launching") : t("setup.launch")}
          </Button>
        </form>
      </Card>
    </RouteLayout>
  );
}
