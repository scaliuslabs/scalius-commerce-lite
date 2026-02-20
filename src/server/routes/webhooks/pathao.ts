// src/server/routes/webhooks/pathao.ts
// Webhook endpoint for receiving Pathao delivery status push notifications.
//
// Pathao sends status updates when a shipment's status changes.
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
 * POST /webhooks/pathao
 *
 * Pathao webhook payload typically contains:
 * - consignment_id: string (our externalId)
 * - order_status: string (Pathao status like "Pickup Pending", "In Transit", etc.)
 * - merchant_order_id: string (our orderId)
 * - invoice_id: string
 * - updated_at: string
 */
app.post("/", async (c) => {
    const db = getDb(c.env);

    try {
        const payload = await c.req.json() as {
            consignment_id?: string;
            order_status?: string;
            order_status_slug?: string;
            merchant_order_id?: string;
            invoice_id?: string;
            updated_at?: string;
            [key: string]: unknown;
        };

        const consignmentId = payload.consignment_id;
        const rawStatus = payload.order_status_slug ?? payload.order_status;

        if (!consignmentId || !rawStatus) {
            return c.json({ success: false, error: "Missing consignment_id or order_status" }, 400);
        }

        // Find the shipment by external ID
        const shipment = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.externalId, consignmentId))
            .get();

        if (!shipment) {
            console.warn(`[pathao-webhook] No shipment found for consignment_id: ${consignmentId}`);
            // Still return 200 so Pathao doesn't retry
            return c.json({ success: true, message: "Shipment not found, ignored" });
        }

        // Map Pathao status to our standardized status
        const normalizedStatus = mapProviderStatus("pathao", rawStatus);
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
            `pathao_${consignmentId}_${rawStatus}`,
            "pathao",
            "status_update",
            shipment.orderId,
            "processed",
            { consignmentId, rawStatus, normalizedStatus, previousStatus }
        );

        return c.json({ success: true, status: normalizedStatus });
    } catch (error) {
        console.error("[pathao-webhook] Error:", error);
        return c.json({ success: true, message: "Error processing, will retry" });
    }
});

export const pathaoWebhookRoutes = app;
