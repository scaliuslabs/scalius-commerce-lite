import { eq } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { orders, PaymentStatus } from "@scalius/database/schema";
import { getPolarSettings, isPolarCheckoutUsable } from "@scalius/core/modules/payments/gateway-settings";
import { retrievePolarCheckout } from "@scalius/core/modules/payments/polar";
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

export type PolarReconciliationResult = {
  status: "pending" | "scheduled" | "settled";
  providerStatus: string | null;
};

export async function reconcilePolarOrderPayment(input: {
  db: Database;
  env: Env;
  orderId: string;
}): Promise<{ data: PolarReconciliationResult; accepted: boolean }> {
  const order = await input.db.select({
    id: orders.id,
    paymentMethod: orders.paymentMethod,
    paymentStatus: orders.paymentStatus,
    paymentIntentId: orders.paymentIntentId,
  }).from(orders).where(eq(orders.id, input.orderId)).get();
  if (!order) throw new NotFoundError("Order not found");
  if (order.paymentMethod !== "polar" || !order.paymentIntentId) {
    throw new ValidationError("This order does not have a Polar payment to verify.");
  }
  if (order.paymentStatus === PaymentStatus.PAID) {
    return { data: { status: "settled", providerStatus: "succeeded" }, accepted: false };
  }

  const settings = await getPolarSettings(
    input.db,
    getCredentialEncryptionKey(input.env as Record<string, unknown>),
  );
  if (!isPolarCheckoutUsable(settings)) {
    throw new ServiceUnavailableError("Polar payment verification is temporarily unavailable.");
  }
  const providerResult = await withPaymentProviderDeadline(
    "Polar",
    (_signal, requestTimeoutMs) => retrievePolarCheckout(
      settings,
      order.paymentIntentId!,
      requestTimeoutMs,
    ),
  );
  if (!providerResult.success) {
    throw new ServiceUnavailableError("Polar payment verification is temporarily unavailable.");
  }
  const checkout = providerResult.checkout;
  if (checkout.id !== order.paymentIntentId || checkout.metadata.orderId !== order.id) {
    throw new ValidationError("Polar payment verification did not match this order.");
  }
  if (checkout.status !== "succeeded") {
    return { data: { status: "pending", providerStatus: checkout.status }, accepted: false };
  }

  const eventId = buildWebhookEventId(
    "polar",
    "order.paid",
    `buyer-reconcile:${checkout.id}`,
  );
  const claim = await claimWebhookEvent(input.db, {
    id: eventId,
    provider: "polar",
    eventType: "order.paid",
    orderId: order.id,
    status: "processing",
    result: { source: "buyer_return_reconciliation" },
  });
  if (!claim.claimed) {
    return {
      data: {
        status: claim.existing?.status === "processed" ? "settled" : "scheduled",
        providerStatus: checkout.status,
      },
      accepted: false,
    };
  }

  const queue = input.env.PAYMENT_EVENTS_QUEUE;
  if (!queue) {
    await markWebhookEventFailed(input.db, eventId, { error: "Queue not available" });
    throw new ServiceUnavailableError("Polar payment verification is temporarily unavailable.");
  }
  const message: PaymentQueueMessage = {
    type: "payment.polar.confirmed",
    orderId: order.id,
    checkoutId: checkout.id,
    amount: checkout.totalAmount,
    currency: checkout.currency,
    paymentType: checkout.metadata.paymentType ?? "full",
    metadata: checkout.metadata,
    webhookEventId: eventId,
  };
  try {
    await queue.send(message);
    await markWebhookEventQueued(input.db, eventId, {
      source: "buyer_return_reconciliation",
      providerStatus: checkout.status,
    });
  } catch (error) {
    await markWebhookEventFailed(input.db, eventId, {
      source: "buyer_return_reconciliation",
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ServiceUnavailableError("Polar payment verification is temporarily unavailable.");
  }
  return {
    data: { status: "scheduled", providerStatus: checkout.status },
    accepted: true,
  };
}
