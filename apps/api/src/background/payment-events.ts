// Applying provider-authenticated payment events. A webhook, a hosted buyer
// return or a buyer reconciliation claims the event once in `webhook_events`
// (routes/payment/payment-events.ts), with the normalized event as the row's
// payload; the event is applied right after the response, and a failed
// attempt is retried from that row by the scheduled drain with backoff
// (`retrying`, 1 to 16 minutes) until it is `failed` after six attempts, the
// state the order page shows. An attempt refused only because a shipment
// claim locks the order is not counted: the event waits for the claim's end.
// Applying is idempotent (the payment kernel dedupes on the provider
// reference), so a redelivery is harmless.
import type { Database } from "@scalius/database/client";
import { runWithReadObserver } from "@scalius/database/read-observer";
import {
  LOCAL_REFUND_IN_PROGRESS_REASON,
  cancelDueSessions,
  listDuePaymentCommands,
  markSessionProcessing,
  processPaymentAuthorized,
  processPaymentConfirmed,
  processPaymentFailed,
  reconcilePaymentCommand,
  refundLatePayment,
  verifyObservedRefund,
  type PaymentCommandDeps,
  type PaymentEvent,
} from "@scalius/core/modules/payments";
import { processExistingMetaPurchaseOutboxForOrder } from "@scalius/core/integrations/meta/purchase-outbox";
import { processTrackingDeliveriesForOrder } from "@scalius/core/integrations/tracking/deliveries";
import type { NotificationSender } from "@scalius/core/modules/notifications";
import { planLimits } from "@scalius/shared/plan-limits";
import { getCredentialEncryptionKey } from "../utils/encryption-key";
import {
  claimDuePaymentEvent,
  listDuePaymentEvents,
  markPaymentEventAttemptFailed,
  markWebhookEventManualReconciliation,
  markWebhookEventProcessed,
  parkPaymentEventForShipmentClaim,
} from "../utils/webhook-idempotency";
import { isShipmentClaimConflictError } from "@scalius/core/modules/order-kernel";
import { createEventWriteObserver } from "../middleware/event-dispatch";
import { notificationSender } from "./notification-sender";
import { runOrderAutoFulfil } from "./auto-fulfil";
import { appPaymentProvidersLoader } from "../plugins/providers/payment";

/** What a claimed payment event's row stores as its payload. */
export interface PaymentEventPayload {
  provider: string;
  event: PaymentEvent;
}

type Outcome = { status: "processed" | "manual_reconciliation"; result: Record<string, unknown> };

/** The event was refused only because a shipment claim locks its order: it waits, uncounted. */
class ParkedForShipmentClaim extends Error {}

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
    if (error instanceof ParkedForShipmentClaim || isShipmentClaimConflictError(error)) {
      // A courier booking holds the order: nothing is wrong with the payment,
      // so the attempt is not spent. The claim's end makes the event due again.
      await parkPaymentEventForShipmentClaim(db, claim.id, claim.attempts, message);
      console.warn(`[payments] Event ${claim.id} waits for its order's shipment claim; retrying`);
      return "retrying";
    }
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

/**
 * The tick's drain: due retries and attempts whose invocation died, then
 * the off-session commands (charge, capture, void) still open past their
 * next look, then the payment sessions to close at their provider (an
 * unpaid checkout's hold ended, or a newer session replaced them), each
 * within the plan's limit. A command is settled from the ledger, looked up
 * at its gateway, or expired (core saved-method-charges.ts); a session is
 * closed through the port, or locally when its provider cannot
 * (core session-lifecycle.ts). The counts cover all three.
 */
export async function drainPaymentEvents(db: Database, env: Env, ctx: ExecutionContext): Promise<{ scanned: number; processed: number }> {
  const events = await drainDuePaymentEvents(db, env, ctx);
  const commands = await reconcileDuePaymentCommands(db, env, ctx);
  const sessions = await cancelDueSessions(db, paymentCommandDeps(db, env, ctx), planLimits().background.paymentEventsPerDrain);
  return {
    scanned: events.scanned + commands.scanned + sessions.scanned,
    processed: events.processed + commands.processed + sessions.closed,
  };
}

