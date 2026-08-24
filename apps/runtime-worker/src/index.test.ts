import { afterEach, describe, expect, it, vi } from "vitest";

import type { Run } from "@neuroclaw/shared";

import { RuntimeWorker } from "./index.js";

function makeRun(templateType: Run["templateType"], input: Run["input"]): Run {
  return {
    id: `run_${templateType}`,
    workspaceId: "ws_1",
    templateType,
    status: "queued",
    input,
    currentStep: null,
    approvalStatus: "not_required",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

function makeApprovedConversionRun(input: Run["input"]): Run {
  return {
    ...makeRun("private_conversion", {
      businessSummary: "Draft a high-touch conversion path",
      targetCustomer: "Warm inbound leads",
      preferredChannels: ["email"],
      offerAsset: "VIP audit",
      ...input
    }),
    status: "waiting_approval",
    approvalStatus: "approved"
  };
}

const ENV_SNAPSHOT = { ...process.env };

afterEach(async () => {
  process.env = { ...ENV_SNAPSHOT };
  vi.unstubAllGlobals();
});

describe("runtime worker", () => {
  it("completes the content acquisition happy path", async () => {
    const worker = new RuntimeWorker();
    const result = await worker.acceptRun(
      makeRun("content_acquisition", {
        businessSummary: "Launch a growth sprint",
        targetCustomer: "SMB operators",
        preferredChannels: ["linkedin", "email"],
        contentGoal: "Generate three hooks"
      })
    );

    expect(result.run.status).toBe("completed");
    expect(result.run.outputPayload?.contentAngles).toBeDefined();
  });

  it("requests approval for private conversion preview send", async () => {
    const worker = new RuntimeWorker();
    const result = await worker.acceptRun(
      makeRun("private_conversion", {
        businessSummary: "Draft a high-touch conversion path",
        targetCustomer: "Warm inbound leads",
        preferredChannels: ["email"],
        offerAsset: "VIP audit"
      })
    );

    expect(result.run.status).toBe("waiting_approval");
    expect(result.approvalRequest?.actionType).toBe("notification_send_preview");
  });

  it("degrades the content brief when too many channels are requested", async () => {
    const worker = new RuntimeWorker();
    const result = await worker.acceptRun(
      makeRun("content_acquisition", {
        businessSummary: "Launch a growth sprint",
        targetCustomer: "SMB operators",
        preferredChannels: ["linkedin", "email", "x", "youtube"],
        contentGoal: "Generate three hooks"
      })
    );

    expect(result.run.status).toBe("completed");
    expect(result.events.some((event) => event.type === "step_degraded")).toBe(true);
  });

  it("delivers approved preview via webhook when configured", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL = "https://hooks.example.com/neuroclaw";

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({}),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("completed");
    const deliveryStep = result.run.stepResults?.find(
      (step) => step.actionType === "notification_send_preview"
    );
    expect(deliveryStep?.summary).toBe("Delivered via webhook");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const [url, init] = calls[0];
    expect(url).toBe("https://hooks.example.com/neuroclaw");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body)) as { runId: string; draft: string };
    expect(body.runId).toBe("run_private_conversion");
    expect(body.draft).toContain("VIP audit");
  });

  it("fails the delivery step when the webhook responds with an error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "boom" }), { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock);
    process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL = "https://hooks.example.com/neuroclaw";

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({}),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("failed");
    expect(result.run.failureReason).toContain("Webhook delivery failed");
  });

  it("falls back to preview mode when SMTP is configured but nodemailer is missing", async () => {
    process.env.NEUROCLAW_SMTP_HOST = "smtp.example.com";
    delete process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL;

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({ recipientEmail: "owner@example.com" }),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("completed");
    const deliveryStep = result.run.stepResults?.find(
      (step) => step.actionType === "notification_send_preview"
    );
    expect(deliveryStep?.summary).toBe("Prepared approval preview notification");
  });

  it("keeps preview mode when no delivery channel is configured", async () => {
    delete process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL;
    delete process.env.NEUROCLAW_SMTP_HOST;
    delete process.env.NEUROCLAW_SMTP_URL;

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({}),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("completed");
    const deliveryStep = result.run.stepResults?.find(
      (step) => step.actionType === "notification_send_preview"
    );
    expect(deliveryStep?.summary).toBe("Prepared approval preview notification");
  });
});
