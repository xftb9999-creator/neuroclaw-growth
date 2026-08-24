import { generateObject, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import type { TemplateInputPayload } from "@neuroclaw/shared";

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

export type AiProvider = "openai" | "anthropic" | "none";

export function detectProvider(): AiProvider {
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "none";
}

let cachedModel: LanguageModel | null = null;

function getModel(): LanguageModel | null {
  if (cachedModel) return cachedModel;

  const provider = detectProvider();

  if (provider === "openai") {
    const openai = createOpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
    cachedModel = openai(process.env.NEUROCLAW_AI_MODEL ?? "gpt-4o");
    return cachedModel;
  }

  if (provider === "anthropic") {
    const anthropic = createAnthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
    cachedModel = anthropic(process.env.NEUROCLAW_AI_MODEL ?? "claude-sonnet-4-20250514");
    return cachedModel;
  }

  return null;
}

export function isAiAvailable(): boolean {
  return getModel() !== null;
}

// ---------------------------------------------------------------------------
// Output schemas (match template output contracts)
// ---------------------------------------------------------------------------

export const contentBriefSchema = z.object({
  contentAngles: z.array(z.string()).min(2).describe("Generated content angles"),
  channelRecommendations: z.array(z.string()).describe("Recommended channels")
});

export const conversionCopySchema = z.object({
  conversionDraft: z.string().describe("Compelling conversion message draft")
});

export const weeklyReviewSchema = z.object({
  reviewSummary: z.string().describe("Weekly review summary"),
  nextActions: z.array(z.string()).min(2).describe("Recommended follow-up actions")
});

export const browserInsightsSchema = z.object({
  extractedInsights: z.array(z.string()).describe("Key insights extracted from web content"),
  channels: z.array(z.string()).describe("Identified channels")
});

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildContentBriefPrompt(input: TemplateInputPayload): string {
  return `Business context: ${String(input.businessSummary ?? "N/A")}
Target customer: ${String(input.targetCustomer ?? "N/A")}
Preferred channels: ${Array.isArray(input.preferredChannels) ? input.preferredChannels.join(", ") : "N/A"}
Content goal: ${String(input.contentGoal ?? "N/A")}

Generate 3-5 compelling content angles and recommend the best channels for distribution.`;
}

function buildConversionCopyPrompt(input: TemplateInputPayload): string {
  return `Offer context: ${String(input.businessSummary ?? "N/A")}
Lead segment: ${String(input.targetCustomer ?? "N/A")}
Outreach channels: ${Array.isArray(input.preferredChannels) ? input.preferredChannels.join(", ") : "N/A"}
Offer asset: ${String(input.offerAsset ?? "N/A")}

Write a compelling conversion message that drives action. The message should be personalized, concise, and include a clear call-to-action.`;
}

function formatStructuredMetrics(input: TemplateInputPayload): string {
  if (!Array.isArray(input.metrics) || input.metrics.length === 0) {
    return "";
  }

  const lines = input.metrics
    .filter((entry): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null)
    .map((entry) => {
      const name = String(entry.name ?? "metric");
      const value = String(entry.value ?? "n/a");
      const delta = entry.delta === undefined ? "" : ` (delta ${String(entry.delta)})`;
      return `- ${name}: ${value}${delta}`;
    });

  return lines.length > 0
    ? `\nStructured metrics:\n${lines.join("\n")}`
    : "";
}

function buildWeeklyReviewPrompt(input: TemplateInputPayload): string {
  const metricsSummary = typeof input.metricsSummary === "string" && input.metricsSummary.trim()
    ? `\nMetrics summary: ${input.metricsSummary.trim()}`
    : "";

  return `Business context: ${String(input.businessSummary ?? "N/A")}
Audience: ${String(input.targetCustomer ?? "N/A")}
Relevant channels: ${Array.isArray(input.preferredChannels) ? input.preferredChannels.join(", ") : "N/A"}
Metrics window: ${String(input.metricsWindowDays ?? "7")} days${metricsSummary}${formatStructuredMetrics(input)}

Analyze the past week's performance and provide:
1. A concise review summary highlighting wins and areas for improvement
2. 3-5 specific, actionable next steps to improve results`;
}

// ---------------------------------------------------------------------------
// Generation functions
// ---------------------------------------------------------------------------

export interface GenerationResult {
  contentAngles: string[];
  channelRecommendations: string[];
}

export interface ConversionResult {
  conversionDraft: string;
}

export interface ReviewResult {
  reviewSummary: string;
  nextActions: string[];
}

export interface BrowserInsightsResult {
  extractedInsights: string[];
  channels: string[];
}

function getSystemPrompt(action: string): string {
  const prompts: Record<string, string> = {
    content_brief: "You are an expert content strategist who creates data-driven content angles. You think in terms of audience psychology, channel dynamics, and conversion optimization.",
    conversion_copy: "You are a world-class conversion copywriter who writes compelling, personalized messages. You understand psychology, persuasion, and the art of the call-to-action.",
    weekly_review: "You are a growth analyst who turns metrics into actionable insights. You focus on what matters and provide clear, specific recommendations.",
    browser_insights: "You are a web content analyst who extracts key insights from web pages. You identify patterns, trends, and actionable information."
  };
  return prompts[action] ?? "You are a helpful AI assistant.";
}

export async function generateContentBrief(input: TemplateInputPayload): Promise<GenerationResult> {
  const model = getModel();
  if (!model) {
    return mockContentBrief(input);
  }

  const result = await generateObject({
    model,
    schema: contentBriefSchema,
    system: getSystemPrompt("content_brief"),
    prompt: buildContentBriefPrompt(input)
  });

  return result.object;
}

export async function generateConversionCopy(input: TemplateInputPayload): Promise<ConversionResult> {
  const model = getModel();
  if (!model) {
    return mockConversionCopy(input);
  }

  const result = await generateObject({
    model,
    schema: conversionCopySchema,
    system: getSystemPrompt("conversion_copy"),
    prompt: buildConversionCopyPrompt(input)
  });

  return result.object;
}

export async function generateWeeklyReview(input: TemplateInputPayload): Promise<ReviewResult> {
  const model = getModel();
  if (!model) {
    return mockWeeklyReview(input);
  }

  const result = await generateObject({
    model,
    schema: weeklyReviewSchema,
    system: getSystemPrompt("weekly_review"),
    prompt: buildWeeklyReviewPrompt(input)
  });

  return result.object;
}

export async function generateBrowserInsights(input: TemplateInputPayload): Promise<BrowserInsightsResult> {
  const model = getModel();
  if (!model) {
    return mockBrowserInsights(input);
  }

  const channels = Array.isArray(input.preferredChannels)
    ? input.preferredChannels as string[]
    : [];

  const result = await generateObject({
    model,
    schema: browserInsightsSchema,
    system: getSystemPrompt("browser_insights"),
    prompt: `Analyze the following business context and extract key insights:
Business: ${String(input.businessSummary ?? "N/A")}
Target customer: ${String(input.targetCustomer ?? "N/A")}
Channels: ${channels.join(", ") || "N/A"}

Identify key market insights, customer pain points, and channel opportunities.`
  });

  return result.object;
}

// ---------------------------------------------------------------------------
// Custom-agent structured generation (J2) — persona + dynamic output schema
// ---------------------------------------------------------------------------

export interface OutputFieldLike {
  name: string;
  type: "string" | "string[]" | "number";
  required?: boolean;
  description?: string;
}

export function buildOutputZodSchema(fields: OutputFieldLike[]) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of fields) {
    let base: z.ZodTypeAny;
    if (field.type === "string[]") base = z.array(z.string());
    else if (field.type === "number") base = z.number();
    else base = z.string();
    if (field.description) base = base.describe(field.description);
    shape[field.name] = field.required === false ? base.optional() : base;
  }
  return z.object(shape).passthrough();
}

