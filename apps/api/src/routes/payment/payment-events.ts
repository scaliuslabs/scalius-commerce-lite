// The one path every provider-authenticated payment fact takes into the
// kernel: claim the provider event once in webhook_events, then enqueue a
// single `payment.event` message. Webhooks, hosted buyer returns, and buyer
// reconciliation all converge here, so a replay or a webhook racing the
// buyer return is applied at most once.

import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Database } from "@scalius/database/client";
import { orders, PaymentStatus } from "@scalius/database/schema";
import {
  getPaymentGateway,
  REFUND_OBSERVED_EVENT_TYPE,
  PaymentProviderError,
  type GatewayRequest,
  type GatewaySettings,
  type PaymentEvent,
  type PaymentGateway,
} from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../../utils/api-error";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";

export type PaymentEventQueueMessage = {
  type: "payment.event";
  provider: string;
  /** The claimed webhook_events row this message completes. */
  webhookEventId?: string;
  event: PaymentEvent;
};

/** webhook_events.event_type per normalized event kind. */
export const PAYMENT_EVENT_TYPES: Record<PaymentEvent["kind"], string> = {
  confirmed: "payment.confirmed",
  failed: "payment.failed",
  cancelled: "payment.cancelled",
  refund_observed: REFUND_OBSERVED_EVENT_TYPE,
};

export type PaymentEventClaimResult =
  | { status: "queued" }
  | { status: "duplicate"; existingStatus: string }
  | { status: "retry"; error: string };

export async function claimAndEnqueuePaymentEvent(input: {
  db: Database;
  queue?: Queue;
  provider: string;
  event: PaymentEvent;
  source: string;
}): Promise<PaymentEventClaimResult> {
  const { db, event } = input;
  const eventId = buildWebhookEventId(input.provider, event.eventType, event.eventId);
  const result = {
    source: input.source,
    sourceEventId: event.eventId,
    providerRef: event.providerRef,
    secondaryRef: event.secondaryRef ?? null,
  };
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: input.provider,
    eventType: PAYMENT_EVENT_TYPES[event.kind],
    orderId: event.orderId,
    status: "processing",
    result,
  });
  if (!claim.claimed) return { status: "duplicate", existingStatus: claim.existing?.status ?? "unknown" };

  if (!input.queue) {
    await markWebhookEventFailed(db, eventId, { ...result, error: "Queue not available" });
    return { status: "retry", error: "Queue not available" };
  }
  const message: PaymentEventQueueMessage = {
    type: "payment.event",
    provider: input.provider,
    webhookEventId: eventId,
    event,
  };
  try {
    await input.queue.send(message);
    await markWebhookEventQueued(db, eventId, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markWebhookEventFailed(db, eventId, { ...result, error: message });
    return { status: "retry", error: message };
  }
  return { status: "queued" };
}

export async function toGatewayRequest(c: Context): Promise<GatewayRequest> {
  return {
    method: c.req.method,
    rawBody: c.req.method === "POST" ? await c.req.text() : "",
    headers: c.req.raw.headers,
    query: c.req.query(),
  };
}

/**
 * Saved settings for authenticating provider callbacks. A gateway may be
 * disabled after a buyer left for the provider, so callbacks keep working
 * while readable credentials remain; unreadable credentials fail closed.
 */
export async function loadCallbackSettings(
  gateway: PaymentGateway,
  db: Database,
  env: Env,
): Promise<{ status: "ready"; settings: GatewaySettings } | { status: "skipped" } | { status: "unavailable" }> {
  let settings: GatewaySettings | null;
  try {
    settings = await gateway.loadSettings(db, getCredentialEncryptionKey(env as unknown as Record<string, unknown>));
  } catch (error) {
    console.error(`[payments] ${gateway.id} settings read failed:`, error instanceof Error ? error.message : error);
    return { status: "unavailable" };
  }
  if (!settings) return { status: "skipped" };
  if (settings.credentialErrors?.length) {
    console.error(`[payments] ${gateway.id} credentials are not readable`);
    return { status: "unavailable" };
  }
  return gateway.canVerify(settings) ? { status: "ready", settings } : { status: "skipped" };
}

export type PaymentReconciliationResult = {
  status: "pending" | "scheduled" | "settled";
  providerStatus: string | null;
};

/** Ask the order's gateway whether its recorded session was captured, and apply it once if so. */
export async function reconcileOrderPayment(input: {
  db: Database;
  env: Env;
  orderId: string;
  /** The gateway the caller expects; must match the order's current gateway. */
  provider?: string;
}): Promise<{ data: PaymentReconciliationResult; accepted: boolean }> {
  const order = await input.db.select({
    id: orders.id,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paymentIntentId: orders.paymentIntentId,
  }).from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  const gateway = getPaymentGateway(order.paymentMethod);
  if (!gateway?.query || !order.paymentIntentId || (input.provider && input.provider !== gateway.id)) {
    throw new ValidationError("This order does not have an online payment to verify.");
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    return { data: { status: "settled", providerStatus: null }, accepted: false };
  }

  const unavailable = new ServiceUnavailableError(`${gateway.label} payment verification is temporarily unavailable.`);
  const loaded = await loadCallbackSettings(gateway, input.db, input.env);
  if (loaded.status !== "ready" || !loaded.settings.enabled) throw unavailable;
  let query: Awaited<ReturnType<NonNullable<PaymentGateway["query"]>>>;
  try {
    query = await withPaymentProviderDeadline(
      gateway.label,
      (_signal, requestTimeoutMs) => gateway.query!(loaded.settings, { providerRef: order.paymentIntentId!, orderId: order.id }, requestTimeoutMs),
    );
  } catch (error) {
    if (error instanceof PaymentProviderError) throw unavailable;
    throw error;
  }
  if (!query.event) return { data: { status: "pending", providerStatus: query.providerStatus }, accepted: false };

  const claim = await claimAndEnqueuePaymentEvent({
    db: input.db,
    queue: input.env.JOBS_QUEUE,
    provider: gateway.id,
    event: query.event,
    source: "buyer_receipt_reconciliation",
  });
  if (claim.status === "retry") throw unavailable;
  if (claim.status === "duplicate") {
    return {
      data: { status: claim.existingStatus === "processed" ? "settled" : "scheduled", providerStatus: query.providerStatus },
      accepted: false,
    };
  }
  return { data: { status: "scheduled", providerStatus: query.providerStatus }, accepted: true };
}
