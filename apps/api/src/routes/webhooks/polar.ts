// src/server/routes/webhooks/polar.ts
// Webhook handler for Polar.sh events.

import { OpenAPIHono } from "@hono/zod-openapi";
import { verifyPolarWebhook } from "@scalius/core/modules/payments/polar";
import { getPolarSettings } from "@scalius/core/modules/payments/gateway-settings";
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

type PolarWebhookData = {
    id: string;
    status?: string;
    totalAmount?: number;
    refundedAmount?: number;
    checkoutId?: string | null;
    currency?: string;
    metadata?: Record<string, string>;
    [key: string]: unknown;
};

export function getPolarSourceEventId(payload: {
    type: string;
    data: PolarWebhookData;
}): string {
    if (payload.type === "order.refunded") {
        return [
            payload.data.id,
            payload.data.checkoutId,
            payload.data.status,
            payload.data.refundedAmount,
            payload.data.totalAmount,
            payload.data.metadata?.orderId,
        ].filter((part) => part !== undefined && part !== null && part !== "").join(":");
    }

    return [
        payload.data.id,
        payload.data.status,
        payload.data.metadata?.orderId,
    ].filter((part) => part !== undefined && part !== null && part !== "").join(":");
}

function getPolarCheckoutIdFromOrderPayload(data: PolarWebhookData): string | undefined {
    return data.checkoutId?.trim() || undefined;
}

function getPolarOrderPaidAmount(data: PolarWebhookData): number | undefined {
    return typeof data.totalAmount === "number" && Number.isFinite(data.totalAmount)
        ? data.totalAmount
        : undefined;
}

polarWebhookRoutes.post("/", async (c) => {
    try {
        const rawBody = await c.req.text();

        const headers: Record<string, string> = {};
        c.req.raw.headers.forEach((value, key) => {
            headers[key] = value;
        });

        const db: Database = c.get("db");
        const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);

        let polarSettings: Awaited<ReturnType<typeof getPolarSettings>>;
        try {
            polarSettings = await getPolarSettings(
                db,
                encryptionKey,
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
                            webhookEventId: eventId,
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
                        const checkoutId = getPolarCheckoutIdFromOrderPayload(payload.data);
                        if (!checkoutId) {
                            console.warn(`[Polar Webhook] order.paid missing checkoutId, skipping. orderId=${orderId}`);
                            break;
                        }

                        await queue.send({
                            type: "payment.polar.confirmed",
                            webhookEventId: eventId,
                            orderId,
                            checkoutId,
                            amount: getPolarOrderPaidAmount(payload.data),
                            currency: payload.data.currency,
                            paymentType: payload.data.metadata?.paymentType || "full",
                            metadata: payload.data.metadata
                        } satisfies PaymentQueueMessage);
                        enqueued = true;
                        console.log(`[Polar Webhook] Enqueued payment.polar.confirmed (order.paid) for order ${orderId}`);
                    }
                    break;
                }

                case "order.refunded": {
                    const polarStatus = payload.data.status;
                    const refundedAmountCents = payload.data.refundedAmount ?? 0;
                    const totalAmountCents = payload.data.totalAmount ?? 0;
                    const polarCurrency = payload.data.currency ?? "usd";
                    const polarCheckoutId = getPolarCheckoutIdFromOrderPayload(payload.data);

                    if (orderId && polarCheckoutId && refundedAmountCents > 0) {
                        await queue.send({
                            type: "payment.polar.refunded",
                            webhookEventId: eventId,
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
                        console.warn(`[Polar Webhook] order.refunded missing orderId, checkoutId, or refundedAmount, skipping. orderId=${orderId}, checkoutId=${polarCheckoutId ?? "missing"}, refundedAmount=${refundedAmountCents}`);
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