export function buildCustomInstruction(
  instruction: string,
  input: TemplateInputPayload,
  focusAreas: string[] = []
): string {
  const inputDump = JSON.stringify(input, null, 2);
  const focus = focusAreas.length > 0 ? `\nFocus areas: ${focusAreas.join(", ")}` : "";
  return `${instruction}${focus}\n\nRun input (JSON):\n${inputDump}`;
}

function mockStructuredOutput(fields: OutputFieldLike[], input: TemplateInputPayload) {
  const topic = String(input.businessSummary ?? "the campaign");
  const audience = String(input.targetCustomer ?? "your audience");
  const output: Record<string, unknown> = {};

  for (const field of fields) {
    if (field.required === false && field.type !== "string") {
      continue;
    }
    if (field.type === "string[]") {
      output[field.name] = [
        `Angle one for ${topic} targeting ${audience}`,
        `Angle two with proof and social evidence`,
        `Angle three built around a single clear call-to-action`
      ];
    } else if (field.type === "number") {
      output[field.name] = 7;
    } else {
      output[field.name] = `Draft prepared by your custom employee for ${topic}, tuned for ${audience}.`;
    }
  }
  return output;
}

export async function generateStructuredForAgent(opts: {
  persona: string;
  instruction: string;
  fields: OutputFieldLike[];
  input: TemplateInputPayload;
}): Promise<Record<string, unknown>> {
  const model = getModel();
  if (!model) {
    return mockStructuredOutput(opts.fields, opts.input);
  }

  const result = await generateObject({
    model,
    schema: buildOutputZodSchema(opts.fields),
    system: opts.persona,
    prompt: opts.instruction
  });

  return result.object as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// LLM Planner (J5-B) — route a free-form goal to the best-fit agent
// ---------------------------------------------------------------------------

export interface PlannerCatalogItem {
  type: string;
  name: string;
  description?: string;
}

export interface PlannerDecision {
  pickedType: string;
  reason: string;
  planner: "llm" | "rules";
}

const plannerSchema = z.object({
  pickedType: z.string().describe("type of the best-fit agent from the catalog"),
  reason: z.string().describe("one-sentence reason in the user's language")
});

export async function pickAgentWithLLM(
  catalog: PlannerCatalogItem[],
  goal: string
): Promise<PlannerDecision | null> {
  const model = getModel();
  if (!model || catalog.length === 0) return null;

  const catalogDump = catalog
    .map((item) => `- type: ${item.type} | name: ${item.name} | ${item.description ?? ""}`)
    .join("\n");

  try {
    const result = await generateObject({
      model,
      schema: plannerSchema,
      system:
        "You are an agent-routing planner. Given a user's growth goal and a catalog of available agents, pick exactly one agent type from the catalog that fits best. Respond with its exact type and a short reason in the user's language.",
      prompt: `Catalog:\n${catalogDump}\n\nUser goal: ${goal}`
    });

    const picked = result.object.pickedType;
    if (!catalog.some((item) => item.type === picked)) return null;

    return {
      pickedType: picked,
      reason: result.object.reason,
      planner: "llm"
    };
  } catch {
    return null;
  }
}

/** 规则兜底:关键词重合度打分(与前端旧逻辑一致,服务端化) */
export function pickAgentWithRules(
  catalog: PlannerCatalogItem[],
  goal: string
): PlannerDecision | null {
  if (catalog.length === 0) return null;
  const q = goal.toLowerCase();
  let best: { item: PlannerCatalogItem; score: number } | null = null;

  for (const item of catalog) {
    const haystack = `${item.name} ${item.description ?? ""}`.toLowerCase();
    let score = 0;
    for (const word of q.split(/[\s,，。.;；]+/).filter(Boolean)) {
      if (
        haystack.includes(word) ||
        haystack.includes(word.slice(0, Math.min(4, word.length)))
      ) {
        score += 2;
      }
    }
    if (!best || score > best.score) best = { item, score };
  }

  if (!best) return null;
  return {
    pickedType: best.item.type,
    reason: "keyword match",
    planner: "rules"
  };
}

// ---------------------------------------------------------------------------
// Streaming generation (for real-time AI responses via SSE)
// ---------------------------------------------------------------------------

export async function streamGenerate(
  templateType: "content_acquisition" | "private_conversion" | "weekly_review",
  input: TemplateInputPayload
): Promise<{ result: unknown; isMock: boolean }> {
  if (templateType === "content_acquisition") {
    const result = await generateContentBrief(input);
    return { result, isMock: !isAiAvailable() };
  }
  if (templateType === "private_conversion") {
    const result = await generateConversionCopy(input);
    return { result, isMock: !isAiAvailable() };
  }
  const result = await generateWeeklyReview(input);
  return { result, isMock: !isAiAvailable() };
}

// ---------------------------------------------------------------------------
// Mock fallbacks (used when no AI provider is configured)
// ---------------------------------------------------------------------------

function mockContentBrief(input: TemplateInputPayload): GenerationResult {
  const businessSummary = String(input.businessSummary ?? "campaign");
  return {
    contentAngles: [
      `Hook angle for ${businessSummary}`,
      `Proof angle for ${businessSummary}`,
      `CTA angle for ${businessSummary}`
    ],
    channelRecommendations: Array.isArray(input.preferredChannels)
      ? input.preferredChannels as string[]
      : []
  };
}

function mockConversionCopy(input: TemplateInputPayload): ConversionResult {
  return {
    conversionDraft: `Draft conversion message for ${String(input.offerAsset ?? "offer")}`
  };
}

function mockWeeklyReview(input: TemplateInputPayload): ReviewResult {
  const businessSummary = String(input.businessSummary ?? "business");
  return {
    reviewSummary: `Weekly review for ${businessSummary}`,
    nextActions: [
      "Double down on the best-performing channel",
      "Archive one low-performing tactic"
    ]
  };
}

function mockBrowserInsights(input: TemplateInputPayload): BrowserInsightsResult {
  const channels = Array.isArray(input.preferredChannels)
    ? input.preferredChannels as string[]
    : [];
  return {
    extractedInsights: [
      `${String(input.targetCustomer ?? "audience")} pain point`,
      `${String(input.businessSummary ?? "campaign")} opportunity`
    ],
    channels
  };
}

// ---------------------------------------------------------------------------
// Export for testing
// ---------------------------------------------------------------------------

export { buildContentBriefPrompt, buildConversionCopyPrompt, buildWeeklyReviewPrompt };
