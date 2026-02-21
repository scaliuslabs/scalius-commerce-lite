// src/server/routes/webhooks/stripe.ts
// Hono route handler for Stripe webhook events.
//
// Key design decisions:
// - Verifies Stripe signature synchronously (security critical — never skip).
// - Two-layer idempotency: KV fast check → set AFTER enqueuing succeeds.
// - Enqueues to PAYMENT_EVENTS_QUEUE instead of processing inline.
//   Cloudflare Queue consumer handles all DB writes and retries automatically.
// - Returns 200 immediately after enqueuing; Stripe never sees processing latency.
// - charge.refunded: enqueues a refund event for audit; actual DB update is
//   handled synchronously by the admin refund endpoint (not the webhook).
// - No auth middleware — Stripe signature IS the auth.
// - Gateway credentials loaded from DB settings (not env vars).

import { Hono } from "hono";
import type Stripe from "stripe";
import { verifyStripeWebhook } from "@/lib/payment/stripe";
import { getStripeSettings } from "@/lib/payment/gateway-settings";
import { getDb } from "@/db";
import type { PaymentQueueMessage } from "@/queue-consumer";

const app = new Hono<{ Bindings: Env }>();

const KV_WEBHOOK_PREFIX = "stripe_wh:";
const KV_WEBHOOK_TTL = 86400; // 24 hours

app.post("/", async (c) => {
  const db = getDb(c.env);
  const stripeSettings = await getStripeSettings(db, c.env.CACHE);

  if (!stripeSettings) {
    // Return 200 so Stripe doesn't retry endlessly for an unconfigured gateway
    console.warn("[stripe-webhook] Stripe not configured — ignoring event");
    return c.json({ received: true, skipped: true });
  }

  // Read raw body as text — MUST happen before any c.req.json() call
  const rawBody = await c.req.text();
  const signature = c.req.header("Stripe-Signature") ?? "";

  // Verify webhook signature (security critical — never skip)
  const event = await verifyStripeWebhook(
    stripeSettings.secretKey,
    stripeSettings.webhookSecret,
    rawBody,
    signature
  );

  if (!event) {
    console.warn("[stripe-webhook] Invalid signature");
    return c.json({ error: "Invalid signature" }, 400);
  }

  // Fast idempotency check via KV — prevents duplicate queue messages
  const kvKey = `${KV_WEBHOOK_PREFIX}${event.id}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.json({ received: true, skipped: true });
  }

  // Build the queue message for known event types
  const message = buildQueueMessage(event);

  if (message) {
    await c.env.PAYMENT_EVENTS_QUEUE.send(message);
    // Set KV idempotency key AFTER enqueuing succeeds — prevents double-enqueue on retries
    await c.env.CACHE?.put(kvKey, "queued", { expirationTtl: KV_WEBHOOK_TTL });
  } else {
    // Unknown / unhandled event type — acknowledge without enqueuing
    console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
  }

  return c.json({ received: true });
});

/**
 * Map a Stripe event to a PaymentQueueMessage.
 * Returns null for event types we don't need to process.
 */
function buildQueueMessage(event: Stripe.Event): PaymentQueueMessage | null {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return null;

      return {
        type: "payment.stripe.confirmed",
        orderId,
        paymentIntentId: pi.id,
        amount: pi.amount_received, // in cents — queue consumer converts to major unit
        currency: pi.currency,
        metadata: pi.metadata as Record<string, string>,
      };
    }

    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return null;

      return {
        type: "payment.stripe.failed",
        orderId,
        paymentIntentId: pi.id,
        failureCode: pi.last_payment_error?.code ?? undefined,
        failureMessage: pi.last_payment_error?.message ?? undefined,
      };
    }

    case "payment_intent.canceled": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return null;

      return {
        type: "payment.stripe.canceled",
        orderId,
        paymentIntentId: pi.id,
      };
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const orderId = charge.metadata?.orderId;
      if (!orderId) return null;

      const chargeId = charge.id;
      const amountRefunded = charge.amount_refunded; // in cents

      return {
        type: "payment.stripe.refunded",
        orderId,
        paymentIntentId: typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent as any)?.id ?? "",
        amountRefunded,
        chargeId,
      };
    }

    default:
      return null;
  }
}

export const stripeWebhookRoutes = app;
