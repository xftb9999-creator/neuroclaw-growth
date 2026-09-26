// ---------------------------------------------------------------------------
// W2 slice B tests — runtime-worker side (B1 §2.4 transport slot + §2.5
// adapter intent production), the `apps/runtime-worker/src/outbox.test.ts`
// acceptance command from B1 L89.
//
// Assertion map (B1 L93 six assertions live in
// `apps/control-plane/src/round-w2.test.ts`; this file covers the
// runtime-worker side of the same contract):
//   - §2.7 kill switch: literal "1" only, default-off.
//   - §2.5 default-off: legacy webhook send stays byte-for-byte.
//   - §2.5 intent mode: webhook/SMTP sends stop; payload carries a
//     `deliveryIntent` whose key matches the shared formula (assertion ①'s
//     producer side: same body → same key, changed draft → new key).
//   - §2.4 transport slot: real transports refuse explicitly (no network).
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOutboxDeliveryIntent,
  RealOutboxTransportNotAuthorizedError,
  type OutboxDeliveryIntent,
  type Run,
  type RunStepResult
} from "@neuroclaw/shared";

import { RuntimeWorker } from "./index.js";
import {
  buildNotificationDeliveryIntent,
  createNotificationOutboxTransport,
  isNotificationIntentModeEnabled,
  NOTIFICATION_INTENT_MODE_ENV
} from "./outbox.js";
import * as smtp from "./smtp.js";

// The intent path must not even acquire the SMTP transporter; keep the real
// `isSmtpConfigured` (env-driven) and replace only the transporter getter.
vi.mock("./smtp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./smtp.js")>();
  return { ...actual, getSmtpTransporter: vi.fn(async () => null) };
});

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

function deliveryIntentOf(step: RunStepResult | undefined): OutboxDeliveryIntent | undefined {
  const payload = step?.payload as { deliveryIntent?: OutboxDeliveryIntent } | undefined;
  return payload?.deliveryIntent;
}

function notificationStep(result: { run: Run }): RunStepResult | undefined {
  return result.run.stepResults?.find(
    (step) => step.actionType === "notification_send_preview"
  );
}

const ENV_SNAPSHOT = { ...process.env };

