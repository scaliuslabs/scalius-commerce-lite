// src/server/routes/webhooks/steadfast.ts
// Webhook endpoint for receiving Steadfast delivery status push notifications.

import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { deliveryShipments } from "@scalius/database/schema";
import { getDb } from "@scalius/database/client";
import { mapProviderStatus } from "@scalius/core/modules/delivery/status-mapper";
import { ShipmentTracker } from "@scalius/core/modules/delivery/tracking";
import { recordWebhookEvent } from "@scalius/core/modules/payments/process-payment";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
    const db = getDb(c.env);

    try {
        const payload = await c.req.json() as {
            consignment_id?: number;
            tracking_code?: string;
            status?: string;
            invoice?: string;
            recipient_name?: string;
            recipient_phone?: string;
            cod_amount?: number;
            note?: string;
            [key: string]: unknown;
        };

        const consignmentId = String(payload.consignment_id ?? "");
        const trackingCode = payload.tracking_code;
        const rawStatus = payload.status;

        if (!rawStatus || (!consignmentId && !trackingCode)) {
            return c.json({ success: false, error: "Missing status or consignment identifiers" }, 400);
        }

        let shipment = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.externalId, consignmentId))
            .get();

        if (!shipment && trackingCode) {
            shipment = await db
                .select()
                .from(deliveryShipments)
                .where(eq(deliveryShipments.trackingId, trackingCode))
                .get();
        }

        if (!shipment) {
            console.warn(`[steadfast-webhook] No shipment found for consignment: ${consignmentId}, tracking: ${trackingCode}`);
            return c.json({ success: true, message: "Shipment not found, ignored" });
        }

        const normalizedStatus = mapProviderStatus("steadfast", rawStatus);
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
                    codAmount: payload.cod_amount
                })
            })
            .where(eq(deliveryShipments.id, shipment.id));

        if (normalizedStatus !== previousStatus) {
            await ShipmentTracker.updateOrderStatusFromShipment(shipment.id, normalizedStatus);
            await ShipmentTracker.notifyStatusChange(shipment.id, previousStatus, normalizedStatus);
        }

        await recordWebhookEvent(
            db,
            `steadfast_${consignmentId}_${rawStatus}`,
            "steadfast",
            "status_update",
            shipment.orderId,
            "processed",
            { consignmentId, trackingCode, rawStatus, normalizedStatus, previousStatus }
        );

        return c.json({ success: true, status: normalizedStatus });
    } catch (error) {
        console.error("[steadfast-webhook] Error:", error);
        return c.json({ success: true, message: "Error processing, will retry" });
    }
});

export const steadfastWebhookRoutes = app;
