import {
  type AdapterActionType,
  type Template,
  type TemplateAction,
  type TemplateInputPayload,
  type TemplateOutputPayload,
  type TemplateType,
  validateTemplateInputContract
} from "@neuroclaw/shared";

function action(
  id: string,
  actionType: AdapterActionType,
  description: string,
  critical: boolean
): TemplateAction {
  const adapterMap: Record<AdapterActionType, TemplateAction["adapter"]> = {
    browser_extract: "browser",
    mcp_generate_brief: "mcp",
    mcp_generate_conversion_copy: "mcp",
    mcp_generate_review: "mcp",
    notification_send_preview: "notification"
  };

  return {
    id,
    adapter: adapterMap[actionType],
    actionType,
    description,
    critical
  };
}

const templateCatalog: Record<TemplateType, Template> = {
  content_acquisition: {
    id: "tpl_content_acquisition_v1",
    type: "content_acquisition",
    name: "Content Acquisition",
    version: "2.0.0",
    status: "active",
    inputContract: {
      fields: [
        { name: "businessSummary", type: "string", required: true, description: "Business context" },
        { name: "targetCustomer", type: "string", required: true, description: "Target customer" },
        { name: "preferredChannels", type: "string[]", required: true, description: "Preferred channels" },
        { name: "contentGoal", type: "string", required: true, description: "Desired content outcome" }
      ]
    },
    outputContract: {
      fields: [
        { name: "contentAngles", type: "string[]", required: true, description: "Generated content angles" },
        { name: "channelRecommendations", type: "string[]", required: true, description: "Recommended channels" }
      ]
    },
    requiresApprovalRules: [],
    supportedActions: [
      action("content-source-scan", "browser_extract", "Extract campaign hints", false),
      action("content-brief", "mcp_generate_brief", "Generate a content brief", true)
    ]
  },
  private_conversion: {
    id: "tpl_private_conversion_v1",
    type: "private_conversion",
    name: "Private Conversion",
    version: "2.0.0",
    status: "active",
    inputContract: {
      fields: [
        { name: "businessSummary", type: "string", required: true, description: "Offer context" },
        { name: "targetCustomer", type: "string", required: true, description: "Lead segment" },
        { name: "preferredChannels", type: "string[]", required: true, description: "Outreach channels" },
        { name: "offerAsset", type: "string", required: true, description: "Offer asset" },
        { name: "recipientEmail", type: "string", required: false, description: "Optional recipient email for approved delivery" }
      ]
    },
    outputContract: {
      fields: [
        { name: "conversionDraft", type: "string", required: true, description: "Conversion draft" },
        { name: "approvalPreview", type: "string", required: true, description: "Approval preview" }
      ]
    },
    requiresApprovalRules: [
      {
        actionType: "notification_send_preview",
        reason: "Preview send is a high-risk external action"
      }
    ],
    supportedActions: [
      action("conversion-copy", "mcp_generate_conversion_copy", "Generate conversion copy", true),
      action("preview-send", "notification_send_preview", "Prepare preview notification", true)
    ]
  },
  weekly_review: {
    id: "tpl_weekly_review_v1",
    type: "weekly_review",
    name: "Weekly Review",
    version: "2.0.0",
    status: "active",
    inputContract: {
      fields: [
        { name: "businessSummary", type: "string", required: true, description: "Business context" },
        { name: "targetCustomer", type: "string", required: true, description: "Audience context" },
        { name: "preferredChannels", type: "string[]", required: true, description: "Relevant channels" },
        { name: "metricsWindowDays", type: "number", required: true, description: "Metrics review window" },
        { name: "metricsSummary", type: "string", required: false, description: "Optional metrics digest for the review window" }
      ]
    },
    outputContract: {
      fields: [
        { name: "reviewSummary", type: "string", required: true, description: "Weekly review summary" },
        { name: "nextActions", type: "string[]", required: true, description: "Recommended follow-ups" }
      ]
    },
    requiresApprovalRules: [],
    supportedActions: [
      action("weekly-scan", "browser_extract", "Extract visible indicators", false),
      action("weekly-review", "mcp_generate_review", "Generate a review", true)
    ]
  }
};

export function listTemplates(): Template[] {
  return Object.values(templateCatalog);
}

export function getTemplateByType(type: TemplateType): Template {
  return templateCatalog[type];
}

export function validateTemplateInput(
  type: TemplateType,
  input: TemplateInputPayload
): void {
  validateTemplateInputContract(input, templateCatalog[type].inputContract);
}

export function formatTemplateOutput(
  type: TemplateType,
  partial: TemplateOutputPayload
): TemplateOutputPayload {
  const template = getTemplateByType(type);

  for (const field of template.outputContract.fields) {
    if (field.required && partial[field.name] === undefined) {
      throw new Error(`Template output requires ${field.name}`);
    }
  }

  return partial;
}
