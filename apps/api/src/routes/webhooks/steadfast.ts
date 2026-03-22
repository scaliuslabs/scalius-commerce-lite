// src/server/routes/webhooks/steadfast.ts
// Webhook endpoint for receiving Steadfast delivery status push notifications.

import { OpenAPIHono } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { deliveryShipments, orders } from "@scalius/database/schema";
import { mapProviderStatus } from "@scalius/core/modules/delivery/status-mapper";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { recordWebhookEvent } from "@scalius/core/modules/payments/process-payment";
import { verifyDeliveryWebhook } from "../../middleware/webhook-auth";

const app = new OpenAPIHono<{ Bindings: Env }>();

app.post("/", async (c) => {
    const db = c.get("db");

    // Read raw body for signature verification (must be done before .json())
    const rawBody = await c.req.text();

    // --- Webhook signature / IP verification ---
    const verification = await verifyDeliveryWebhook(
        c.env,
        "steadfast",
        c.req.raw,
        rawBody,
    );

    if (!verification.verified) {
        console.warn(`[steadfast-webhook] Rejected: ${verification.reason}`);
        return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
        const payload = JSON.parse(rawBody) as {
            notification_type?: string;
            consignment_id?: number;
            invoice?: string;
            cod_amount?: number;
            status?: string;
            delivery_charge?: number;
            tracking_message?: string;
            updated_at?: string;
            [key: string]: unknown;
        };

        const notificationType = payload.notification_type;

        // Idempotency: deduplicate webhook events via KV
        const consignmentIdRaw = String(payload.consignment_id ?? "");
        const kvKey = `delivery_wh:steadfast:${consignmentIdRaw}_${notificationType || "unknown"}`;
        const existing = await c.env.CACHE.get(kvKey);
        if (existing) {
            return c.json({ status: "success", message: "Webhook received successfully.", deduplicated: true });
        }

        // Only process delivery_status notifications; acknowledge tracking_update without processing
        if (notificationType === "tracking_update") {
            // Store tracking update in metadata if we can find the shipment, but don't change status
            const consignmentId = String(payload.consignment_id ?? "");
            const invoice = payload.invoice;

            let shipment = consignmentId
                ? await db
                    .select()
                    .from(deliveryShipments)
                    .where(eq(deliveryShipments.externalId, consignmentId))
                    .get()
                : undefined;

            if (!shipment && invoice) {
                shipment = await db
                    .select()
                    .from(deliveryShipments)
                    .where(eq(deliveryShipments.trackingId, invoice))
                    .get();
            }

            if (shipment) {
                let existingMeta: Record<string, unknown> = {};
                try { existingMeta = JSON.parse(shipment.metadata ?? "{}"); } catch { /* invalid JSON */ }
                await db
                    .update(deliveryShipments)
                    .set({
                        lastChecked: new Date(),
                        metadata: JSON.stringify({
                            ...existingMeta,
                            lastTrackingMessage: payload.tracking_message,
                            lastTrackingUpdate: payload.updated_at,
                        }),
                    })
                    .where(eq(deliveryShipments.id, shipment.id));
            }

            // Mark event as processed in KV (24h TTL)
            await c.env.CACHE.put(kvKey, JSON.stringify({ processedAt: Date.now() }), { expirationTtl: 86400 });

            return c.json({ status: "success", message: "Webhook received successfully." });
        }

        if (notificationType !== "delivery_status") {
            return c.json({ status: "error", message: `Unknown notification_type: ${notificationType}` }, 400);
        }

        // --- Process delivery_status ---
        const consignmentId = String(payload.consignment_id ?? "");
        const invoice = payload.invoice;
        const rawStatus = payload.status;

        if (!rawStatus || (!consignmentId && !invoice)) {
            return c.json({ status: "error", message: "Missing status or consignment identifiers" }, 400);
        }

        let shipment = consignmentId
            ? await db
                .select()
                .from(deliveryShipments)
                .where(eq(deliveryShipments.externalId, consignmentId))
                .get()
            : undefined;

        if (!shipment && invoice) {
            shipment = await db
                .select()
                .from(deliveryShipments)
                .where(eq(deliveryShipments.trackingId, invoice))
                .get();
        }

        if (!shipment) {
            console.warn(`[steadfast-webhook] No shipment found for consignment: ${consignmentId}, invoice: ${invoice}`);
            return c.json({ status: "success", message: "Webhook received successfully." });
        }

        const normalizedStatus = mapProviderStatus("steadfast", rawStatus);
        const previousStatus = shipment.status;

        // Build updated metadata with all Steadfast-specific fields
        let existingMeta: Record<string, unknown> = {};
        try { existingMeta = JSON.parse(shipment.metadata ?? "{}"); } catch { /* invalid JSON */ }
        const updatedMeta: Record<string, unknown> = {
            ...existingMeta,
            lastWebhookPayload: payload,
            lastWebhookAt: new Date().toISOString(),
            codAmount: payload.cod_amount,
        };
        if (payload.delivery_charge !== undefined) {
            updatedMeta.deliveryCharge = payload.delivery_charge;
        }
        if (payload.tracking_message) {
            updatedMeta.lastTrackingMessage = payload.tracking_message;
        }

        await db
            .update(deliveryShipments)
            .set({
                status: normalizedStatus,
                rawStatus: rawStatus,
                lastChecked: new Date(),
                updatedAt: new Date(),
                metadata: JSON.stringify(updatedMeta),
            })
            .where(eq(deliveryShipments.id, shipment.id));

        if (normalizedStatus !== previousStatus) {
            const statusResult = await updateOrderStatusFromShipment(db, shipment.id, normalizedStatus);

            // Enqueue customer notification for delivery status changes
            if (statusResult && statusResult.newStatus && c.env.ORDER_NOTIFICATIONS_QUEUE) {
                const DELIVERY_NOTIFICATION_MAP: Record<string, string> = {
                    shipped: "order_shipped",
                    delivered: "order_delivered",
                    returned: "order_returned",
                    cancelled: "order_cancelled",
                };
                const notifType = DELIVERY_NOTIFICATION_MAP[statusResult.newStatus];
                if (notifType) {
                    try {
                        const order = await db.select({
                            customerEmail: orders.customerEmail,
                            customerName: orders.customerName,
                        }).from(orders).where(eq(orders.id, statusResult.orderId)).get();

                        if (order) {
                            await c.env.ORDER_NOTIFICATIONS_QUEUE.send({
                                type: "order.notification",
                                orderId: statusResult.orderId,
                                customerEmail: order.customerEmail ?? undefined,
                                customerName: order.customerName,
                                notificationType: notifType,
                                data: shipment.trackingId ? { trackingId: shipment.trackingId } : undefined,
                            });
                        }
                    } catch (notifErr) {
                        console.error(`[steadfast-webhook] Failed to enqueue notification:`, notifErr);
                    }
                }
            }
        }

        await recordWebhookEvent(
            db,
            `steadfast_${consignmentId}_${rawStatus}`,
            "steadfast",
            "status_update",
            shipment.orderId,
            "processed",
            { consignmentId, invoice, rawStatus, normalizedStatus, previousStatus }
        );

        // Mark event as processed in KV (24h TTL)
        await c.env.CACHE.put(kvKey, JSON.stringify({ processedAt: Date.now() }), { expirationTtl: 86400 });

        // Steadfast expects HTTP 200 with this exact response shape
        return c.json({ status: "success", message: "Webhook received successfully." });
    } catch (error: unknown) {
        console.error("[steadfast-webhook] Error:", error);
        return c.json({ status: "error", message: "Internal processing error" }, 500);
    }
});

export const steadfastWebhookRoutes = app;
