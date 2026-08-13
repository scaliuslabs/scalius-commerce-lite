import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, PaymentStatus } from "@scalius/database/schema";
import { getStripeSettings } from "@scalius/core/modules/payments/gateway-settings";
import { retrieveStripePaymentIntent } from "@scalius/core/modules/payments/stripe";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../../utils/api-error";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";
import { withPaymentProviderDeadline } from "./payment-provider-deadline";

export type StripeReconciliationResult = {
  status: "pending" | "scheduled" | "settled";
  providerStatus: string | null;
};

export type StripeReconciliationOutcome = {
  data: StripeReconciliationResult;
  accepted: boolean;
};

export async function reconcileStripeOrderPayment(input: {
  db: Database;
  env: Env;
  orderId: string;
}): Promise<StripeReconciliationOutcome> {
  const order = await input.db.select({
    id: orders.id,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paymentIntentId: orders.paymentIntentId,
  }).from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  if (order.paymentMethod !== "stripe" || !order.paymentIntentId) {
    throw new ValidationError("This order does not have a Stripe payment to verify.");
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    return { data: { status: "settled", providerStatus: "succeeded" }, accepted: false };
  }

  const settings = await getStripeSettings(
    input.db,
    getCredentialEncryptionKey(input.env as Record<string, unknown>),
  );
  if (!settings?.enabled || !settings.secretKey || settings.credentialErrors?.length) {
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }
  const providerResult = await withPaymentProviderDeadline(
    "Stripe",
    (_signal, requestTimeoutMs) => retrieveStripePaymentIntent(
      settings.secretKey,
      order.paymentIntentId!,
      requestTimeoutMs,
    ),
  );
  const paymentIntent = providerResult.paymentIntent;
  if (!providerResult.success || !paymentIntent) {
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }
  if (paymentIntent.id !== order.paymentIntentId || paymentIntent.metadata.orderId !== order.id) {
    throw new ValidationError("Stripe payment verification did not match this order.");
  }
  if (paymentIntent.status !== "succeeded") {
    return { data: { status: "pending", providerStatus: paymentIntent.status }, accepted: false };
  }

  const eventId = buildWebhookEventId(
    "stripe",
    "payment_intent.succeeded",
    `buyer-reconcile:${paymentIntent.id}`,
  );
  const claim = await claimWebhookEvent(input.db, {
    id: eventId,
    provider: "stripe",
    eventType: "payment_intent.succeeded",
    orderId: order.id,
    status: "processing",
    result: { source: "buyer_receipt_reconciliation" },
  });
  if (!claim.claimed) {
    return { data: {
      status: claim.existing?.status === "processed" ? "settled" : "scheduled",
      providerStatus: paymentIntent.status,
    }, accepted: false };
  }

  const queue = input.env.PAYMENT_EVENTS_QUEUE;
  if (!queue) {
    await markWebhookEventFailed(input.db, eventId, { error: "Queue not available" });
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }
  const message: PaymentQueueMessage = {
    type: "payment.stripe.confirmed",
    orderId: order.id,
    paymentIntentId: paymentIntent.id,
    amount: paymentIntent.amountReceived,
    currency: paymentIntent.currency,
    ...(paymentIntent.chargeId ? { chargeId: paymentIntent.chargeId } : {}),
    metadata: paymentIntent.metadata,
    webhookEventId: eventId,
  };
  try {
    await queue.send(message);
    await markWebhookEventQueued(input.db, eventId, {
      source: "buyer_receipt_reconciliation",
      providerStatus: paymentIntent.status,
    });
  } catch (error) {
    await markWebhookEventFailed(input.db, eventId, {
      source: "buyer_receipt_reconciliation",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceUnavailableError("Stripe payment verification is temporarily unavailable.");
  }
  return {
    data: { status: "scheduled", providerStatus: paymentIntent.status },
    accepted: true,
  };
}
