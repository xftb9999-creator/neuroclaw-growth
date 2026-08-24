export interface FormFieldConfig {
  name: string;
  label: string;
  placeholder: string;
  type: "text" | "textarea" | "number" | "channels";
  required: boolean;
}

const sharedFields: FormFieldConfig[] = [
  {
    name: "businessSummary",
    label: "Business Summary",
    placeholder: "Describe the campaign or business context",
    type: "textarea",
    required: true
  },
  {
    name: "targetCustomer",
    label: "Target Customer",
    placeholder: "Who should this run serve?",
    type: "text",
    required: true
  },
  {
    name: "preferredChannels",
    label: "Preferred Channels",
    placeholder: "email, linkedin, x",
    type: "channels",
    required: true
  }
];

export const templateFormConfig = {
  content_acquisition: [
    ...sharedFields,
    {
      name: "contentGoal",
      label: "Content Goal",
      placeholder: "Generate three campaign hooks",
      type: "text",
      required: true
    }
  ],
  private_conversion: [
    ...sharedFields,
    {
      name: "offerAsset",
      label: "Offer Asset",
      placeholder: "VIP audit, consultation, or preview offer",
      type: "text",
      required: true
    }
  ],
  weekly_review: [
    ...sharedFields,
    {
      name: "metricsWindowDays",
      label: "Metrics Window Days",
      placeholder: "7",
      type: "number",
      required: true
    }
  ]
} as const;

export type TemplateFormType = keyof typeof templateFormConfig;

export function getTemplateFormFields(templateType: TemplateFormType): FormFieldConfig[] {
  return [...templateFormConfig[templateType]];
}

export function createEmptyFormValues(
  templateType: TemplateFormType
): Record<string, string> {
  return Object.fromEntries(
    getTemplateFormFields(templateType).map((field) => [field.name, ""])
  );
}

export function normalizeFormInput(
  templateType: TemplateFormType,
  values: Record<string, string>
): Record<string, unknown> {
  const next: Record<string, unknown> = {};

  for (const field of getTemplateFormFields(templateType)) {
    const raw = values[field.name] ?? "";

    if (field.type === "channels") {
      next[field.name] = raw
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }

    if (field.type === "number") {
      next[field.name] = Number(raw);
      continue;
    }

    next[field.name] = raw.trim();
  }

  return next;
}

export function denormalizeFormInput(
  templateType: TemplateFormType,
  input: Record<string, unknown>
): Record<string, string> {
  const next: Record<string, string> = {};

  for (const field of getTemplateFormFields(templateType)) {
    const value = input[field.name];

    if (value === undefined || value === null) {
      next[field.name] = "";
      continue;
    }

    if (field.type === "channels" && Array.isArray(value)) {
      next[field.name] = value.join(", ");
      continue;
    }

    next[field.name] = String(value);
  }

  return next;
}
