// src/server/routes/webhooks/stripe.ts
// Webhook handler for Stripe events. Signature verification IS the auth.

import { OpenAPIHono } from "@hono/zod-openapi";
import type Stripe from "stripe";
import { verifyStripeWebhook } from "@scalius/core/modules/payments/stripe";
import {
  FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
  getStripeSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import type { PaymentQueueMessage } from "../../queue-consumer";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
  buildWebhookEventId,
  claimWebhookEvent,
  markWebhookEventFailed,
  markWebhookEventProcessed,
  markWebhookEventQueued,
} from "../../utils/webhook-idempotency";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
  const db = c.get("db");
  const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
  let stripeSettings: Awaited<ReturnType<typeof getStripeSettings>>;
  try {
    stripeSettings = await getStripeSettings(
      db,
      c.env.CACHE,
      encryptionKey,
      FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    );
  } catch (error) {
    console.error(
      "[stripe-webhook] Stripe settings read failed:",
      error instanceof Error ? error.message : error,
    );
    return c.json({ error: "Webhook settings unavailable" }, 503);
  }

  if (!stripeSettings) {
    console.warn("[stripe-webhook] Stripe not configured — ignoring event");
    return c.json({ received: true, skipped: true });
  }
  if (stripeSettings.credentialErrors?.length) {
    console.error("[stripe-webhook] Stripe credentials are not readable:", stripeSettings.credentialErrors[0]);
    return c.json({ error: "Webhook settings unavailable" }, 503);
  }
  if (!stripeSettings.secretKey || !stripeSettings.webhookSecret) {
    console.warn("[stripe-webhook] Stripe webhook credentials are incomplete — ignoring event");
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

  const message = buildQueueMessage(event);
  const eventId = buildWebhookEventId("stripe", event.type, event.id);
  const claim = await claimWebhookEvent(db, {
    id: eventId,
    provider: "stripe",
    eventType: event.type,
    orderId: message?.orderId ?? null,
    status: "processing",
    result: { sourceEventId: event.id },
  });

  if (!claim.claimed) {
    return c.json({
      received: true,
      skipped: true,
      duplicate: true,
      status: claim.existing?.status ?? "unknown",
    });
  }

  const queue = c.env.PAYMENT_EVENTS_QUEUE;
  if (!queue && message) {
    await markWebhookEventFailed(db, eventId, { error: "Queue not available" });
    return c.json({ error: "Queue not available" }, 503);
  }

  if (message) {
    try {
      await queue.send(message);
      await markWebhookEventQueued(db, eventId, {
        sourceEventId: event.id,
        eventType: event.type,
      });
    } catch (error) {
      await markWebhookEventFailed(db, eventId, {
        sourceEventId: event.id,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ error: "Failed to enqueue payment event" }, 503);
    }
  } else {
    console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
    await markWebhookEventProcessed(db, eventId, {
      sourceEventId: event.id,
      eventType: event.type,
      enqueued: false,
    });
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