/** What a command or a session close needs: the gateways, the key, and the kernel's event intake. */
function paymentCommandDeps(db: Database, env: Env, ctx: ExecutionContext): PaymentCommandDeps {
  return {
    providers: appPaymentProvidersLoader(env, db, ctx),
    encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
    applyEvent: async ({ provider, event, source }) => {
      const { claimAndApplyPaymentEventNow } = await import("../routes/payment/payment-events");
      return claimAndApplyPaymentEventNow({ db, env, ctx, provider, event, source });
    },
  };
}

async function reconcileDuePaymentCommands(db: Database, env: Env, ctx: ExecutionContext): Promise<{ scanned: number; processed: number }> {
  const due = await listDuePaymentCommands(db, planLimits().background.paymentEventsPerDrain);
  if (due.length === 0) return { scanned: 0, processed: 0 };
  const deps = paymentCommandDeps(db, env, ctx);
  let processed = 0;
  for (const id of due) {
    try {
      const outcome = await reconcilePaymentCommand(db, deps, id);
      if (outcome === "settled" || outcome === "expired") processed += 1;
    } catch (error) {
      console.warn("[payments] An open payment command could not be reconciled; the next tick retries:", error instanceof Error ? error.name : "error");
    }
  }
  return { scanned: due.length, processed };
}

