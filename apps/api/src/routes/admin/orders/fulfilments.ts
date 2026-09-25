// Order fulfilment actions on the ledger (Wave A §2.2): send a parcel with
// your own rider, hand a pickup order over at the counter, mark a service
// done, void a fulfilment whose parcel came back, and mark a pickup order
// ready to collect. Courier bookings stay on POST /{id}/shipments.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { MANUAL_FULFILLMENT_TYPES } from "@scalius/shared/fulfilment";
import {
    markOrderReadyForPickup,
    recordOrderFulfilment,
    voidOrderFulfilment,
} from "@scalius/core/modules/fulfilment";
import { recordOrderEvent } from "@scalius/core/modules/orders";
import { enqueueOrderNotificationOutboxById } from "@scalius/core/modules/notifications";
import { ok, created } from "../../../utils/api-response";
import { bumpCacheGeneration } from "../../../utils/cache-generation";
import {
    enqueueOrderNotificationMessage,
    enqueueOrderNotificationsForStatus,
    enqueueOrderStatusChangeNotification,
} from "../../../utils/order-notification-queue";
import { successEnvelope, serviceUnavailableResponse } from "../../../schemas/responses";
import {
    fulfillmentTypeSchema,
    orderFulfilmentLineSchema,
} from "../../../schemas/order-lines";
import { adminOrderResourceMutationErrorResponses } from "./shared";

const app = new OpenAPIHono<{ Bindings: Env }>();

function actorIdOf(c: { get(key: "user"): unknown }): string | null {
    return (c.get("user") as { id?: string } | undefined)?.id ?? null;
}

const requestKeySchema = z.string().uuid().openapi({
    description: "Retry key: repeating the request returns the first result instead of acting twice.",
});

const fulfilmentLinesInputSchema = z.array(z.object({
    itemId: z.string().min(1).max(180),
    quantity: z.number().int().min(1).max(99),
})).min(1).max(99).optional().openapi({
    description: "Which units to hand over; part of a line is fine. Omit for every unit of this kind not handed over yet.",
});

const fulfilmentTrackingInputSchema = z.object({
    courierName: z.string().trim().max(120).optional(),
    trackingId: z.string().trim().max(180).optional(),
    trackingUrl: z.string().trim().url("Enter a full link, starting with https://").optional(),
    note: z.string().trim().max(500).optional(),
    shipmentAmount: z.number().min(0, "The delivery cost can't be negative.").optional(),
}).strict().openapi({ description: "Own-rider parcel details; only for `ship`." });

const createFulfilmentBodySchema = z.object({
    requestKey: requestKeySchema,
    kind: z.enum(MANUAL_FULFILLMENT_TYPES).openapi({
        description: "`ship`: mark as sent with your own rider. `pickup`: the buyer collected it. `service`: the service was performed.",
    }),
    lines: fulfilmentLinesInputSchema,
    tracking: fulfilmentTrackingInputSchema.optional(),
    cashReceived: z.number().min(0).optional().openapi({
        description: "Cash on delivery taken at the counter or the service in the same action (`pickup`/`service`, major units). Must equal the balance due.",
    }),
}).strict();

const fulfilmentResultSchema = z.object({
    orderId: z.string(),
    fulfillmentId: z.string(),
    kind: fulfillmentTypeSchema,
    lines: z.array(orderFulfilmentLineSchema),
    /** The own-rider parcel created for a `ship` fulfilment. */
    shipmentId: z.string().nullable(),
    orderStatus: z.string(),
    fulfillmentStatus: z.string(),
    /** The same request key already recorded this fulfilment. */
    replayed: z.boolean(),
    /**
     * Everything is handed over but money is still due (for example a
     * pickup without cash taken): record the payment or the cash to deliver.
     */
    awaitingPayment: z.boolean(),
});

