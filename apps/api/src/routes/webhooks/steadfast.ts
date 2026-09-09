// src/server/routes/webhooks/steadfast.ts
// Webhook endpoint for receiving Steadfast delivery status push notifications.

import { OpenAPIHono } from "@hono/zod-openapi";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
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

type ShipmentRow = typeof deliveryShipments.$inferSelect;

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

function parseConsignmentId(value: unknown): string | null {
    return Number.isSafeInteger(value) && Number(value) > 0 ? String(value) : null;
}

function parseInvoice(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function findSteadfastShipment(
    db: Database,
    providerId: string,
    consignmentId: string | null,
    invoice: string | null,
): Promise<{ shipment: ShipmentRow | null; rejection?: "identity_conflict" | "ambiguous_recovery" }> {
    const exact = consignmentId
        ? await db.select().from(deliveryShipments).where(and(
            eq(deliveryShipments.externalId, consignmentId),
            eq(deliveryShipments.providerType, "steadfast"),
            eq(deliveryShipments.providerId, providerId),
        )).get()
        : undefined;
    if (exact) {
        return invoice && exact.orderId !== invoice
            ? { shipment: null, rejection: "identity_conflict" }
            : { shipment: exact };
    }
    if (!consignmentId || !invoice) return { shipment: null };

    const recovered = await db.select().from(deliveryShipments).where(and(
        eq(deliveryShipments.orderId, invoice),
        eq(deliveryShipments.providerType, "steadfast"),
        eq(deliveryShipments.providerId, providerId),
        sql`CASE WHEN json_valid(${deliveryShipments.metadata}) THEN json_extract(${deliveryShipments.metadata}, '$.unknownOutcomeResolution.outcome') END = 'confirmed_existing'`,
    )).limit(2);
    if (recovered.length !== 1) {
        return { shipment: null, rejection: recovered.length > 1 ? "ambiguous_recovery" : undefined };
    }

    const candidate = recovered[0]!;
    if (candidate.externalId) {
        return candidate.externalId === consignmentId
            ? { shipment: candidate }
            : { shipment: null, rejection: "identity_conflict" };
    }

    const bound = await db.update(deliveryShipments).set({
        externalId: consignmentId,
        updatedAt: new Date(),
    }).where(and(
        eq(deliveryShipments.id, candidate.id),
        eq(deliveryShipments.orderId, invoice),
        eq(deliveryShipments.providerType, "steadfast"),
        eq(deliveryShipments.providerId, providerId),
        isNull(deliveryShipments.externalId),
        sql`CASE WHEN json_valid(${deliveryShipments.metadata}) THEN json_extract(${deliveryShipments.metadata}, '$.unknownOutcomeResolution.outcome') END = 'confirmed_existing'`,
    )).returning({ id: deliveryShipments.id });

    if (bound.length === 1) {
        return { shipment: { ...candidate, externalId: consignmentId } };
    }

    const concurrentlyBound = await db.select().from(deliveryShipments).where(and(
        eq(deliveryShipments.id, candidate.id),
        eq(deliveryShipments.orderId, invoice),
        eq(deliveryShipments.providerType, "steadfast"),
        eq(deliveryShipments.providerId, providerId),
        eq(deliveryShipments.externalId, consignmentId),
        sql`CASE WHEN json_valid(${deliveryShipments.metadata}) THEN json_extract(${deliveryShipments.metadata}, '$.unknownOutcomeResolution.outcome') END = 'confirmed_existing'`,
    )).get();
    return concurrentlyBound
        ? { shipment: concurrentlyBound }
        : { shipment: null, rejection: "identity_conflict" };
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
            const consignmentId = parseConsignmentId(payload.consignment_id);
            const invoice = parseInvoice(payload.invoice);
            const match = await findSteadfastShipment(
                db,
                verification.providerId,
                consignmentId,
                invoice,
            );
            const shipment = match.shipment;
            if (match.rejection) {
                console.warn(`[steadfast-webhook] Shipment match rejected: ${match.rejection}`);
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
        const consignmentId = parseConsignmentId(payload.consignment_id);
        const invoice = parseInvoice(payload.invoice);
        const rawStatus = payload.status;

        if (!rawStatus || (!consignmentId && !invoice)) {
            return c.json({ status: "error", message: "Missing status or consignment identifiers" }, 400);
        }

        const match = await findSteadfastShipment(
            db,
            verification.providerId,
            consignmentId,
            invoice,
        );
        const shipment = match.shipment;
        if (match.rejection) {
            console.warn(`[steadfast-webhook] Shipment match rejected: ${match.rejection}`);
        }

        if (!shipment) {
            console.warn("[steadfast-webhook] No eligible shipment found");
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
    } catch {
        console.error("[steadfast-webhook] Processing failed");
        if (claimedEventId) {
            await markWebhookEventFailed(db, claimedEventId, {
                error: "steadfast_webhook_processing_failed",
            });
        }
        return c.json({ status: "error", message: "Internal processing error" }, 500);
    }
});

export const steadfastWebhookRoutes = app;
