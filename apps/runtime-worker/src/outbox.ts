// ---------------------------------------------------------------------------
// W2 outbox delivery — runtime-worker slot (B1 §2.4 / §2.5).
//
// B1 §2.4 places the real webhook/SMTP transports here
// (`apps/runtime-worker/src/outbox.ts`), while the dispatcher lives in
// control-plane. This default-off slice (stop-line compliant) ships two
// things:
//
//   1. Intent production (§2.5): when the outbox kill switch is ON, the
//      notification adapter stops sending and returns a `deliveryIntent`
//      built by `buildNotificationDeliveryIntent` instead.
//   2. The transport slot (§2.4): `createNotificationOutboxTransport` is the
//      one place a future, separately authorized slice fills in real
//      fetch/sendMail behavior. Until then it throws
//      `RealOutboxTransportNotAuthorizedError` (the same sentinel as
//      `registerRealOutboxTransport` in @neuroclaw/shared) — never a silent
//      no-op and never a network call.
//
// Kill switch: `NEUROCLAW_OUTBOX_DISPATCH_ENABLED === "1"` only (literal).
// Off (the default) keeps the adapter's legacy behavior byte-for-byte; the
// control-plane dispatcher parses the same variable in
// `resolveOutboxDispatchConfig`.
//
// Wiring status: the control-plane "enqueue in the same transaction as the
// runs projection" step (§2.5, second half) is wired (same-tx enqueue in
// control-plane, 34eaa17) — keep the switch off until dispatch is authorized.
// ---------------------------------------------------------------------------

import {
  buildOutboxDeliveryIntent,
  RealOutboxTransportNotAuthorizedError,
  type AdapterActionType,
  type OutboxDeliveryIntent,
  type OutboxDeliveryTransportKind,
  type OutboxTransport,
  type Run
} from "@neuroclaw/shared";

export const NOTIFICATION_INTENT_MODE_ENV = "NEUROCLAW_OUTBOX_DISPATCH_ENABLED";

/** Literal `"1"` only — mirrors control-plane `resolveOutboxDispatchConfig`. */
export function isNotificationIntentModeEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  return env[NOTIFICATION_INTENT_MODE_ENV] === "1";
}

/** Intent transports are the two real channels; preview stays a local fallback. */
export type NotificationIntentTransport = Exclude<OutboxDeliveryTransportKind, "preview">;

/**
 * §2.5 intent production: the exact delivery body of the legacy webhook/SMTP
 * sends (`runId/templateType/actionType/recipientEmail/draft`), wrapped in the
 * shared `outbox.delivery.v1` contract. Delegating to
 * `buildOutboxDeliveryIntent` keeps the key identical to the dispatcher's
 * expectation (same-key-same-payload guard).
 */
export function buildNotificationDeliveryIntent(input: {
  transport: NotificationIntentTransport;
  run: Pick<Run, "id" | "templateType" | "input">;
  actionType: AdapterActionType;
  draft: string;
}): OutboxDeliveryIntent {
  const recipientEmail =
    typeof input.run.input.recipientEmail === "string" ? input.run.input.recipientEmail : "";

  return buildOutboxDeliveryIntent({
    transport: input.transport,
    body: {
      runId: input.run.id,
      templateType: input.run.templateType,
      actionType: input.actionType,
      recipientEmail: recipientEmail || undefined,
      draft: input.draft
    }
  });
}

/**
 * §2.4 transport slot. The future authorized slice implements the real
 * webhook POST / SMTP send here behind the unchanged `OutboxTransport`
 * interface; today every call is an explicit refusal.
 */
export function createNotificationOutboxTransport(
  kind: NotificationIntentTransport
): OutboxTransport {
  throw new RealOutboxTransportNotAuthorizedError(`runtime-worker/${kind}`);
}
