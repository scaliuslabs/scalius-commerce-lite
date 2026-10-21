// Applying provider-authenticated payment events. A webhook, a hosted buyer
// return or a buyer reconciliation claims the event once in `webhook_events`
// (routes/payment/payment-events.ts), with the normalized event as the row's
// payload; the event is applied right after the response, and a failed
// attempt is retried from that row by the scheduled drain with backoff
// (`retrying`, 1 to 16 minutes) until it is `failed` after six attempts, the
// state the order page shows. Applying is idempotent (the payment kernel
// dedupes on the provider reference), so a redelivery is harmless.
import type { Database } from "@scalius/database/client";
import { runWithReadObserver } from "@scalius/database/read-observer";
import {
  processPaymentAuthorized,
  processPaymentConfirmed,
  processPaymentFailed,
  type PaymentEvent,
} from "@scalius/core/modules/payments";
import { processExistingMetaPurchaseOutboxForOrder } from "@scalius/core/integrations/meta/purchase-outbox";
import { processTrackingDeliveriesForOrder } from "@scalius/core/integrations/tracking/deliveries";
import type { NotificationSender } from "@scalius/core/modules/notifications";
import { getDecimalPlaces } from "@scalius/shared/currency";
import { fromMinor } from "@scalius/shared/money";
import { planLimits } from "@scalius/shared/plan-limits";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import { sendOrderBalancePaidNotification, sendOrderCreatedNotification } from "../utils/order-notifications";
import {
  claimDuePaymentEvent,
  listDuePaymentEvents,
  markPaymentEventAttemptFailed,
  markWebhookEventManualReconciliation,
  markWebhookEventProcessed,
} from "../utils/webhook-idempotency";
import { createEventWriteObserver } from "../middleware/event-dispatch";
import { notificationSender } from "./notification-sender";
import { runOrderAutoFulfil } from "./auto-fulfil";

/** What a claimed payment event's row stores as its payload. */
export interface PaymentEventPayload {
  provider: string;
  event: PaymentEvent;
}

type Outcome = { status: "processed" | "manual_reconciliation"; result: Record<string, unknown> };

/**
 * One attempt at a claimed event: apply it and record the outcome, or record
 * the failure with backoff. Then send what it wrote (events, notifications,
 * automatic fulfilment). Never throws for a payment failure; database errors
 * while recording leave the row's lease to expire, and the drain retries.
 */
export async function applyClaimedPaymentEvent(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  claim: { id: string; attempts: number; payload: PaymentEventPayload },
): Promise<"processed" | "manual_reconciliation" | "retrying" | "failed"> {
  const send = notificationSender({ env, executionCtx: ctx });
  // Notes the realtime tables the payment writes (order_payments), so the
  // dashboard hears them with the events.
  const writes = createEventWriteObserver();
  let outcome: Outcome;
  try {
    outcome = await runWithReadObserver(writes, () => applyPaymentEvent(db, env, ctx, send, claim.payload));
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    const status = await markPaymentEventAttemptFailed(db, claim.id, claim.attempts, message);
    console.warn(`[payments] Event ${claim.id} attempt ${claim.attempts} failed; ${status}`);
    return status;
  }
  const result = { attempts: claim.attempts, ...outcome.result };
  if (outcome.status === "manual_reconciliation") await markWebhookEventManualReconciliation(db, claim.id, result);
  else await markWebhookEventProcessed(db, claim.id, result);

  // The payment wrote orders, payments and stock: hand those events on now.
  const { flushEventsAfterWrite } = await import("../events/flush");
  await flushEventsAfterWrite(db, env, ctx, { tableTopics: [...writes.realtimeTopics] }).catch((error: unknown) => {
    console.warn("[payments] Event drain after a payment failed; the scheduled drain retries:", error instanceof Error ? error.name : "error");
  });
  return outcome.status;
}

/** The tick's drain: due retries and attempts whose invocation died, within the plan's limit. */
export async function drainPaymentEvents(db: Database, env: Env, ctx: ExecutionContext): Promise<{ scanned: number; processed: number }> {
  const due = await listDuePaymentEvents(db, planLimits().background.paymentEventsPerDrain);
  let processed = 0;
  for (const id of due) {
    const claim = await claimDuePaymentEvent(db, id);
    if (!claim) continue;
    let payload: PaymentEventPayload;
    try {
      payload = JSON.parse(claim.payload) as PaymentEventPayload;
    } catch {
      await markPaymentEventAttemptFailed(db, claim.id, Number.MAX_SAFE_INTEGER, "unreadable payment event payload");
      continue;
    }
    const status = await applyClaimedPaymentEvent(db, env, ctx, { id: claim.id, attempts: claim.attempts, payload });
    if (status === "processed" || status === "manual_reconciliation") processed += 1;
  }
  return { scanned: due.length, processed };
}

