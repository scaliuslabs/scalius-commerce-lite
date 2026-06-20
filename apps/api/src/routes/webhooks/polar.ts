// src/server/routes/webhooks/polar.ts
// Webhook handler for Polar.sh events.

import { OpenAPIHono } from "@hono/zod-openapi";
import { verifyPolarWebhook } from "@scalius/core/modules/payments/polar";
import {
    FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
    getPolarSettings,
} from "@scalius/core/modules/payments/gateway-settings";
import { type Database } from "@scalius/database/client";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import type { PaymentQueueMessage } from "../../queue-consumer";
import {
    buildWebhookEventId,
    claimWebhookEvent,
    markWebhookEventFailed,
    markWebhookEventProcessed,
    markWebhookEventQueued,
} from "../../utils/webhook-idempotency";

export const polarWebhookRoutes = new OpenAPIHono<{ Bindings: Env }>();

export function getPolarSourceEventId(payload: {
    id?: string;
    type: string;
    data: {
        id: string;
        status?: string;
        amount?: number;
        total_amount?: number;
        refunded_amount?: number;
        checkout_id?: string;
        metadata?: Record<string, string>;
        [key: string]: unknown;
    };
}): string {
    if (payload.id) return payload.id;

    if (payload.type === "order.refunded") {
        return [
            payload.data.id,
            payload.data.checkout_id,
            payload.data.status,
            payload.data.refunded_amount,
            payload.data.total_amount,
            payload.data.metadata?.orderId,
        ].filter((part) => part !== undefined && part !== null && part !== "").join(":");
    }

    return [
        payload.data.id,
        payload.data.status,
        payload.data.metadata?.orderId,
    ].filter((part) => part !== undefined && part !== null && part !== "").join(":");
}

polarWebhookRoutes.post("/", async (c) => {
    try {
        const rawBody = await c.req.text();

        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
            headers[key] = value;
        });

        const db: Database = c.get("db");
        const kv = c.env.CACHE;
        const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);

        let polarSettings: Awaited<ReturnType<typeof getPolarSettings>>;
        try {
            polarSettings = await getPolarSettings(
                db,
                kv,
                encryptionKey,
                FRESH_GATEWAY_SETTINGS_READ_OPTIONS,
            );
        } catch (error) {
            console.error(
                "[Polar Webhook] Polar settings read failed:",
                error instanceof Error ? error.message : error,
            );
            return c.json({ error: "Webhook settings unavailable" }, 503);
        }
        const webhookSecretUnreadable = polarSettings?.credentialErrors?.some((error) =>
            error.toLowerCase().includes("webhook secret"),
        );
        if (webhookSecretUnreadable) {
            console.error("[Polar Webhook] Polar webhook secret is not readable:", polarSettings?.credentialErrors?.[0]);
            return c.json({ error: "Webhook settings unavailable" }, 503);
        }
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
        const sourceEventId = getPolarSourceEventId(payload);
        const eventId = buildWebhookEventId("polar", eventType, sourceEventId);

        console.log(`[Polar Webhook] Received event: ${eventType}, id: ${eventId}`);

        const queue = c.env.PAYMENT_EVENTS_QUEUE as Queue;
        const orderId = payload.data.metadata?.orderId;
        const claim = await claimWebhookEvent(db, {
            id: eventId,
            provider: "polar",
            eventType,
            orderId,
            status: "processing",
            result: { sourceEventId, payloadDataId: payload.data.id },
        });

        if (!claim.claimed) {
            console.log(`[Polar Webhook] Duplicate event ${eventId}, status=${claim.existing?.status ?? "unknown"}, skipping`);
            return c.json({ received: true, duplicate: true, status: claim.existing?.status ?? "unknown" });
        }

        if (!queue) {
            console.error("[Polar Webhook] PAYMENT_EVENTS_QUEUE not available");
            await markWebhookEventFailed(db, eventId, { error: "Queue not available" });
            return c.json({ error: "Queue not available" }, 503);
        }

        try {
            let enqueued = false;

            switch (eventType) {
                case "checkout.updated": {
                    const status = payload.data.status;

                    if (status === "failed" || status === "expired") {
                        await queue.send({
                            type: "payment.polar.failed",
                            orderId: orderId || "",
                            checkoutId: payload.data.id,
                            reason: status
                        });
                        enqueued = true;
                        console.log(`[Polar Webhook] Enqueued payment.polar.failed for order ${orderId}`);
                    }
                    break;
                }

                case "order.paid": {
                    if (orderId) {
                        await queue.send({
                            type: "payment.polar.confirmed",
                            orderId,
                            checkoutId: payload.data.id,
                            amount: payload.data.amount,
                            currency: payload.data.currency,
                            paymentType: payload.data.metadata?.paymentType || "full",
                            metadata: payload.data.metadata
                        });
                        enqueued = true;
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
                    const polarCheckoutId = (polarData.checkout_id as string) ?? payload.data.id;

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
                        enqueued = true;
                        console.log(`[Polar Webhook] Enqueued payment.polar.refunded for order ${orderId} (${refundedAmountCents} ${polarCurrency} cents, status: ${polarStatus})`);
                    } else {
                        console.warn(`[Polar Webhook] order.refunded missing orderId or refundedAmount, skipping. orderId=${orderId}, refundedAmount=${refundedAmountCents}`);
                    }
                    break;
                }

                default:
                    console.log(`[Polar Webhook] Unhandled event type: ${eventType}`);
            }

            if (enqueued) {
                await markWebhookEventQueued(db, eventId, { sourceEventId, eventType });
            } else {
                await markWebhookEventProcessed(db, eventId, { sourceEventId, eventType, enqueued: false });
            }
        } catch (error: unknown) {
            await markWebhookEventFailed(db, eventId, {
                sourceEventId,
                eventType,
                error: error instanceof Error ? error.message : String(error),
            });
            return c.json({ error: "Failed to enqueue payment event" }, 503);
        }

        return c.json({ received: true });
    } catch (error: unknown) {
        console.error("[Polar Webhook] Unhandled error:", error);
        return c.json({ error: "Internal error" }, 500);
    }
});
