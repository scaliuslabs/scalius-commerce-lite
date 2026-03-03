// src/server/routes/webhooks/polar.ts
// Webhook handler for Polar.sh events.
// Pattern mirrors stripe.ts — verify signature, idempotency check, enqueue to CF Queue.

import { Hono } from "hono";
import { verifyPolarWebhook } from "@/modules/payments/polar";
import { getPolarSettings } from "@/modules/payments/gateway-settings";
import { type Database } from "@/db";
import { getKv } from "../../utils/kv-cache";

export const polarWebhookRoutes = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// POST /webhooks/polar — Receive and process Polar webhook events
// ---------------------------------------------------------------------------

polarWebhookRoutes.post("/", async (c) => {
    try {
        // Read the raw body (required for signature verification)
        const rawBody = await c.req.text();

        // Extract relevant headers for webhook verification
        const headers: Record<string, string> = {};
        for (const [key, value] of c.req.raw.headers.entries()) {
            headers[key] = value;
        }

        const db: Database = c.get("db");
        const kv = getKv();

        // Get Polar settings to retrieve the webhook secret
        const polarSettings = await getPolarSettings(db, kv);
        if (!polarSettings || !polarSettings.webhookSecret) {
            console.error("[Polar Webhook] No webhook secret configured");
            return c.json({ error: "Webhook not configured" }, 503);
        }

        // Verify the webhook signature
        const verification = verifyPolarWebhook(
            rawBody,
            headers,
            polarSettings.webhookSecret
        );

        if (!verification.verified) {
            console.error("[Polar Webhook] Signature verification failed:", verification.error);
            return c.json({ error: "Invalid signature" }, 403);
        }

        const { payload } = verification;
        const eventType = payload.type;
        const eventId = payload.data.id;

        console.log(`[Polar Webhook] Received event: ${eventType}, id: ${eventId}`);

        // --- Idempotency check via KV ---
        const idempotencyKey = `polar_webhook:${eventId}:${eventType}`;
        if (kv) {
            const existing = await kv.get(idempotencyKey);
            if (existing) {
                console.log(`[Polar Webhook] Duplicate event ${eventId}, skipping`);
                return c.json({ received: true, duplicate: true });
            }
            // Mark as processed (TTL: 24 hours)
            await kv.put(idempotencyKey, "1", { expirationTtl: 86400 });
        }

        // --- Route events to the payment queue ---
        const queue = (c.env as any).PAYMENT_EVENTS_QUEUE as Queue;

        if (!queue) {
            console.error("[Polar Webhook] PAYMENT_EVENTS_QUEUE not available");
            return c.json({ error: "Queue not available" }, 503);
        }

        // Extract order ID from metadata
        const orderId = payload.data.metadata?.orderId;

        switch (eventType) {
            case "checkout.updated": {
                const status = payload.data.status;

                if (status === "failed" || status === "expired") {
                    await queue.send({
                        type: "payment.polar.failed",
                        orderId: orderId || "",
                        checkoutId: eventId,
                        reason: status,
                    });
                    console.log(`[Polar Webhook] Enqueued payment.polar.failed for order ${orderId}`);
                }
                // Other statuses (open, confirmed) are intermediate or we handle success via order.paid
                break;
            }

            case "order.paid": {
                // We strictly use order.paid as the primary confirmation event because it contains the Polar Order ID (eventId),
                // which is required for issuing refunds. checkout.updated does not contain the Order ID.
                if (orderId) {
                    await queue.send({
                        type: "payment.polar.confirmed",
                        orderId,
                        checkoutId: eventId, // Passing Polar Order ID here so it correctly saves to DB as polarCheckoutId
                        amount: payload.data.amount,
                        currency: payload.data.currency,
                        paymentType: payload.data.metadata?.paymentType || "full",
                        metadata: payload.data.metadata,
                    });
                    console.log(`[Polar Webhook] Enqueued payment.polar.confirmed (order.paid) for order ${orderId}`);
                }
                break;
            }

            case "order.refunded": {
                // Handle refunds — log for now, full refund flow can be added later
                console.log(`[Polar Webhook] Refund event for checkout ${eventId}, order ${orderId}`);
                break;
            }

            default:
                console.log(`[Polar Webhook] Unhandled event type: ${eventType}`);
        }

        // Always respond 200 to acknowledge receipt
        return c.json({ received: true });
    } catch (error) {
        console.error("[Polar Webhook] Unhandled error:", error);
        return c.json({ error: "Internal error" }, 500);
    }
});
