// src/server/routes/webhooks/polar.ts
// Webhook handler for Polar.sh events.

import { OpenAPIHono } from "@hono/zod-openapi";
import { verifyPolarWebhook } from "@scalius/core/modules/payments/polar";
import { getPolarSettings } from "@scalius/core/modules/payments/gateway-settings";
import { type Database } from "@scalius/database/client";
import { getKv } from "../../utils/kv-cache";
import { getEncryptionKey } from "../../utils/encryption-key";
import type { PaymentQueueMessage } from "../../queue-consumer";

export const polarWebhookRoutes = new OpenAPIHono<{ Bindings: Env }>();

polarWebhookRoutes.post("/", async (c) => {
    try {
        const rawBody = await c.req.text();

        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
            headers[key] = value;
        });

        const db: Database = c.get("db");
        const kv = getKv();
        const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);

        const polarSettings = await getPolarSettings(db, kv, encryptionKey);
        if (!polarSettings || !polarSettings.webhookSecret) {
            console.error("[Polar Webhook] No webhook secret configured");
            return c.json({ error: "Webhook not configured" }, 503);
        }

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

        // Idempotency check via KV
        const idempotencyKey = `polar_webhook:${eventId}:${eventType}`;
        if (kv) {
            const existing = await kv.get(idempotencyKey);
            if (existing) {
                console.log(`[Polar Webhook] Duplicate event ${eventId}, skipping`);
                return c.json({ received: true, duplicate: true });
            }
            await kv.put(idempotencyKey, "1", { expirationTtl: 86400 });
        }

        const queue = c.env.PAYMENT_EVENTS_QUEUE as Queue;

        if (!queue) {
            console.error("[Polar Webhook] PAYMENT_EVENTS_QUEUE not available");
            return c.json({ error: "Queue not available" }, 503);
        }

        const orderId = payload.data.metadata?.orderId;

        switch (eventType) {
            case "checkout.updated": {
                const status = payload.data.status;

                if (status === "failed" || status === "expired") {
                    await queue.send({
                        type: "payment.polar.failed",
                        orderId: orderId || "",
                        checkoutId: eventId,
                        reason: status
                    });
                    console.log(`[Polar Webhook] Enqueued payment.polar.failed for order ${orderId}`);
                }
                break;
            }

            case "order.paid": {
                if (orderId) {
                    await queue.send({
                        type: "payment.polar.confirmed",
                        orderId,
                        checkoutId: eventId,
                        amount: payload.data.amount,
                        currency: payload.data.currency,
                        paymentType: payload.data.metadata?.paymentType || "full",
                        metadata: payload.data.metadata
                    });
                    console.log(`[Polar Webhook] Enqueued payment.polar.confirmed (order.paid) for order ${orderId}`);
                }
                break;
            }

            case "order.refunded": {
                // Polar order.refunded webhook data is a full Order object (snake_case).
                // Fields: id, status ("refunded"|"partially_refunded"), refunded_amount (cents),
                //         total_amount (cents), currency, metadata.orderId, checkout_id.
                const polarData = payload.data as Record<string, unknown>;
                const polarStatus = polarData.status as string | undefined;
                const refundedAmountCents = (polarData.refunded_amount as number) ?? 0;
                const totalAmountCents = (polarData.total_amount as number) ?? 0;
                const polarCurrency = (polarData.currency as string) ?? "usd";
                const polarCheckoutId = (polarData.checkout_id as string) ?? eventId;

                if (orderId && refundedAmountCents > 0) {
                    await queue.send({
                        type: "payment.polar.refunded",
                        orderId,
                        polarCheckoutId,
                        amountRefunded: refundedAmountCents,
                        totalAmount: totalAmountCents,
                        currency: polarCurrency,
                        polarStatus: polarStatus ?? "refunded",
                    } satisfies PaymentQueueMessage);
                    console.log(`[Polar Webhook] Enqueued payment.polar.refunded for order ${orderId} (${refundedAmountCents} ${polarCurrency} cents, status: ${polarStatus})`);
                } else {
                    console.warn(`[Polar Webhook] order.refunded missing orderId or refundedAmount, skipping. orderId=${orderId}, refundedAmount=${refundedAmountCents}`);
                }
                break;
            }

            default:
                console.log(`[Polar Webhook] Unhandled event type: ${eventType}`);
        }

        return c.json({ received: true });
    } catch (error: unknown) {
        console.error("[Polar Webhook] Unhandled error:", error);
        return c.json({ error: "Internal error" }, 500);
    }
});
