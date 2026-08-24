import { InMemoryTraceLog } from "@neuroclaw/observability";
import { evaluateActionPolicy, evaluateRunPolicy } from "@neuroclaw/policy";
import {
  appendRunStepResult,
  transitionRun,
  type AdapterActionResult,
  type AdapterActionType,
  type ApprovalRequest,
  type Run,
  type RuntimeEvent,
  type Template
} from "@neuroclaw/shared";
import {
  getTemplateByType,
  globalRegistry,
  type TemplateRegistry
} from "@neuroclaw/templates";
import {
  generateBrowserInsights,
  generateContentBrief,
  generateConversionCopy,
  generateWeeklyReview,
  isAiAvailable
} from "@neuroclaw/agent-core";
import {
  OperatorBrowser,
  isBrowserAvailable,
  closeOperatorBrowser
} from "@neuroclaw/operator-browser";
import {
  getMcpRegistry,
  isMcpAvailable
} from "@neuroclaw/tooling-mcp";
import { generateStructuredForAgent } from "@neuroclaw/agent-core";

import {
  closeSmtpTransporter,
  getSmtpTransporter,
  isSmtpConfigured
} from "./smtp.js";

export interface RuntimeExecutionResult {
  run: Run;
  templateId: string;
  events: RuntimeEvent[];
  approvalRequest?: ApprovalRequest;
}

interface AdapterRegistry {
  browser: BrowserAdapter;
  mcp: McpAdapter;
  notification: NotificationAdapter;
}

interface BrowserAdapter {
  execute(actionType: AdapterActionType, run: Run): Promise<AdapterActionResult>;
}

interface McpAdapter {
  execute(
    actionType: AdapterActionType,
    run: Run,
    degraded: boolean,
    template?: Template
  ): Promise<AdapterActionResult>;
}

interface NotificationAdapter {
  execute(actionType: AdapterActionType, run: Run): Promise<AdapterActionResult>;
}

function makeBrowserAdapter(): BrowserAdapter {
  let browser: OperatorBrowser | null = null;

  return {
    async execute(actionType, run) {
      try {
        const targetUrl = typeof run.input.targetUrl === "string"
          ? run.input.targetUrl
          : typeof run.input.url === "string"
            ? run.input.url
            : null;

        // Try real browser extraction when a URL is provided and browser is available
        if (targetUrl && isBrowserAvailable()) {
          if (!browser) {
            browser = new OperatorBrowser({ headless: true });
          }
          const page = await browser.extract(targetUrl, { maxTextLength: 8_000 });
          return {
            status: "succeeded",
            actionType,
            summary: `Extracted real page content from ${targetUrl}`,
            payload: {
              extractedInsights: [
                page.title,
                page.description,
                ...page.headings.slice(0, 3).map((h) => h.text)
              ].filter(Boolean),
              channels: page.links.slice(0, 5).map((l) => l.href),
              sourceUrl: page.finalUrl,
              pageTitle: page.title,
              textPreview: page.textContent.slice(0, 500)
            }
          };
        }

        // Fallback: AI-powered browser insights (no real URL)
        const result = await generateBrowserInsights(run.input);
        return {
          status: "succeeded",
          actionType,
          summary: isAiAvailable()
            ? "AI-powered browser insights extracted"
            : "Collected browser-side signals (mock mode)",
          payload: result as unknown as Record<string, unknown>
        };
      } catch (error) {
        return {
          status: "failed",
          actionType,
          summary: `Browser extraction failed: ${error instanceof Error ? error.message : "unknown"}`
        };
      }
    }
  };
}

