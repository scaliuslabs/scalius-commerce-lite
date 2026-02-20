// src/server/routes/webhooks/steadfast.ts
// Webhook endpoint for receiving Steadfast delivery status push notifications.
//
// Steadfast sends status updates when a shipment's status changes.
// This endpoint validates the request, maps the status, updates the
// shipment record, and auto-updates the order status.

import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { deliveryShipments } from "@/db/schema";
import { getDb } from "@/db";
import { mapProviderStatus } from "@/lib/delivery/status-mapper";
import { ShipmentTracker } from "@/lib/delivery/tracking";
import { recordWebhookEvent } from "@/lib/payment/process-payment";

const app = new Hono<{ Bindings: Env }>();

/**
 * POST /webhooks/steadfast
 *
 * Steadfast webhook payload typically contains:
 * - consignment_id: number
 * - tracking_code: string
 * - status: string (e.g., "in_review", "delivered", "cancelled", etc.)
 * - invoice: string
 * - recipient_name: string
 * - recipient_phone: string
 * - note: string
 */
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

        // Find shipment by external ID or tracking ID
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

        // Map Steadfast status to our standardized status
        const normalizedStatus = mapProviderStatus("steadfast", rawStatus);
        const previousStatus = shipment.status;

        // Update shipment record
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
                    codAmount: payload.cod_amount,
                }),
            })
            .where(eq(deliveryShipments.id, shipment.id));

        // Auto-update order status based on shipment status
        if (normalizedStatus !== previousStatus) {
            await ShipmentTracker.updateOrderStatusFromShipment(shipment.id, normalizedStatus);
            await ShipmentTracker.notifyStatusChange(shipment.id, previousStatus, normalizedStatus);
        }

        // Record webhook event
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
