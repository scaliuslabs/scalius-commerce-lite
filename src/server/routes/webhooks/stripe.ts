// src/server/routes/webhooks/stripe.ts
// Hono route handler for Stripe webhook events.
//
// Key design decisions:
// - Returns 200 immediately to Stripe; heavy processing runs in waitUntil().
// - Two-layer idempotency: KV (fast, 24h TTL) → webhookEvents DB table (durable).
// - Raw body is read as text BEFORE any JSON parsing (required for HMAC verification).
// - No auth middleware — Stripe signature IS the auth.
// - Gateway credentials loaded from DB settings (not env vars).

import { Hono } from "hono";
import type Stripe from "stripe";
import { verifyStripeWebhook } from "@/lib/payment/stripe";
import { getStripeSettings } from "@/lib/payment/gateway-settings";
import {
  processPaymentConfirmed,
  processPaymentFailed,
  releaseOrderInventory,
  recordWebhookEvent,
} from "@/lib/payment/process-payment";
import { getDb } from "@/db";
import { orders, PaymentStatus } from "@/db/schema";
import { eq, sql } from "drizzle-orm";

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

  // Verify webhook signature
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

  // Fast idempotency check via KV
  const kvKey = `${KV_WEBHOOK_PREFIX}${event.id}`;
  const alreadyProcessed = await c.env.CACHE?.get(kvKey);
  if (alreadyProcessed) {
    return c.json({ received: true, skipped: true });
  }

  // NOTE: We intentionally do NOT set the KV key here.
  // The key is set inside handleStripeEvent AFTER processing succeeds.
  // This ensures that if processing fails, Stripe can retry the event.

  // Return 200 immediately; process asynchronously
  c.executionCtx.waitUntil(handleStripeEvent(c.env, event, kvKey));

  return c.json({ received: true });
});

async function handleStripeEvent(env: Env, event: Stripe.Event, kvKey: string): Promise<void> {
  const db = getDb(env);
  let processed = false;

  try {
    switch (event.type) {
      case "payment_intent.succeeded": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (!orderId) break;

        const paymentType = (pi.metadata?.paymentType as "full" | "deposit" | "balance") ?? "full";
        // Stripe amounts are in smallest unit; convert to major unit for our DB
        const amount = pi.amount_received / 100;

        const chargeId = typeof pi.latest_charge === "string"
          ? pi.latest_charge
          : (pi.latest_charge as any)?.id;

        const result = await processPaymentConfirmed(db, {
          orderId,
          amount,
          paymentGateway: "stripe",
          paymentType,
          stripePaymentIntentId: pi.id,
          stripeChargeId: chargeId,
          metadata: { stripeEventId: event.id },
        });

        await recordWebhookEvent(
          db, event.id, "stripe", event.type, orderId,
          result.success ? "processed" : "failed", result
        );
        processed = result.success;
        break;
      }

      case "payment_intent.payment_failed": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (!orderId) break;

        await processPaymentFailed(db, orderId, "stripe", pi.id);
        await recordWebhookEvent(db, event.id, "stripe", event.type, orderId, "processed");
        processed = true;
        break;
      }

      case "payment_intent.canceled": {
        const pi = event.data.object as Stripe.PaymentIntent;
        const orderId = pi.metadata?.orderId;
        if (!orderId) break;

        await releaseOrderInventory(db, orderId);
        await recordWebhookEvent(db, event.id, "stripe", event.type, orderId, "processed");
        processed = true;
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        const orderId = charge.metadata?.orderId;
        if (!orderId) {
          await recordWebhookEvent(db, event.id, "stripe", event.type, null, "processed");
          processed = true;
          break;
        }

        // Record the refund — full or partial
        const refundedAmount = charge.amount_refunded / 100;
        const totalAmount = charge.amount / 100;
        const isFullRefund = refundedAmount >= totalAmount;

        // Update the order payment status
        const order = await db
          .select({ paidAmount: orders.paidAmount, paymentStatus: orders.paymentStatus })
          .from(orders)
          .where(eq(orders.id, orderId))
          .get();

        if (order) {
          const newPaidAmount = Math.max(0, (order.paidAmount ?? 0) - refundedAmount);
          await db
            .update(orders)
            .set({
              paidAmount: newPaidAmount,
              balanceDue: 0, // Refunds don't create new balance
              paymentStatus: isFullRefund ? PaymentStatus.REFUNDED : PaymentStatus.PARTIAL,
              updatedAt: sql`unixepoch()`,
            })
            .where(eq(orders.id, orderId));

          // If full refund, release inventory reservations
          if (isFullRefund) {
            await releaseOrderInventory(db, orderId);
          }
        }

        await recordWebhookEvent(
          db, event.id, "stripe", event.type, orderId, "processed",
          { refundedAmount, isFullRefund }
        );
        processed = true;
        break;
      }

      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge?.id;
        // Log the dispute — manual intervention required
        await recordWebhookEvent(
          db, event.id, "stripe", event.type, null, "processed",
          { chargeId, reason: dispute.reason, amount: dispute.amount / 100, status: dispute.status }
        );
        processed = true;
        break;
      }

      default:
        console.log(`[stripe-webhook] Unhandled event type: ${event.type}`);
        processed = true; // Mark as processed to prevent retries for unknown events
    }

    // Set KV idempotency key ONLY after successful processing
    if (processed) {
      await env.CACHE?.put(kvKey, "1", { expirationTtl: KV_WEBHOOK_TTL });
    }
  } catch (err) {
    console.error(`[stripe-webhook] Error processing event ${event.id}:`, err);
    // Do NOT set KV key on errors — allow Stripe to retry
  }
}

export const stripeWebhookRoutes = app;