function makeMcpAdapter(registry: TemplateRegistry = globalRegistry): McpAdapter {
  return {
    async execute(actionType, run, degraded, template) {
      try {
        // Try real MCP tool calling when MCP servers are configured
        if (isMcpAvailable()) {
          const registry = getMcpRegistry();
          await registry.connectAll();

          const toolMap: Record<string, string> = {
            mcp_generate_brief: "generate_brief",
            mcp_generate_conversion_copy: "generate_conversion_copy",
            mcp_generate_review: "generate_review"
          };

          const mcpToolName = toolMap[actionType];
          if (mcpToolName) {
            const allTools = registry.listAllTools();
            const matched = allTools.find((t) => t.tool.name === mcpToolName);
            if (matched) {
              const { result: toolResult } = await registry.callTool(mcpToolName, run.input);
              const textParts = toolResult.content
                .filter((c) => c.text)
                .map((c) => c.text as string);
              const textOutput = textParts.join("\n");

              return {
                status: "succeeded",
                actionType,
                summary: `MCP tool '${mcpToolName}' called via '${matched.connection}'`,
                payload: {
                  output: textOutput,
                  toolName: mcpToolName,
                  connection: matched.connection
                }
              };
            }
          }
        }

        // Fallback: AI-powered generation
        const activeTemplate =
          template ?? registry.get(run.templateType) ?? getTemplateByType(run.templateType);

        // Custom agents (persona-driven) — dynamic structured generation
        if (activeTemplate.persona && !isBuiltinEngine(run.templateType)) {
          const focus = [] as string[];
          const result = await generateStructuredForAgent({
            persona: activeTemplate.persona,
            instruction: `Action: ${actionType}. Deliver the "${activeTemplate.name}" output for this run.`,
            fields: activeTemplate.outputContract.fields,
            input: run.input
          });
          void focus;
          return {
            status: degraded ? "degraded" : "succeeded",
            actionType,
            summary: isAiAvailable()
              ? `AI output generated by ${activeTemplate.name}`
              : `Generated ${activeTemplate.name} output (mock mode)`,
            payload: result,
            degraded
          };
        }

        if (actionType === "mcp_generate_brief") {
          const result = await generateContentBrief(run.input);
          return {
            status: degraded ? "degraded" : "succeeded",
            actionType,
            summary: isAiAvailable()
              ? "AI-generated content brief"
              : degraded
                ? "Generated degraded content brief (mock mode)"
                : "Generated content brief (mock mode)",
            payload: result as unknown as Record<string, unknown>,
            degraded
          };
        }

        if (actionType === "mcp_generate_conversion_copy") {
          const result = await generateConversionCopy(run.input);
          return {
            status: "succeeded",
            actionType,
            summary: isAiAvailable()
              ? "AI-generated conversion draft"
              : "Generated conversion draft (mock mode)",
            payload: result as unknown as Record<string, unknown>
          };
        }

        const result = await generateWeeklyReview(run.input);
        return {
          status: "succeeded",
          actionType,
          summary: isAiAvailable()
            ? "AI-generated weekly review"
            : "Generated weekly review (mock mode)",
          payload: result as unknown as Record<string, unknown>
        };
      } catch (error) {
        return {
          status: "failed",
          actionType,
          summary: `MCP generation failed: ${error instanceof Error ? error.message : "unknown"}`
        };
      }
    }
  };
}

function makeNotificationAdapter(): NotificationAdapter {
  return {
    async execute(actionType, run) {
      const draft = `Conversion message for ${String(
        run.input.offerAsset ?? run.input.businessSummary ?? "run"
      )}`;
      const recipientEmail = typeof run.input.recipientEmail === "string"
        ? run.input.recipientEmail
        : "";

      // 1. Webhook delivery — external system owns the channel distribution.
      const webhookUrl = process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL;
      if (webhookUrl) {
        try {
          const response = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              runId: run.id,
              templateType: run.templateType,
              actionType,
              recipientEmail: recipientEmail || undefined,
              draft
            }),
            signal: AbortSignal.timeout(10_000)
          });

          if (!response.ok) {
            throw new Error(`webhook responded ${response.status}`);
          }

          return {
            status: "succeeded",
            actionType,
            summary: "Delivered via webhook",
            payload: {
              deliveryChannel: "webhook",
              approvalPreview: draft
            }
          };
        } catch (error) {
          return {
            status: "failed",
            actionType,
            summary: `Webhook delivery failed: ${error instanceof Error ? error.message : "unknown"}`
          };
        }
      }

      // 2. SMTP email delivery when configured with a recipient.
      if (isSmtpConfigured() && recipientEmail) {
        try {
          const transporter = await getSmtpTransporter();
          if (transporter) {
            await transporter.sendMail({
              to: recipientEmail,
              subject: draft.slice(0, 78),
              text: draft
            });

            return {
              status: "succeeded",
              actionType,
              summary: `Delivered via SMTP email to ${recipientEmail}`,
              payload: {
                deliveryChannel: "smtp",
                recipientEmail,
                approvalPreview: draft
              }
            };
          }
        } catch (error) {
          return {
            status: "failed",
            actionType,
            summary: `SMTP delivery failed: ${error instanceof Error ? error.message : "unknown"}`
          };
        }
      }

      // 3. Preview mode fallback — no external delivery configured.
      return {
        status: "succeeded",
        actionType,
        summary: "Prepared approval preview notification",
        payload: {
          approvalPreview: draft
        }
      };
    }
  };
}

function collectOutput(
  template: Template,
  actionResults: AdapterActionResult[],
  registry: TemplateRegistry = globalRegistry
): Record<string, unknown> {
  const merged = actionResults.reduce<Record<string, unknown>>((accumulator, result) => {
    if (result.payload) {
      Object.assign(accumulator, result.payload);
    }

    return accumulator;
  }, {});

  return registry.formatOutput(template.type, merged);
}

export const BUILTIN_ENGINES = new Set([
  "content_acquisition",
  "private_conversion",
  "weekly_review"
]);

function isBuiltinEngine(templateType: string): boolean {
  return BUILTIN_ENGINES.has(templateType);
}

export class RuntimeWorker {
  private readonly adapters: AdapterRegistry;
  private readonly registry: TemplateRegistry;
  private readonly traceLog: InMemoryTraceLog;

  constructor(traceLog = new InMemoryTraceLog(), registry: TemplateRegistry = globalRegistry) {
    this.traceLog = traceLog;
    this.registry = registry;
    this.adapters = {
      browser: makeBrowserAdapter(),
      mcp: makeMcpAdapter(registry),
      notification: makeNotificationAdapter()
    };
  }