async function drainDuePaymentEvents(db: Database, env: Env, ctx: ExecutionContext): Promise<{ scanned: number; processed: number }> {
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
        correlationId: event.correlationId,
        metadata: { currency, ...event.details },
        // A provider that reports settlement (D2) has it recorded with the payment.
        settlement: event.settlement,
        // A kept method is saved for the order's account customer with the payment.
        savedPaymentMethod: event.savedPaymentMethod ?? null,
        // A payment the provider flagged is held for staff review with it.
        review: event.review ?? null,
      });
      if (!result.success) {
        if (result.shipmentClaim) throw new ParkedForShipmentClaim(result.error ?? "shipment claim");
        if (result.retryable === false) {
          console.warn(`[payments] ${provider} payment confirmation for order ${event.orderId} requires manual reconciliation; the reason is on its event row`);
          return { status: "manual_reconciliation", result: { ...refs, outcome: "manual_reconciliation", error: result.error ?? null } };
        }
        throw new Error(`${provider} payment confirmation failed for order ${event.orderId}: ${result.error ?? "unknown error"}`);
      }
      if (result.latePayment) {
        // The order could no longer take it: recorded as received, refunded
        // now, exactly once (a failed refund fails this attempt, and the
        // event's retry replays the same refund).
        const refund = await refundLatePayment(db, { orderId: event.orderId, paymentId: result.latePayment.paymentId }, {
          encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
          providers: appPaymentProvidersLoader(env, db, ctx),
        });
        if (refund.status === "manual") {
          // It cannot go back automatically: staff return it (this event's
          // manual-reconciliation state, the order's timeline line), and the
          // buyer's refund_failed notice, which reaches staff too, goes now.
          await send([refund.notificationOutboxId]);
          console.warn(`[payments] ${provider} payment for closed order ${event.orderId} was recorded but could not be refunded automatically`);
          return {
            status: "manual_reconciliation",
            result: { ...refs, outcome: "late_payment_refund_failed", reason: result.latePayment.reason, error: refund.reason },
          };
        }
        if (refund.status === "refunded" && refund.result.notificationOutboxIds?.length) await send(refund.result.notificationOutboxIds);
        console.warn(`[payments] ${provider} payment for closed order ${event.orderId} was recorded and refunded (${refund.status})`);
        return {
          status: "processed",
          result: { ...refs, outcome: refund.status === "refunded" ? "late_payment_refunded" : "late_payment_refund_pending", reason: result.latePayment.reason },
        };
      }
      // Every attempt sends what the payment's batch committed, a retry after
      // that batch (alreadyProcessed) included: the buyer's message, the Meta
      // purchase claim and the tracking rows waiting for the payment. Each is
      // deduped by its own row, so a repeat sends nothing twice.
      if (result.notificationOutboxId) await send([result.notificationOutboxId]);
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
      // The fast path of automatic fulfilment, for the attempt that landed the
      // money; the scheduled sweep hands over any settled order this misses.
      // Nothing ships for an order whose stock could not be reserved again.
      if (!result.alreadyProcessed && !result.inventoryShortfall) {
        ctx.waitUntil(runOrderAutoFulfil(db, env, ctx, event.orderId).catch((error: unknown) => {
          console.warn(`[payments] Automatic fulfilment of ${event.orderId} failed; the scheduled sweep retries:`, error instanceof Error ? error.name : "error");
        }));
      }
      if (result.inventoryShortfall) {
        console.warn(`[payments] ${provider} payment confirmed for order ${event.orderId}, but its released stock could not be reserved again`);
        return { status: "manual_reconciliation", result: { ...refs, outcome: "confirmed_stock_unavailable" } };
      }
      console.log(`[payments] ${provider} payment confirmed for order ${event.orderId}${event.review ? " (held for review)" : ""}`);
      return { status: "processed", result: { ...refs, outcome: "confirmed", ...(event.review ? { heldForReview: true } : {}) } };
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
        correlationId: event.correlationId,
        metadata: { ...event.details },
        savedPaymentMethod: event.savedPaymentMethod ?? null,
        review: event.review ?? null,
      });
      if (!result.success) {
        if (result.shipmentClaim) throw new ParkedForShipmentClaim(result.error ?? "shipment claim");
        if (result.retryable === false) {
          console.warn(`[payments] ${provider} authorization for order ${event.orderId} requires manual reconciliation; the reason is on its event row`);
          return { status: "manual_reconciliation", result: { ...refs, outcome: "manual_reconciliation", error: result.error ?? null } };
        }
        throw new Error(`${provider} authorization failed for order ${event.orderId}: ${result.error ?? "unknown error"}`);
      }
      // The placement message the batch committed, on a retry too.
      if (result.notificationOutboxId) await send([result.notificationOutboxId]);
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
    case "processing": {
      // The buyer paid and the provider is completing it (a bank debit): the
      // session holds its order until confirmed or failed, for a bounded time.
      const held = await markSessionProcessing(db, {
        orderId: event.orderId,
        provider,
        providerRef: event.providerRef,
        correlationId: event.correlationId ?? null,
      });
      return { status: "processed", result: { ...refs, outcome: held ? "processing" : "processing_ignored" } };
    }
    case "refund_observed": {
      // The provider reports the transaction's refunds. The order's own
      // refund (sent from the dashboard) is already recorded: checked now, it
      // is done. Anything else waits for the scheduled reconciliation, which
      // imports refunds made in the provider dashboard; nothing is imported here.
      const verdict = await verifyObservedRefund(db, {
        provider,
        orderId: event.orderId,
        providerRef: event.providerRef,
        secondaryRef: event.secondaryRef,
      }, {
        encryptionKey: getCredentialEncryptionKey(env as unknown as Record<string, unknown>),
        providers: appPaymentProvidersLoader(env, db, ctx),
      });
      if (verdict === "represented") {
        return { status: "processed", result: { ...refs, outcome: "refund_represented", ...event.details } };
      }
      return {
        status: "manual_reconciliation",
        result: {
          ...refs,
          outcome: "external_refund_observed",
          ...(verdict === "own_refund_in_progress" ? { reason: LOCAL_REFUND_IN_PROGRESS_REASON } : {}),
          ...event.details,
        },
      };
    }
  }
}
