// src/server/routes/webhooks/pathao.ts
// Webhook endpoint for receiving Pathao delivery status push notifications.

import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { deliveryShipments } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import { mapProviderStatus } from "@scalius/core/modules/delivery/status-mapper";
import { ShipmentTracker } from "@scalius/core/modules/delivery/tracking";
import { recordWebhookEvent } from "@scalius/core/modules/payments/process-payment";
import { verifyDeliveryWebhook } from "../../middleware/webhook-auth";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
    const db = getDb(c.env);

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

        // Idempotency: deduplicate webhook events via KV
        const eventId = `${consignmentId}_${event}`;
        const kvKey = `delivery_wh:pathao:${eventId}`;
        const existing = await c.env.CACHE.get(kvKey);
        if (existing) {
            return c.json({ received: true, deduplicated: true });
        }

        const shipment = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.externalId, consignmentId))
            .get();

        if (!shipment) {
            console.warn(`[pathao-webhook] No shipment found for consignment_id: ${consignmentId}`);
            return c.json(
                { success: true, message: "Shipment not found, ignored" },
                202,
                { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
            );
        }

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

        if (normalizedStatus !== previousStatus) {
            await ShipmentTracker.updateOrderStatusFromShipment(shipment.id, normalizedStatus);
            await ShipmentTracker.notifyStatusChange(shipment.id, previousStatus, normalizedStatus);
        }

        await recordWebhookEvent(
            db,
            `pathao_${consignmentId}_${event}`,
            "pathao",
            "status_update",
            shipment.orderId,
            "processed",
            { consignmentId, event, normalizedStatus, previousStatus }
        );

        // Mark event as processed in KV (24h TTL)
        await c.env.CACHE.put(kvKey, JSON.stringify({ processedAt: Date.now() }), { expirationTtl: 86400 });

        // Pathao requires HTTP 202 and the merchant secret header
        return c.json(
            { success: true, status: normalizedStatus },
            202,
            { "X-Pathao-Merchant-Webhook-Integration-Secret": merchantSecret },
        );
    } catch (error: unknown) {
        console.error("[pathao-webhook] Error:", error);
        return c.json({ success: false, error: "Internal processing error" }, 500);
    }
});

export const pathaoWebhookRoutes = app;