  async acceptRun(run: Run): Promise<RuntimeExecutionResult> {
    const running = transitionRun(run, "running");
    return this.executeTemplate(running, []);
  }

  async resumeApprovedRun(
    run: Run,
    approvedActions: AdapterActionType[]
  ): Promise<RuntimeExecutionResult> {
    const resumed = run.status === "waiting_approval" ? transitionRun(run, "running") : run;
    return this.executeTemplate(resumed, approvedActions);
  }

  async shutdown(): Promise<void> {
    await closeOperatorBrowser();
    await closeSmtpTransporter();
    if (isMcpAvailable()) {
      const registry = getMcpRegistry();
      await registry.disconnectAll();
    }
  }

  private async executeTemplate(
    run: Run,
    approvedActions: AdapterActionType[]
  ): Promise<RuntimeExecutionResult> {
    const template =
      this.registry.get(run.templateType) ?? getTemplateByType(run.templateType);
    this.registry.validateInput(run.templateType, run.input);

    const preflight = evaluateRunPolicy(run);
    if (preflight.decision === "deny") {
      return this.failRun(run, template, "Run denied by preflight policy");
    }

    const events: RuntimeEvent[] = [
      {
        type: "run_accepted",
        runId: run.id,
        details: `Accepted template ${template.id}`
      },
      {
        type: "contract_validated",
        runId: run.id,
        details: "Template input contract validated"
      }
    ];

    const actionResults: AdapterActionResult[] = [];
    let nextRun = run;

    for (const action of template.supportedActions) {
      events.push({
        type: "step_started",
        runId: run.id,
        stepId: action.id,
        details: `Starting ${action.actionType}`
      });

      const policy = evaluateActionPolicy(run, template, action.actionType, {
        approvedActions
      });

      events.push({
        type: "policy_evaluated",
        runId: run.id,
        stepId: action.id,
        details: policy.reason
      });

      if (policy.decision === "deny") {
        return this.failRun(
          appendRunStepResult(nextRun, {
            stepId: action.id,
            actionType: action.actionType,
            status: "failed",
            summary: policy.reason
          }),
          template,
          policy.reason,
          events
        );
      }

      if (policy.decision === "require_approval") {
        const waitingRun = appendRunStepResult(
          {
            ...transitionRun(nextRun, "waiting_approval"),
            approvalStatus: "pending"
          },
          {
            stepId: action.id,
            actionType: action.actionType,
            status: "waiting_approval",
            summary: policy.reason
          }
        );

        const approvalRequest: ApprovalRequest = {
          id: `apr_${run.id}_${action.id}`,
          runId: run.id,
          actionType: action.actionType,
          reason: policy.reason,
          status: "pending",
          requestedAt: new Date().toISOString()
        };

        events.push({
          type: "approval_requested",
          runId: run.id,
          stepId: action.id,
          details: policy.reason
        });

        return {
          run: waitingRun,
          templateId: template.id,
          events,
          approvalRequest
        };
      }

      const degraded = policy.decision === "degrade";
      let result: AdapterActionResult;

      if (action.adapter === "mcp") {
        result = await this.adapters.mcp.execute(action.actionType, run, degraded, template);
      } else if (action.adapter === "browser") {
        result = await this.adapters.browser.execute(action.actionType, run);
      } else {
        result = await this.adapters.notification.execute(action.actionType, run);
      }

      actionResults.push(result);
      nextRun = appendRunStepResult(nextRun, {
        stepId: action.id,
        actionType: action.actionType,
        status:
          result.status === "failed"
            ? "failed"
            : degraded || result.degraded
              ? "degraded"
              : "completed",
        summary: result.summary,
        payload: result.payload
      });

      if (degraded || result.degraded) {
        events.push({
          type: "step_degraded",
          runId: run.id,
          stepId: action.id,
          details: result.summary
        });
      } else {
        events.push({
          type: "step_completed",
          runId: run.id,
          stepId: action.id,
          details: result.summary
        });
      }

      if (result.status === "failed" && action.critical) {
        return this.failRun(nextRun, template, result.summary, events);
      }
    }

    const completed = {
      ...transitionRun(nextRun, "completed"),
      outputPayload: collectOutput(template, actionResults, this.registry),
      currentStep: null
    };

    this.traceLog.record({
      scope: "runtime-worker",
      action: "run_completed",
      metadata: {
        runId: run.id,
        templateType: run.templateType
      }
    });

    events.push({
      type: "run_completed",
      runId: run.id,
      details: "Template execution completed"
    });

    return {
      run: completed,
      templateId: template.id,
      events
    };
  }

  private failRun(
    run: Run,
    template: Template,
    reason: string,
    events: RuntimeEvent[] = []
  ): RuntimeExecutionResult {
    const failed = {
      ...transitionRun(run, "failed"),
      failureReason: reason,
      currentStep: null
    };

    this.traceLog.record({
      scope: "runtime-worker",
      action: "run_failed",
      metadata: {
        runId: run.id,
        templateType: template.type
      }
    });

    events.push({
      type: "run_failed",
      runId: run.id,
      details: reason
    });

    return {
      run: failed,
      templateId: template.id,
      events
    };
  }
}
