// src/queue-consumer.ts
// Cloudflare Queue consumer for async payment processing and order notifications.
// This handler is invoked by Cloudflare when messages are dequeued from
// the payment-events and order-notifications queues.
//
// Architecture:
//   Webhook handler  →  enqueue message  →  return 200 immediately
//   Queue consumer   →  process message  →  update DB, send notifications
//
// This makes webhooks resilient: Cloudflare retries failed queue messages
// automatically (up to max_retries = 3).

import { getDb } from "@/db";
import { processPaymentConfirmed, processPaymentFailed, releaseOrderInventory } from "@/lib/payment/process-payment";
import { sendEmail } from "@/lib/email";

// ── Message types ──────────────────────────────────────────────────────────

export type PaymentQueueMessage =
  | {
      type: "payment.stripe.confirmed";
      orderId: string;
      paymentIntentId: string;
      amount: number; // in cents
      currency: string;
      metadata?: Record<string, string>;
    }
  | {
      type: "payment.stripe.failed";
      orderId: string;
      paymentIntentId: string;
      failureCode?: string;
      failureMessage?: string;
    }
  | {
      type: "payment.stripe.canceled";
      orderId: string;
      paymentIntentId: string;
    }
  | {
      type: "payment.stripe.refunded";
      orderId: string;
      paymentIntentId: string;
      amountRefunded: number; // in cents
      chargeId: string;
    }
  | {
      type: "payment.sslcommerz.confirmed";
      orderId: string;
      tranId: string;
      valId: string;
      bankTranId: string;
      amount: number;
      currency: string;
      cardType?: string;
      cardBrand?: string;
    }
  | {
      type: "payment.sslcommerz.failed";
      orderId: string;
      tranId: string;
      status: string;
    }
  | {
      type: "order.notification";
      orderId: string;
      customerEmail?: string;
      customerName: string;
      notificationType: "order_created" | "order_confirmed" | "order_shipped" | "order_delivered";
      data?: Record<string, unknown>;
    };

// ── Queue batch handler ────────────────────────────────────────────────────

/**
 * Handle a batch of queue messages.
 * Each message is processed independently; failures are retried by Cloudflare.
 */
export async function handleQueueBatch(
  batch: MessageBatch<PaymentQueueMessage>,
  env: Env,
): Promise<void> {
  const db = getDb(env);

  // Process each message independently
  const results = await Promise.allSettled(
    batch.messages.map((msg) => processQueueMessage(msg, db, env)),
  );

  // Ack successful messages, retry failed ones
  for (let i = 0; i < batch.messages.length; i++) {
    const result = results[i];
    const msg = batch.messages[i];
    if (result.status === "fulfilled") {
      msg.ack();
    } else {
      console.error(`[Queue] Failed to process message ${msg.id}:`, result.reason);
      msg.retry({ delaySeconds: 30 }); // Retry after 30s
    }
  }
}

/**
 * Process a single queue message.
 */
async function processQueueMessage(
  msg: Message<PaymentQueueMessage>,
  db: ReturnType<typeof getDb>,
  env: Env,
): Promise<void> {
  const payload = msg.body;
  console.log(`[Queue] Processing message type=${payload.type} id=${msg.id}`);

  switch (payload.type) {
    case "payment.stripe.confirmed": {
      const amountInMajor = payload.amount / 100; // Convert cents to major currency unit
      await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "stripe",
        paymentType: "full",
        stripePaymentIntentId: payload.paymentIntentId,
        amount: amountInMajor,
        metadata: { currency: payload.currency },
      });
      console.log(`[Queue] Stripe payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.failed": {
      await processPaymentFailed(db, payload.orderId, "stripe");
      console.log(`[Queue] Stripe payment failed for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.canceled": {
      await releaseOrderInventory(db, payload.orderId);
      console.log(`[Queue] Stripe payment cancelled, inventory released for order ${payload.orderId}`);
      break;
    }

    case "payment.stripe.refunded": {
      // Refunds handled synchronously via the refund endpoint
      // Queue message is for audit/notification purposes
      console.log(`[Queue] Stripe refund recorded for order ${payload.orderId}`);
      break;
    }

    case "payment.sslcommerz.confirmed": {
      await processPaymentConfirmed(db, {
        orderId: payload.orderId,
        paymentGateway: "sslcommerz",
        paymentType: "full",
        sslcommerzTranId: payload.tranId,
        sslcommerzValId: payload.valId,
        sslcommerzBankTranId: payload.bankTranId,
        amount: payload.amount,
        metadata: { currency: payload.currency, cardType: payload.cardType, cardBrand: payload.cardBrand },
      });
      console.log(`[Queue] SSLCommerz payment confirmed for order ${payload.orderId}`);
      break;
    }

    case "payment.sslcommerz.failed": {
      await processPaymentFailed(db, payload.orderId, "sslcommerz");
      console.log(`[Queue] SSLCommerz payment failed for order ${payload.orderId}`);
      break;
    }

    case "order.notification": {
      if (payload.customerEmail) {
        await sendOrderNotificationEmail(
          payload.customerEmail,
          payload.customerName,
          payload.orderId,
          payload.notificationType,
          payload.data,
        );
      }
      break;
    }

    default: {
      console.warn(`[Queue] Unknown message type:`, (payload as any).type);
    }
  }
}

// ── Email notification helper ──────────────────────────────────────────────

async function sendOrderNotificationEmail(
  email: string,
  name: string,
  orderId: string,
  type: "order_created" | "order_confirmed" | "order_shipped" | "order_delivered",
  data?: Record<string, unknown>,
): Promise<void> {
  const subjects: Record<string, string> = {
    order_created: `Order #${orderId} Received`,
    order_confirmed: `Order #${orderId} Confirmed`,
    order_shipped: `Order #${orderId} Shipped`,
    order_delivered: `Order #${orderId} Delivered`,
  };

  const messages: Record<string, string> = {
    order_created: `Thank you for your order, ${name}! We've received your order <strong>#${orderId}</strong> and will process it shortly.`,
    order_confirmed: `Great news, ${name}! Your order <strong>#${orderId}</strong> has been confirmed and is being prepared.`,
    order_shipped: `Your order <strong>#${orderId}</strong> is on its way, ${name}! ${data?.trackingId ? `Tracking ID: <strong>${data.trackingId}</strong>` : ""}`,
    order_delivered: `Your order <strong>#${orderId}</strong> has been delivered, ${name}! We hope you love your purchase.`,
  };

  await sendEmail({
    to: email,
    subject: subjects[type] || `Order #${orderId} Update`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2>${subjects[type] || "Order Update"}</h2>
        <p>${messages[type] || `Your order #${orderId} has been updated.`}</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
        <p style="color: #999; font-size: 12px;">
          This is an automated email regarding your order from our store.
        </p>
      </div>
    `,
    text: `${name}, ${messages[type]?.replace(/<[^>]+>/g, "") || `Order #${orderId} updated.`}`,
  });
}