afterEach(() => {
  process.env = { ...ENV_SNAPSHOT };
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("runtime-worker outbox (B1 §2.4/§2.5)", () => {
  it("kill switch (§2.7): only the literal \"1\" enables intent mode (default-off)", () => {
    const env = (value: string | undefined) =>
      value === undefined ? {} : { [NOTIFICATION_INTENT_MODE_ENV]: value };

    for (const value of [undefined, "", "0", "true", "TRUE", "yes", "01", "1 ", " 1", "on"]) {
      expect(isNotificationIntentModeEnabled(env(value))).toBe(false);
    }
    expect(isNotificationIntentModeEnabled(env("1"))).toBe(true);
  });

  it("default-off (§2.5): the legacy webhook send is untouched and carries no intent", async () => {
    delete process.env[NOTIFICATION_INTENT_MODE_ENV];
    process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL = "https://hooks.example.com/neuroclaw";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(makeApprovedConversionRun({}), [
      "notification_send_preview"
    ]);

    expect(result.run.status).toBe("completed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const step = notificationStep(result);
    expect(step?.summary).toBe("Delivered via webhook");
    expect(deliveryIntentOf(step)).toBeUndefined();
  });

  it("intent mode (§2.5): webhook configured → intent recorded, fetch never called", async () => {
    process.env[NOTIFICATION_INTENT_MODE_ENV] = "1";
    process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL = "https://hooks.example.com/neuroclaw";
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({ recipientEmail: "owner@example.com" }),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("completed");
    expect(fetchMock).not.toHaveBeenCalled();

    const step = notificationStep(result);
    expect(step?.summary).toBe("Recorded webhook delivery intent for outbox dispatch");
    // Template output contract: `approvalPreview` must survive the intent path.
    expect((step?.payload as { approvalPreview?: string } | undefined)?.approvalPreview).toBe(
      "Conversion message for VIP audit"
    );
    const intent = deliveryIntentOf(step);
    expect(intent).toBeDefined();
    expect(intent?.transport).toBe("webhook");
    expect(intent?.body).toEqual({
      runId: "run_private_conversion",
      templateType: "private_conversion",
      actionType: "notification_send_preview",
      recipientEmail: "owner@example.com",
      draft: "Conversion message for VIP audit"
    });

    // Same key as the shared contract formula for the very same body (the
    // dispatcher's same-key-same-payload guard must hold across the boundary).
    const expectedKey = buildOutboxDeliveryIntent({
      transport: "webhook",
      body: {
        runId: "run_private_conversion",
        templateType: "private_conversion",
        actionType: "notification_send_preview",
        recipientEmail: "owner@example.com",
        draft: "Conversion message for VIP audit"
      }
    }).idempotencyKey;
    expect(intent?.idempotencyKey).toBe(expectedKey);
  });

  it("intent mode (§2.5): SMTP configured → intent recorded, transporter untouched", async () => {
    process.env[NOTIFICATION_INTENT_MODE_ENV] = "1";
    delete process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL;
    process.env.NEUROCLAW_SMTP_HOST = "smtp.example.com";

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(
      makeApprovedConversionRun({ recipientEmail: "owner@example.com" }),
      ["notification_send_preview"]
    );

    expect(result.run.status).toBe("completed");
    expect(smtp.getSmtpTransporter).not.toHaveBeenCalled();

    const step = notificationStep(result);
    expect(step?.summary).toBe("Recorded SMTP delivery intent for outbox dispatch");
    expect((step?.payload as { approvalPreview?: string } | undefined)?.approvalPreview).toBe(
      "Conversion message for VIP audit"
    );
    const intent = deliveryIntentOf(step);
    expect(intent?.transport).toBe("smtp");
    expect(intent?.body.recipientEmail).toBe("owner@example.com");
    expect(intent?.idempotencyKey).toContain("action:notification_send_preview");
  });

  it("intent mode without any configured channel stays preview (no intent)", async () => {
    process.env[NOTIFICATION_INTENT_MODE_ENV] = "1";
    delete process.env.NEUROCLAW_DELIVERY_WEBHOOK_URL;
    delete process.env.NEUROCLAW_SMTP_HOST;
    delete process.env.NEUROCLAW_SMTP_URL;

    const worker = new RuntimeWorker();
    const result = await worker.resumeApprovedRun(makeApprovedConversionRun({}), [
      "notification_send_preview"
    ]);

    expect(result.run.status).toBe("completed");
    const step = notificationStep(result);
    expect(step?.summary).toBe("Prepared approval preview notification");
    expect(deliveryIntentOf(step)).toBeUndefined();
  });

  it("intent builder mirrors the shared key: same body → same key, draft change → new key", () => {
    const run = {
      id: "run_1",
      templateType: "private_conversion" as const,
      input: { recipientEmail: "a@b.c" }
    };
    const base = {
      transport: "smtp" as const,
      run,
      actionType: "notification_send_preview" as const,
      draft: "hello"
    };

    const intent = buildNotificationDeliveryIntent(base);
    const expected = buildOutboxDeliveryIntent({
      transport: "smtp",
      body: {
        runId: "run_1",
        templateType: "private_conversion",
        actionType: "notification_send_preview",
        recipientEmail: "a@b.c",
        draft: "hello"
      }
    });
    expect(intent).toEqual(expected);

    const changed = buildNotificationDeliveryIntent({ ...base, draft: "hello!" });
    expect(changed.idempotencyKey).not.toBe(intent.idempotencyKey);

    // F2 normalization crosses the boundary: "" / omitted recipientEmail agree.
    const noRecipient = buildNotificationDeliveryIntent({
      ...base,
      run: { id: "run_1", templateType: "private_conversion", input: {} }
    });
    const emptyRecipient = buildNotificationDeliveryIntent({
      ...base,
      run: { id: "run_1", templateType: "private_conversion", input: { recipientEmail: "" } }
    });
    expect(noRecipient.idempotencyKey).toBe(emptyRecipient.idempotencyKey);
  });

  it("transport slot (§2.4): real webhook/SMTP transports refuse explicitly, no network", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    for (const kind of ["webhook", "smtp"] as const) {
      expect(() => createNotificationOutboxTransport(kind)).toThrow(
        RealOutboxTransportNotAuthorizedError
      );
      try {
        createNotificationOutboxTransport(kind);
      } catch (error) {
        expect((error as RealOutboxTransportNotAuthorizedError).code).toBe(
          "REAL_TRANSPORT_NOT_AUTHORIZED"
        );
        expect((error as Error).message).toContain(`runtime-worker/${kind}`);
      }
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
