import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * `outbox.delivery.v1` — the delivery-intent contract for the transactional
 * Outbox dispatcher (W2, B1 §2).
 *
 * The idempotency key is a **side-effect dedup key**, not an attempt key:
 * retrying the same content yields the same key (so the dispatcher never
 * delivers it twice), while genuinely changed content (draft change) yields a
 * new key and a new delivery is legitimate. Receivers additionally dedup via
 * the `Idempotency-Key` header (webhook) / `X-NeuroClaw-Idempotency-Key` +
 * `Message-ID` (SMTP); the honest guarantee is therefore
 * "at-least-once transport + idempotency key + receiver dedup = effective
 * exactly-once" — never a bare exactly-once claim.
 *
 * Module-evaluation note: this file only touches `z` primitives and
 * `node:crypto` (both already used elsewhere in this package), so it is safe
 * from the barrel's cycles and importable in a bare vitest process.
 */

/** Business boundary for the delivery key (B1 §2.1). */
export const OUTBOX_DELIVERY_IDEMPOTENCY_SCOPE = "outbox.delivery.growth.v1";

/** Contract version recorded by producers of delivery intents. */
export const OUTBOX_DELIVERY_CONTRACT_VERSION = "outbox.delivery.v1";

/** Deterministic JSON (recursively sorted keys), mirrored from capability-matching. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export const outboxDeliveryTransportKindSchema = z.enum(["webhook", "smtp", "preview"]);
export type OutboxDeliveryTransportKind = z.infer<typeof outboxDeliveryTransportKindSchema>;

/**
 * The existing delivery body (`runtime-worker/src/index.ts`: runId /
 * templateType / actionType / recipientEmail / draft), kept field-for-field so
 * the key is computed over exactly what would be sent over the wire.
 */
export const outboxDeliveryBodySchema = z
  .object({
    runId: z.string().min(1),
    templateType: z.string().min(1),
    actionType: z.string().min(1),
    recipientEmail: z.string().optional(),
    draft: z.string()
  })
  .strict();
export type OutboxDeliveryBody = z.infer<typeof outboxDeliveryBodySchema>;

/**
 * B1 §2.1 key format:
 * `run:{runId}:action:{actionType}:rcpt:{sha256(recipientEmail ?? "")[0:8]}:body:{sha256(canonicalJson(body))[0:16]}`
 *
 * The body hash is truncated to keep the key audit-friendly; attempts store the
 * full digest in `request_hash`.
 */
export function computeOutboxDeliveryIdempotencyKey(deliveryBody: OutboxDeliveryBody): string {
  const body = outboxDeliveryBodySchema.parse(deliveryBody);
  const recipientHash = sha256Hex(body.recipientEmail ?? "").slice(0, 8);
  const bodyHash = sha256Hex(canonicalJson(body)).slice(0, 16);
  return `run:${body.runId}:action:${body.actionType}:rcpt:${recipientHash}:body:${bodyHash}`;
}

/**
 * The delivery intent is what the adapter will hand to the control plane
 * (`{ status: "succeeded", payload: { deliveryIntent } }`) instead of sending
 * the side effect itself. `idempotencyKey` must be built with
 * `buildOutboxDeliveryIntent` so producers and the dispatcher agree.
 */
export const outboxDeliveryIntentSchema = z
  .object({
    transport: outboxDeliveryTransportKindSchema,
    body: outboxDeliveryBodySchema,
    idempotencyKey: z.string().min(1)
  })
  .strict();
export type OutboxDeliveryIntent = z.infer<typeof outboxDeliveryIntentSchema>;

export function buildOutboxDeliveryIntent(input: {
  transport: OutboxDeliveryTransportKind;
  body: OutboxDeliveryBody;
}): OutboxDeliveryIntent {
  const body = outboxDeliveryBodySchema.parse(input.body);
  return {
    transport: input.transport,
    body,
    idempotencyKey: computeOutboxDeliveryIdempotencyKey(body)
  };
}

/** Persisted as `outbox_events.payload` for delivery events. */
export const outboxDeliveryPayloadSchema = z
  .object({ deliveryIntent: outboxDeliveryIntentSchema })
  .strict();
export type OutboxDeliveryPayload = z.infer<typeof outboxDeliveryPayloadSchema>;

/** One row of `outbox_delivery_attempts` status (migration 0012). */
export const outboxDeliveryAttemptStatusSchema = z.enum(["started", "succeeded", "failed"]);
export type OutboxDeliveryAttemptStatus = z.infer<typeof outboxDeliveryAttemptStatusSchema>;

export const outboxDeliveryReceiptSchema = z
  .object({
    ok: z.boolean(),
    httpStatus: z.number().int().optional(),
    detail: z.string().optional()
  })
  .strict();
export type OutboxDeliveryReceipt = z.infer<typeof outboxDeliveryReceiptSchema>;

/**
 * The envelope an `OutboxTransport` receives. `attemptNumber` is 1-based and
 * carried for retry/audit; transports must treat `idempotencyKey` as the
 * receiver-side dedup header value.
 */
export const outboxDeliveryEnvelopeSchema = z
  .object({
    eventId: z.string().min(1),
    idempotencyScope: z.string().min(1),
    idempotencyKey: z.string().min(1),
    transport: outboxDeliveryTransportKindSchema,
    attemptNumber: z.number().int().positive(),
    body: outboxDeliveryBodySchema
  })
  .strict();
export type OutboxDeliveryEnvelope = z.infer<typeof outboxDeliveryEnvelopeSchema>;

/**
 * The injectable delivery seam. W2 ships only injected/test transports; real
 * webhook/SMTP transports are a later, separately authorized slice.
 */
export interface OutboxTransport {
  deliver(envelope: OutboxDeliveryEnvelope): Promise<OutboxDeliveryReceipt>;
}

export type InMemoryTransportHandler = (
  envelope: OutboxDeliveryEnvelope
) => OutboxDeliveryReceipt | Promise<OutboxDeliveryReceipt>;

/**
 * Test transport: records every delivered envelope (including failed attempts,
 * which are pushed before the handler runs) and returns `{ ok: true }` unless a
 * handler simulates a rejection/throw.
 */
export class InMemoryTransport implements OutboxTransport {
  readonly deliveries: OutboxDeliveryEnvelope[] = [];
  private readonly handler?: InMemoryTransportHandler;

  constructor(handler?: InMemoryTransportHandler) {
    this.handler = handler;
  }

  async deliver(envelope: OutboxDeliveryEnvelope): Promise<OutboxDeliveryReceipt> {
    this.deliveries.push(envelope);
    if (!this.handler) return { ok: true };
    return this.handler(envelope);
  }
}

export class RealOutboxTransportNotAuthorizedError extends Error {
  readonly code = "REAL_TRANSPORT_NOT_AUTHORIZED";

  constructor(kind: string) {
    super(
      `未授权真实投递：拒绝注册/调用真实 '${kind}' transport —— W2 切片仅允许注入式 transport；` +
        `真实网络/SMTP/webhook 投递受 SSOT 停止线约束 (production: NOT_AUTHORIZED)`
    );
  }
}

/**
 * Registration seam for real transports, deliberately left empty per the GM
 * boundary (2026-09-27): calling it is an explicit error, never a silent
 * fallback. A later authorized slice replaces this stub behind the same
 * `OutboxTransport` interface, and the dispatcher stays unchanged.
 */
export function registerRealOutboxTransport(
  kind: Exclude<OutboxDeliveryTransportKind, "preview">,
  transport: OutboxTransport
): never {
  void transport;
  throw new RealOutboxTransportNotAuthorizedError(kind);
}