/** Apply one provider-authenticated payment event through the gateway-agnostic kernel. */
async function applyPaymentEvent(
  db: Database,
  env: Env,
  ctx: ExecutionContext,
  send: NotificationSender,
  { provider, event }: PaymentEventPayload,
): Promise<Outcome> {
  const refs = { gateway: provider, orderId: event.orderId, providerRef: event.providerRef, secondaryRef: event.secondaryRef ?? null };

  switch (event.kind) {
    case "confirmed": {
      const currency = event.currency ?? "";
      const result = await processPaymentConfirmed(db, {
        orderId: event.orderId,
        provider,
        amountMinor: event.amountMinor ?? 0,
        currency,
        paymentType: event.paymentType,
        providerRef: event.providerRef,
        secondaryRef: event.secondaryRef,
        metadata: { currency, ...event.details },
        // A provider that reports settlement (D2) has it recorded with the payment.
        settlement: event.settlement,
        // A kept method is saved for the order's account customer with the payment.
        savedPaymentMethod: event.savedPaymentMethod ?? null,
      });
      if (!result.success) {
        if (result.retryable === false) {
          console.warn(`[payments] ${provider} payment confirmation for order ${event.orderId} requires manual reconciliation: ${result.error ?? "unknown error"}`);
          return { status: "manual_reconciliation", result: { ...refs, outcome: "manual_reconciliation", error: result.error ?? null } };
        }
        throw new Error(`${provider} payment confirmation failed for order ${event.orderId}: ${result.error ?? "unknown error"}`);
      }
      if (!result.alreadyProcessed) {
        const paymentType = result.paymentType ?? event.paymentType ?? "full";
        if (paymentType === "balance") {
          await sendOrderBalancePaidNotification({
            db,
            send,
            orderId: event.orderId,
            source: `payment-${provider}-balance-paid`,
            amount: fromMinor(event.amountMinor ?? 0, getDecimalPlaces(currency)),
            gateway: provider,
          });
        } else {
          await sendOrderCreatedNotification({ db, send, orderId: event.orderId, source: `payment-${provider}-confirmed` });
        }
        ctx.waitUntil(processExistingMetaPurchaseOutboxForOrder({
          db,
          orderId: event.orderId,
          source: `payment-${provider}-confirmed`,
          storefrontUrl: env.STOREFRONT_URL,
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
        }).catch((error: unknown) => {
          console.error(`[payments] Meta Purchase CAPI side effect failed for confirmed ${provider} order ${event.orderId}:`, error instanceof Error ? error.name : "error");
        }));
        // GA4 and TikTok purchases waiting for this payment (audit spec S4).
        ctx.waitUntil(processTrackingDeliveriesForOrder(db, event.orderId, {
          storefrontUrl: env.STOREFRONT_URL,
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          paymentConfirmed: true,
        }).catch((error: unknown) => {
          console.error(`[payments] Server tracking side effect failed for confirmed ${provider} order ${event.orderId}:`, error instanceof Error ? error.name : "error");
        }));
        // Nothing ships for an order whose stock could not be reserved again.
        if (!result.inventoryShortfall) {
          ctx.waitUntil(runOrderAutoFulfil(db, env, ctx, event.orderId).catch((error: unknown) => {
            console.warn(`[payments] Automatic fulfilment of ${event.orderId} failed; the scheduled sweep retries:`, error instanceof Error ? error.name : "error");
          }));
        }
      }
      if (result.inventoryShortfall) {
        console.warn(`[payments] ${provider} payment confirmed for order ${event.orderId}, but its released stock could not be reserved again`);
        return { status: "manual_reconciliation", result: { ...refs, outcome: "confirmed_stock_unavailable" } };
      }
      console.log(`[payments] ${provider} payment confirmed for order ${event.orderId}`);
      return { status: "processed", result: { ...refs, outcome: "confirmed" } };
    }
    case "authorized": {
      // Money held, not captured: recorded as an authorization, counted as
      // nothing paid. An open checkout it holds is placed (its buyer hears of
      // the order); nothing is fulfilled until a capture confirms it.
      const currency = event.currency ?? "";
      const result = await processPaymentAuthorized(db, {
        orderId: event.orderId,
        provider,
        amountMinor: event.amountMinor ?? 0,
        currency,
        paymentType: event.paymentType,
        providerRef: event.providerRef,
        secondaryRef: event.secondaryRef,
        metadata: { ...event.details },
        savedPaymentMethod: event.savedPaymentMethod ?? null,
      });
      if (!result.success) {
        if (result.retryable === false) {
          console.warn(`[payments] ${provider} authorization for order ${event.orderId} requires manual reconciliation: ${result.error ?? "unknown error"}`);
          return { status: "manual_reconciliation", result: { ...refs, outcome: "manual_reconciliation", error: result.error ?? null } };
        }
        throw new Error(`${provider} authorization failed for order ${event.orderId}: ${result.error ?? "unknown error"}`);
      }
      if (result.placed) {
        await sendOrderCreatedNotification({ db, send, orderId: event.orderId, source: `payment-${provider}-authorized` });
      }
      if (result.inventoryShortfall) {
        return { status: "manual_reconciliation", result: { ...refs, outcome: "authorized_stock_unavailable" } };
      }
      return { status: "processed", result: { ...refs, outcome: result.alreadyProcessed ? "authorized_duplicate" : "authorized" } };
    }
    case "failed":
    case "cancelled": {
      // Either ends one attempt. It applies only to the order's current
      // attempt with this provider while the order is open and unpaid; the
      // order keeps its stock for the buyer's retry (released only when the
      // order is cancelled).
      const outcome = event.kind === "failed" ? "failed" : "canceled";
      const { applied } = await processPaymentFailed(db, {
        orderId: event.orderId,
        provider,
        providerRef: event.providerRef,
        correlationId: event.correlationId,
      });
      if (!applied) {
        console.log(`[payments] ${provider} ${outcome} event for order ${event.orderId} does not name its current payment attempt; ignored`);
        return { status: "processed", result: { ...refs, outcome: `${outcome}_ignored`, ...event.details } };
      }
      console.log(`[payments] ${provider} payment ${outcome} for order ${event.orderId}`);
      return { status: "processed", result: { ...refs, outcome, ...event.details } };
    }
    case "refund_observed":
      // Refunds made in the provider dashboard stay audit-only here; scheduled
      // reconciliation imports provider-confirmed refunds into the ledger.
      return { status: "manual_reconciliation", result: { ...refs, outcome: "external_refund_observed", ...event.details } };
  }
}
