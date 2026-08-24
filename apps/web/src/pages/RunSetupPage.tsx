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
import { Button } from "../components/ui/Button.js";
import { Card } from "../components/ui/Card.js";
import { Input, Label, Textarea } from "../components/ui/Input.js";
import { ErrorBanner, InfoBanner, RouteLayout } from "../components/Layout.js";
import type { TemplateType } from "../types.js";

function validateRequiredValues(
  fields: FormFieldConfig[],
  values: Record<string, string>
): string | null {
  for (const field of fields) {
    const raw = values[field.name] ?? "";

    if (!field.required) continue;

    if (field.type === "channels") {
      if (
        raw
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean).length === 0
      ) {
        return `${field.label} is required`;
      }
      continue;
    }

    if (!raw.trim()) {
      return `${field.label} is required`;
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
    setPrefillLabel(`Reusing input from ${draft.sourceRunId}`);
    clearRunDraft();
  }, [props.templateType]);

  return (
    <RouteLayout
      title="Configure Your Run"
      subtitle="Fill the minimum input contract for this template and launch the run."
    >
      <Card>
        <form
          className="grid gap-4 max-w-3xl"
          onSubmit={async (event) => {
            event.preventDefault();
            setError(null);
            setIsSubmitting(true);

            try {
              const validationError = validateRequiredValues(fields, values);
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
                props.onWorkspaceMissing(
                  "Your workspace expired after a backend reset. Create a new workspace to continue."
                );
                return;
              }
              setError(error instanceof Error ? error.message : "Failed to create run");
            } finally {
              setIsSubmitting(false);
            }
          }}
        >
          <ErrorBanner error={error} />
          {prefillLabel && <InfoBanner message={prefillLabel} />}
          {fields.map((field) => (
            <Label key={field.name}>
              <span>{field.label}</span>
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
            aria-label={isSubmitting ? "Launching run" : "Launch run"}
          >
            {isSubmitting ? "Launching..." : "Launch Run"}
          </Button>
        </form>
      </Card>
    </RouteLayout>
  );
}
