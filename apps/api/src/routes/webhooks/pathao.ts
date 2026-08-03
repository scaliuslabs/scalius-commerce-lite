// src/server/routes/webhooks/pathao.ts
// Webhook endpoint for receiving Pathao delivery status push notifications.

import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { deliveryShipments } from "@scalius/database/schema";
import { mapProviderStatus } from "@scalius/core/modules/delivery/status-mapper";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { verifyDeliveryWebhook } from "../../middleware/webhook-auth";
import {
    buildWebhookEventId,
    claimWebhookEvent,
    markWebhookEventFailed,
    markWebhookEventProcessed,
} from "../../utils/webhook-idempotency";
import { enqueueOrderStatusChangeNotification } from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
    const db = c.get("db");
    let claimedEventId: string | null = null;

    // Read raw body for signature verification (must be done before .json())
    const rawBody = await c.req.text();

    // --- Webhook signature / IP verification ---
    const verification = await verifyDeliveryWebhook(
        c.env,
        "pathao",
        c.req.raw,
        rawBody,
    );

    if (!verification.verified) {
        console.warn(`[pathao-webhook] Rejected: ${verification.reason}`);
        return c.json({ success: false, error: "Unauthorized" }, 401);
    }
    if (!verification.providerId) {
        console.warn("[pathao-webhook] Rejected: verified provider id missing");
        return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    // Pathao requires this secret in the response header.
    // Use configured webhookSecret, fall back to the integration test value from Pathao docs.
    const merchantSecret =
        (verification.credentials?.webhookSecret as string | undefined) ??
        "f3992ecc-59da-4cbe-a049-a13da2018d51";

    try {
        const payload = JSON.parse(rawBody) as {
            consignment_id?: string;
            merchant_order_id?: string;
            event?: string;
            updated_at?: string;
            timestamp?: string;
            store_id?: number;
            delivery_fee?: number;
            collected_amount?: number;
            reason?: string;
            invoice_id?: string;
            [key: string]: unknown;
        };

        const consignmentId = payload.consignment_id;
        const event = payload.event;

        if (!event) {
            return c.json({ success: false, error: "Missing event field" }, 400);
        }

        // Handle Pathao's webhook integration test.
        // Pathao sends { event: "webhook_integration" } to verify the endpoint.
        // Must return 202 + the secret header to pass verification.
        if (event === "webhook_integration") {
            return c.json(
                { success: true, message: "Webhook integration verified" },
                202,
                { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
            );
        }

        // Ignore store-level events — they don't map to shipments
        if (event.startsWith("store.")) {
            return c.json(
                { success: true, message: "Store event ignored" },
                202,
                { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
            );
        }

        if (!consignmentId) {
            return c.json({ success: false, error: "Missing consignment_id" }, 400);
        }

        const shipment = await db
            .select()
            .from(deliveryShipments)
            .where(and(
                eq(deliveryShipments.externalId, consignmentId),
                eq(deliveryShipments.providerType, "pathao"),
                eq(deliveryShipments.providerId, verification.providerId),
            ))
            .get();

        if (!shipment) {
            console.warn(`[pathao-webhook] No shipment found for consignment_id: ${consignmentId}`);
            return c.json(
                { success: true, message: "Shipment not found, ignored" },
                202,
                { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
            );
        }

        const eventId = buildWebhookEventId("pathao", event, `${consignmentId}:${event}`);
        const claim = await claimWebhookEvent(db, {
            id: eventId,
            provider: "pathao",
            eventType: event,
            orderId: shipment.orderId,
            status: "processing",
            result: { consignmentId },
        });

        if (!claim.claimed) {
            return c.json(
                { received: true, deduplicated: true, status: claim.existing?.status ?? "unknown" },
                202,
                { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
            );
        }
        claimedEventId = eventId;

        // Map the event field (e.g. "order.delivered") to internal status
        const normalizedStatus = mapProviderStatus("pathao", event);
        const previousStatus = shipment.status;

        // Build updated metadata, including COD collected_amount when present
        let existingMeta: Record<string, unknown> = {};
        try { existingMeta = JSON.parse(shipment.metadata ?? "{}"); } catch { /* invalid JSON */ }
        const updatedMeta: Record<string, unknown> = {
            ...existingMeta,
            lastWebhookPayload: payload,
            lastWebhookAt: new Date().toISOString(),
        };
        if (payload.collected_amount !== undefined) {
            updatedMeta.collectedAmount = payload.collected_amount;
        }
        if (payload.delivery_fee !== undefined) {
            updatedMeta.deliveryFee = payload.delivery_fee;
        }
        if (payload.reason) {
            updatedMeta.lastReason = payload.reason;
        }

        await db
            .update(deliveryShipments)
            .set({
                status: normalizedStatus,
                rawStatus: event,
                lastChecked: new Date(),
                updatedAt: new Date(),
                metadata: JSON.stringify(updatedMeta),
            })
            .where(eq(deliveryShipments.id, shipment.id));

        const statusResult = await updateOrderStatusFromShipment(db, shipment.id, normalizedStatus);
        await enqueueOrderStatusChangeNotification({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            statusChange: statusResult,
            trackingId: shipment.trackingId,
            source: "pathao-webhook",
        });

        await markWebhookEventProcessed(
            db,
            eventId,
            { consignmentId, event, normalizedStatus, previousStatus },
        );

        // Pathao requires HTTP 202 and the merchant secret header
        return c.json(
            { success: true, status: normalizedStatus },
            202,
            { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
        );
    } catch (error: unknown) {
        console.error("[pathao-webhook] Error:", error);
        if (claimedEventId) {
            await markWebhookEventFailed(db, claimedEventId, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return c.json({ success: false, error: "Internal processing error" }, 500);
    }
});

export const pathaoWebhookRoutes = app;