const createFulfilmentRoute = createRoute({
    operationId: "dashboard.orders.fulfillment_create",
    method: "post",
    path: "/{id}/fulfillments",
    tags: ["Admin - Orders"],
    summary: "Hand over order lines: send with your own rider, picked up at the counter, or service done",
    description: "The only way units are marked handed over. When the last line that blocks delivery is handed over and the money is settled, the order becomes delivered (pickup and service); the last ship line makes it shipped.",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: createFulfilmentBodySchema } } },
    },
    responses: {
        201: {
            description: "Fulfilment recorded",
            content: { "application/json": { schema: successEnvelope(fulfilmentResultSchema) } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(createFulfilmentRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const body = c.req.valid("json");
    const actorId = actorIdOf(c);
    const result = await recordOrderFulfilment(db, orderId, {
        requestKey: body.requestKey,
        kind: body.kind,
        lines: body.lines,
        parcel: body.tracking,
        cashReceived: body.cashReceived,
    }, { type: "admin", id: actorId });
    if (result.availabilityTransitionVariantIds.length > 0) await bumpCacheGeneration(c);
    if (!result.replayed) {
        const quantity = result.lines.reduce((sum, line) => sum + line.quantity, 0);
        await recordOrderEvent(db, {
            orderId,
            kind: result.kind === "ship" ? "shipment_created" : "status_changed",
            actorId,
            requestKey: `fulfilment:${result.fulfillmentId}`,
            data: result.kind === "ship"
                ? {
                    courierName: body.tracking?.courierName ?? null,
                    trackingId: body.tracking?.trackingId ?? null,
                    final: result.isFinalShipment,
                    quantity,
                    items: result.lines.map((line) => ({ itemId: line.orderItemId, quantity: line.quantity })),
                }
                : { fulfilment: result.kind, quantity, to: result.orderStatus },
        });
        const trackingId = body.tracking?.trackingId ?? null;
        if (result.statusChange) {
            await enqueueOrderStatusChangeNotification({
                db,
                queue: c.env.JOBS_QUEUE,
                statusChange: result.statusChange,
                trackingId,
                source: "orders-fulfilment",
            });
        } else if (result.kind === "ship" && result.shipmentId) {
            // An earlier parcel of a split shipment: the buyer hears about
            // each parcel as it leaves, not only the last one (R2-ORD-06).
            await enqueueOrderNotificationsForStatus({
                db,
                queue: c.env.JOBS_QUEUE,
                orderIds: [orderId],
                newStatus: "shipped",
                trackingByOrderId: { [orderId]: trackingId },
                dedupeKeyByOrderId: { [orderId]: `shipment:${result.shipmentId}:order_shipped` },
                source: "orders-fulfilment-parcel",
            });
        }
        const delivered = result.delivered?.notification;
        if (delivered) {
            await enqueueOrderNotificationMessage({
                db,
                queue: c.env.JOBS_QUEUE,
                message: {
                    type: "order.notification",
                    orderId: delivered.orderId,
                    customerEmail: delivered.customerEmail,
                    customerName: delivered.customerName,
                    notificationType: delivered.notificationType,
                },
                dedupeKey: delivered.dedupeKey ?? `order_status:${orderId}:${delivered.notificationType}`,
                source: "orders-fulfilment-delivered",
            });
        }
    }
    return created(c, {
        orderId: result.orderId,
        fulfillmentId: result.fulfillmentId,
        kind: result.kind,
        lines: result.lines,
        shipmentId: result.shipmentId,
        orderStatus: result.orderStatus,
        fulfillmentStatus: result.fulfillmentStatus,
        replayed: result.replayed,
        awaitingPayment: result.awaitingPayment,
    });
});

const voidFulfilmentRoute = createRoute({
    operationId: "dashboard.orders.fulfillment_void",
    method: "post",
    path: "/{id}/fulfillments/{fulfillmentId}/void",
    tags: ["Admin - Orders"],
    summary: "Void an own-rider parcel that came back: its units go back on the unsent list",
    request: {
        params: z.object({ id: z.string(), fulfillmentId: z.string() }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ requestKey: requestKeySchema }).strict() } },
        },
    },
    responses: {
        200: {
            description: "Fulfilment voided",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        orderId: z.string(),
                        fulfillmentId: z.string(),
                        /** Units put back on the unsent list. */
                        quantity: z.number().int(),
                        replayed: z.boolean(),
                    })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(voidFulfilmentRoute, async (c) => {
    const db = c.get("db");
    const { id: orderId, fulfillmentId } = c.req.valid("param");
    const result = await voidOrderFulfilment(db, orderId, fulfillmentId);
    if (!result.replayed) {
        await recordOrderEvent(db, {
            orderId,
            kind: "parcel_returned",
            actorId: actorIdOf(c),
            requestKey: `void:${fulfillmentId}`,
            data: { quantity: result.quantity },
        });
    }
    return ok(c, result);
});

const pickupReadyRoute = createRoute({
    operationId: "dashboard.orders.pickup_ready",
    method: "post",
    path: "/{id}/pickup-ready",
    tags: ["Admin - Orders"],
    summary: "Mark a pickup order ready to collect and tell the buyer",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            required: true,
            content: { "application/json": { schema: z.object({ requestKey: requestKeySchema }).strict() } },
        },
    },
    responses: {
        200: {
            description: "Order marked ready for pickup",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        orderId: z.string(),
                        pickupReadyAt: z.string(),
                        replayed: z.boolean(),
                    })),
                },
            },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(pickupReadyRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const result = await markOrderReadyForPickup(db, orderId);
    if (!result.replayed) {
        await recordOrderEvent(db, {
            orderId,
            kind: "status_changed",
            actorId: actorIdOf(c),
            requestKey: `pickup-ready:${orderId}`,
            data: { pickupReady: true },
        });
    }
    if (result.notificationOutboxId && c.env.JOBS_QUEUE) {
        // The row committed with the mark; a failed send is retried by the
        // outbox sweep.
        await enqueueOrderNotificationOutboxById({
            db,
            queue: c.env.JOBS_QUEUE,
            outboxId: result.notificationOutboxId,
        }).catch((error: unknown) => {
            console.error("[orders] pickup-ready notification enqueue failed:", error instanceof Error ? error.message : "unknown");
        });
    }
    return ok(c, {
        orderId: result.orderId,
        pickupReadyAt: result.pickupReadyAt,
        replayed: result.replayed,
    });
});

export { app as adminOrderFulfilmentRoutes };
