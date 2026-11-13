// The one path every provider-authenticated payment fact takes into the
// kernel: claim the provider event once in webhook_events (with the event as
// the row's payload), then apply it right after the response; the scheduled
// drain retries a failed attempt from that row (background/payment-events.ts).
// Webhooks, hosted buyer returns, and buyer reconciliation all converge here,
// so a replay or a webhook racing the buyer return is applied at most once.

import { eq } from "drizzle-orm";
import type { Context } from "hono";
import type { Database } from "@scalius/database/client";
import { orders, PaymentStatus } from "@scalius/database/schema";
import {
  REFUND_OBSERVED_EVENT_TYPE,
  canOperateExistingPayments,
  PaymentProviderError,
  type GatewayRequest,
  type GatewaySettings,
  type PaymentEvent,
  type PaymentGateway,
  paymentProvidersFor,
  type PaymentProvidersSource,
} from "@scalius/core/modules/payments";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../../utils/api-error";
import { claimProviderEvent } from "../../utils/webhook-idempotency";
import { afterResponse, executionContextOf, type BackgroundCaller } from "../../background/after-response";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";

/** webhook_events.event_type per normalized event kind. */
export const PAYMENT_EVENT_TYPES: Record<PaymentEvent["kind"], string> = {
  confirmed: "payment.confirmed",
  authorized: "payment.authorized",
  failed: "payment.failed",
  cancelled: "payment.cancelled",
  refund_observed: REFUND_OBSERVED_EVENT_TYPE,
  processing: "payment.processing",
};

export type PaymentEventClaimResult =
  | { status: "accepted" }
  | { status: "duplicate"; existingStatus: string };

/** Claims the event once, then applies it after the response (`caller`'s execution context). */
export async function claimAndApplyPaymentEvent(input: {
  db: Database;
  caller: BackgroundCaller & { env: Env };
  provider: string;
  event: PaymentEvent;
  source: string;
}): Promise<PaymentEventClaimResult> {
  const { db } = input;
  const { claim, payload } = await claimPaymentEvent(db, input);
  if (!claim.claimed) return { status: "duplicate", existingStatus: claim.existing?.status ?? "unknown" };

  const env = input.caller.env;
  await afterResponse(input.caller, `${input.provider} payment event`, async () => {
    const { applyClaimedPaymentEvent } = await import("../../background/payment-events");
    await applyClaimedPaymentEvent(db, env, executionContextOf(input.caller), { id: claim.id, attempts: 1, payload });
  });
  return { status: "accepted" };
}

/** The one claim of a provider event, under its exact identity, with the event as the row's payload. */
function claimPaymentEvent(db: Database, input: { provider: string; event: PaymentEvent; source: string }) {
  const { event } = input;
  const payload = { provider: input.provider, event };
  return claimProviderEvent(db, { provider: input.provider, eventType: event.eventType, sourceEventId: event.eventId }, {
    provider: input.provider,
    eventType: PAYMENT_EVENT_TYPES[event.kind],
    orderId: event.orderId,
    status: "processing",
    result: { source: input.source, sourceEventId: event.eventId },
    payload,
  }).then((claim) => ({ claim, payload }));
}

/**
 * The same claim, applied before returning: a command that called the
 * provider itself (an off-session charge, a capture) answers with what the
 * payment became. A duplicate (a webhook claimed the same fact first) is
 * applied by whoever claimed it.
 */
export async function claimAndApplyPaymentEventNow(input: {
  db: Database;
  env: Env;
  ctx: ExecutionContext;
  provider: string;
  event: PaymentEvent;
  source: string;
}): Promise<"processed" | "manual_reconciliation" | "retrying" | "failed" | "duplicate"> {
  const { claim, payload } = await claimPaymentEvent(input.db, input);
  if (!claim.claimed) return "duplicate";
  const { applyClaimedPaymentEvent } = await import("../../background/payment-events");
  return applyClaimedPaymentEvent(input.db, input.env, input.ctx, { id: claim.id, attempts: 1, payload });
}

/** The request as gateways read it: the exact body text, header names lowercased. */
export async function toGatewayRequest(c: Context): Promise<GatewayRequest> {
  return {
    method: c.req.method,
    rawBody: c.req.method === "POST" ? await c.req.text() : "",
    headers: Object.fromEntries(c.req.raw.headers),
    query: c.req.query(),
  };
}

/**
 * Saved settings for authenticating provider callbacks and looking a payment
 * up. Turning a gateway off stops new payments only: a buyer may have left
 * for the provider before, so callbacks and lookups keep working while
 * readable credentials remain (`canOperateExistingPayments`, the predicate
 * refunds, captures and voids share); unreadable credentials fail closed.
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
  return canOperateExistingPayments(gateway, settings) ? { status: "ready", settings } : { status: "skipped" };
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
  /** The request's gateways (built-in and app providers), read only when the order names an app's. */
  providers: PaymentProvidersSource;
  /** Where the confirmed event is applied after the response. */
  caller: BackgroundCaller & { env: Env };
}): Promise<{ data: PaymentReconciliationResult; accepted: boolean }> {
  const order = await input.db.select({
    id: orders.id,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paymentIntentId: orders.paymentIntentId,
  }).from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  const providers = await paymentProvidersFor(input.providers, order.paymentMethod);
  const gateway = providers.get(order.paymentMethod);
  if (!gateway?.queryPayment || !order.paymentIntentId || (input.provider && providers.get(input.provider) !== gateway)) {
    throw new ValidationError("This order does not have an online payment to verify.");
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    return { data: { status: "settled", providerStatus: null }, accepted: false };
  }

  const unavailable = new ServiceUnavailableError(`${gateway.label} payment verification is temporarily unavailable.`);
  const loaded = await loadCallbackSettings(gateway, input.db, input.env);
  if (loaded.status !== "ready") throw unavailable;
  let query: Awaited<ReturnType<NonNullable<PaymentGateway["queryPayment"]>>>;
  try {
    query = await withPaymentProviderDeadline(
      gateway.label,
      (signal, requestTimeoutMs) => gateway.queryPayment!(
        { providerRef: order.paymentIntentId!, orderId: order.id, requestTimeoutMs },
        { settings: loaded.settings, signal },
      ),
    );
  } catch (error) {
    if (error instanceof PaymentProviderError) throw unavailable;
    throw error;
  }
  if (!query.event) return { data: { status: "pending", providerStatus: query.providerStatus }, accepted: false };

  const claim = await claimAndApplyPaymentEvent({
    db: input.db,
    caller: input.caller,
    provider: gateway.id,
    event: query.event,
    source: "buyer_receipt_reconciliation",
  });
  if (claim.status === "duplicate") {
    return {
      data: { status: claim.existingStatus === "processed" ? "settled" : "scheduled", providerStatus: query.providerStatus },
      accepted: false,
    };
  }
  return { data: { status: "scheduled", providerStatus: query.providerStatus }, accepted: true };
}
