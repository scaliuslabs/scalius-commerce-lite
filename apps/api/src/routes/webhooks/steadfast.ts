// src/server/routes/webhooks/steadfast.ts
// Webhook endpoint for receiving Steadfast delivery status push notifications.

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
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";

const app = new OpenAPIHono<{ Bindings: Env }>();

interface SteadfastWebhookPayload {
    notification_type?: string;
    consignment_id?: number;
    invoice?: string;
    cod_amount?: number;
    status?: string;
    delivery_charge?: number;
    tracking_message?: string;
    updated_at?: string;
    [key: string]: unknown;
}

function normalizeKeyPart(value: unknown): string {
    const raw = value === undefined || value === null || value === "" ? "unknown" : String(value);
    return raw
        .toLowerCase()
        .replace(/[^a-z0-9:_-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 120) || "unknown";
}

export function buildSteadfastWebhookDedupKey(payload: SteadfastWebhookPayload): string {
    const notificationType = payload.notification_type || "unknown";
    const identifier = payload.consignment_id ?? payload.invoice ?? "unknown";
    const eventPart = notificationType === "delivery_status"
        ? payload.status
        : payload.updated_at ?? payload.tracking_message ?? "unknown";

    return [
        "delivery_wh:steadfast",
        normalizeKeyPart(identifier),
        normalizeKeyPart(notificationType),
        normalizeKeyPart(eventPart),
    ].join(":");
}

app.post("/", async (c) => {
    const db = c.get("db");
    let claimedEventId: string | null = null;

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
    if (!verification.providerId) {
        console.warn("[steadfast-webhook] Rejected: verified provider id missing");
        return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
        const payload = JSON.parse(rawBody) as SteadfastWebhookPayload;

        const notificationType = payload.notification_type;

        // Only process delivery_status notifications; acknowledge tracking_update without processing
        if (notificationType === "tracking_update") {
            // Store tracking update in metadata if we can find the shipment, but don't change status
            const consignmentId = String(payload.consignment_id ?? "");
            const invoice = payload.invoice;

            let shipment = consignmentId
                ? await db
                    .select()
                    .from(deliveryShipments)
                    .where(and(
                        eq(deliveryShipments.externalId, consignmentId),
                        eq(deliveryShipments.providerType, "steadfast"),
                        eq(deliveryShipments.providerId, verification.providerId),
                    ))
                    .get()
                : undefined;

            if (!shipment && invoice) {
                shipment = await db
                    .select()
                    .from(deliveryShipments)
                    .where(and(
                        eq(deliveryShipments.trackingId, invoice),
                        eq(deliveryShipments.providerType, "steadfast"),
                        eq(deliveryShipments.providerId, verification.providerId),
                    ))
                    .get();
            }

            if (shipment) {
                const sourceEventId = buildSteadfastWebhookDedupKey(payload);
                const eventId = buildWebhookEventId("steadfast", "tracking_update", sourceEventId);
                const claim = await claimWebhookEvent(db, {
                    id: eventId,
                    provider: "steadfast",
                    eventType: "tracking_update",
                    orderId: shipment.orderId,
                    status: "processing",
                    result: { sourceEventId },
                });

                if (!claim.claimed) {
                    return c.json({
                        status: "success",
                        message: "Webhook received successfully.",
                        deduplicated: true,
                    });
                }
                claimedEventId = eventId;

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

                await markWebhookEventProcessed(db, eventId, {
                    sourceEventId,
                    trackingMessage: payload.tracking_message,
                    updatedAt: payload.updated_at,
                });
            }

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
                .where(and(
                    eq(deliveryShipments.externalId, consignmentId),
                    eq(deliveryShipments.providerType, "steadfast"),
                    eq(deliveryShipments.providerId, verification.providerId),
                ))
                .get()
            : undefined;

        if (!shipment && invoice) {
            shipment = await db
                .select()
                .from(deliveryShipments)
                .where(and(
                    eq(deliveryShipments.trackingId, invoice),
                    eq(deliveryShipments.providerType, "steadfast"),
                    eq(deliveryShipments.providerId, verification.providerId),
                ))
                .get();
        }

        if (!shipment) {
            console.warn(`[steadfast-webhook] No shipment found for consignment: ${consignmentId}, invoice: ${invoice}`);
            return c.json({ status: "success", message: "Webhook received successfully." });
        }

        const sourceEventId = buildSteadfastWebhookDedupKey(payload);
        const eventId = buildWebhookEventId("steadfast", "delivery_status", sourceEventId);
        const claim = await claimWebhookEvent(db, {
            id: eventId,
            provider: "steadfast",
            eventType: "delivery_status",
            orderId: shipment.orderId,
            status: "processing",
            result: { sourceEventId, consignmentId, invoice, rawStatus },
        });

        if (!claim.claimed) {
            return c.json({
                status: "success",
                message: "Webhook received successfully.",
                deduplicated: true,
            });
        }
        claimedEventId = eventId;

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

        const statusResult = await updateOrderStatusFromShipment(db, shipment.id, normalizedStatus);
        await enqueueOrderStatusChangeNotification({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            statusChange: statusResult?.statusChange ?? null,
            trackingId: shipment.trackingId,
            source: "steadfast-webhook",
        });
        if (
            statusResult
            && Array.isArray(statusResult.availabilityTransitionVariantIds)
            && statusResult.availabilityTransitionVariantIds.length > 0
        ) {
            await invalidateProductAvailabilityCaches(
                db,
                { variantIds: statusResult.availabilityTransitionVariantIds },
                c,
            );
        }

        await markWebhookEventProcessed(
            db,
            eventId,
            { consignmentId, invoice, rawStatus, normalizedStatus, previousStatus },
        );

        // Steadfast expects HTTP 200 with this exact response shape
        return c.json({ status: "success", message: "Webhook received successfully." });
    } catch (error: unknown) {
        console.error("[steadfast-webhook] Error:", error);
        if (claimedEventId) {
            await markWebhookEventFailed(db, claimedEventId, {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return c.json({ status: "error", message: "Internal processing error" }, 500);
    }
});

export const steadfastWebhookRoutes = app;
