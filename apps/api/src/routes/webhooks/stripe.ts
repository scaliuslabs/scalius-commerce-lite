// src/server/routes/webhooks/stripe.ts
// Webhook handler for Stripe events. Signature verification IS the auth.

import { OpenAPIHono } from "@hono/zod-openapi";
import type Stripe from "stripe";
import { verifyStripeWebhook } from "@scalius/core/modules/payments/stripe";
import { getStripeSettings } from "@scalius/core/modules/payments/gateway-settings";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { getEncryptionKey } from "../../utils/encryption-key";

const app = new OpenAPIHono<{ Bindings: Env }>();

const KV_WEBHOOK_PREFIX = "stripe_wh:";
const KV_WEBHOOK_TTL = 86400; // 24 hours

app.post("/", async (c) => {
  const db = c.get("db");
  const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
  const stripeSettings = await getStripeSettings(db, c.env.CACHE, encryptionKey);

  if (!stripeSettings) {
    console.warn("[stripe-webhook] Stripe not configured — ignoring event");
    return c.json({ received: true, skipped: true });
  }

  const rawBody = await c.req.text();
  const signature = c.req.header("Stripe-Signature") ?? "";

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

  const kvKey = `${KV_WEBHOOK_PREFIX}${event.id}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.json({ received: true, skipped: true });
  }

  const message = buildQueueMessage(event);

  if (message) {
    await c.env.PAYMENT_EVENTS_QUEUE.send(message);
    await c.env.CACHE?.put(kvKey, "queued", { expirationTtl: KV_WEBHOOK_TTL });
  } else {
    console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
  }

  return c.json({ received: true });
});

function buildQueueMessage(event: Stripe.Event): PaymentQueueMessage | null {
  switch (event.type) {
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return null;

      const chargeId = typeof pi.latest_charge === "string"
        ? pi.latest_charge
        : (pi.latest_charge as { id?: string })?.id ?? undefined;

      return {
        type: "payment.stripe.confirmed",
        orderId,
        paymentIntentId: pi.id,
        amount: pi.amount_received,
        currency: pi.currency,
        chargeId,
        metadata: pi.metadata as Record<string, string>
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
        failureMessage: pi.last_payment_error?.message ?? undefined
      };
    }

    case "payment_intent.canceled": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const orderId = pi.metadata?.orderId;
      if (!orderId) return null;

      return {
        type: "payment.stripe.canceled",
        orderId,
        paymentIntentId: pi.id
      };
    }

    case "charge.refunded": {
      const charge = event.data.object as Stripe.Charge;
      const orderId = charge.metadata?.orderId;
      if (!orderId) return null;

      return {
        type: "payment.stripe.refunded",
        orderId,
        paymentIntentId: typeof charge.payment_intent === "string"
          ? charge.payment_intent
          : (charge.payment_intent as { id?: string })?.id ?? "",
        amountRefunded: charge.amount_refunded,
        chargeId: charge.id
      };
    }

    default:
      return null;
  }
}

export const stripeWebhookRoutes = app;
