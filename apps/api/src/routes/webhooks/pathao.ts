// src/server/routes/webhooks/pathao.ts
// Webhook endpoint for receiving Pathao delivery status push notifications.

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

        const shipment = await db
            .select()
            .from(deliveryShipments)
            .where(eq(deliveryShipments.externalId, consignmentId))
            .get();

        if (!shipment) {
            console.warn(`[pathao-webhook] No shipment found for consignment_id: ${consignmentId}`);
            return c.json({ success: true, message: "Shipment not found, ignored" });
        }

        const normalizedStatus = mapProviderStatus("pathao", rawStatus);
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
                }),
            })
            .where(eq(deliveryShipments.id, shipment.id));

        if (normalizedStatus !== previousStatus) {
            await ShipmentTracker.updateOrderStatusFromShipment(shipment.id, normalizedStatus);
            await ShipmentTracker.notifyStatusChange(shipment.id, previousStatus, normalizedStatus);
        }

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
