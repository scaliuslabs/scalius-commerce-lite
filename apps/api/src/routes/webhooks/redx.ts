// src/server/routes/webhooks/redx.ts
// Webhook endpoint for receiving RedX delivery status push notifications.
// RedX includes auth token as a query parameter in the callback URL (e.g. ?token=xxx).

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

    // --- Webhook token verification ---
    const verification = await verifyDeliveryWebhook(
        c.env,
        "redx",
        c.req.raw,
        rawBody,
    );

    if (!verification.verified) {
        console.warn(`[redx-webhook] Rejected: ${verification.reason}`);
        return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
        const payload = JSON.parse(rawBody) as {
            tracking_number?: string;
            timestamp?: string;
            status?: string;
            message_en?: string;
            message_bn?: string;
            invoice_number?: string;
            [key: string]: unknown;
        };

        const trackingId = payload.tracking_number;
        const rawStatus = payload.status;

        if (!rawStatus || !trackingId) {
            return c.json({ success: false, error: "Missing status or tracking_number" }, 400);
        }

        // Look up shipment by externalId (tracking_id) or trackingId
        let shipment = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.externalId, trackingId))
            .get();

        if (!shipment) {
            shipment = await db
                .select()
                .from(deliveryShipments)
                .where(eq(deliveryShipments.trackingId, trackingId))
                .get();
        }

        if (!shipment) {
            console.warn(`[redx-webhook] No shipment found for tracking_number: ${trackingId}`);
            return c.json({ success: true, message: "Shipment not found, ignored" });
        }

        const normalizedStatus = mapProviderStatus("redx", rawStatus);
        const previousStatus = shipment.status;

        await db
            .update(deliveryShipments)
            .set({
                status: normalizedStatus,
                rawStatus: rawStatus,
                lastChecked: new Date(),
                updatedAt: new Date(),
                metadata: JSON.stringify({
                    ...JSON.parse(shipment.metadata ?? "{}"),
                    lastWebhookPayload: payload,
                    lastWebhookAt: new Date().toISOString(),
                    messageEn: payload.message_en,
                    messageBn: payload.message_bn,
                    invoiceNumber: payload.invoice_number,
                })
            })
            .where(eq(deliveryShipments.id, shipment.id));

        if (normalizedStatus !== previousStatus) {
            await ShipmentTracker.updateOrderStatusFromShipment(shipment.id, normalizedStatus);
            await ShipmentTracker.notifyStatusChange(shipment.id, previousStatus, normalizedStatus);
        }

        await recordWebhookEvent(
            db,
            `redx_${trackingId}_${rawStatus}`,
            "redx",
            "status_update",
            shipment.orderId,
            "processed",
            { trackingId, rawStatus, normalizedStatus, previousStatus }
        );

        return c.json({ success: true, status: normalizedStatus });
    } catch (error) {
        console.error("[redx-webhook] Error:", error);
        return c.json({ success: false, error: "Internal processing error" }, 500);
    }
});

export const redxWebhookRoutes = app;
