import { createRoute, z } from "@hono/zod-openapi";
import { adminRouter } from "./admin-router";
import type { Context } from "hono";
import {
    assertShipmentDeletable,
    bulkShipOrders,
    lookupUnknownOrderShipment,
    markOrderDelivered,
    processCodAction,
    reconcileOrderShipment,
    resolveUnknownOrderShipment,
} from "@scalius/core/modules/fulfilment";
import {
    keepOwedRefund,
    recordOrderEvent,
    updateOrderStatus,
    shipmentCreationOptionsSchema,
    unknownShipmentResolutionSchema,
} from "@scalius/core/modules/orders";
import {
    getShipments,
    getDeliveryProvider,
    getShipment,
    deleteShipmentRecord,
    getLatestShipment,
} from "@scalius/core/modules/delivery";
import { deliveryShipments, codTracking, orders } from "@scalius/database/schema";
import { eq } from "drizzle-orm";
import { fromMinor } from "@scalius/shared/money";
import { NotFoundError, ForbiddenError, ValidationError } from "../../utils/api-error";
import { ok, created } from "../../utils/api-response";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, errorResponses, conflictResponse, serviceUnavailableResponse } from "../../schemas/responses";
import { orderResourceSchema, readOrderResource } from "./order-resource";
import { deliveryShipmentSchema } from "../../schemas/entities";
import { nullableTimestampSchema } from "../../schemas/timestamps";

import { autoFulfilAfterResponse } from "../../background/auto-fulfil";
import { sendOrderNotificationsForStatus } from "../../utils/order-notifications";
import { checkAndSyncShipmentStatus } from "./shipment-status-sync";
import { requestCourierProviders } from "../../plugins/providers/courier";
import { ORDER_STATUSES } from "@scalius/shared/order-state";
import { notificationSender } from "../../background/notification-sender";
import { requestStaffId } from "./request-actor";
import { principalBodyKey } from "./idempotency-key";

const app = adminRouter();

// ─── Inline response schemas ────────────────────────────────────────────────

const codTrackingSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    deliveryAttempts: z.number(),
    lastAttemptAt: z.union([z.string(), z.number()]).nullable(),
    codStatus: z.string(),
    failureReason: z.string().nullable(),
    failureNote: z.string().nullable(),
    collectedBy: z.string().nullable(),
    collectedAmount: z.number().nullable(),
    collectedAt: z.union([z.string(), z.number()]).nullable(),
    receiptUrl: z.string().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).nullable();

const codActionResponseSchema = successEnvelope(z.object({
    message: z.string(),
}));

const enhancedShipmentSchema = deliveryShipmentSchema.extend({
    providerName: z.string().nullable(),
    lastChecked: nullableTimestampSchema,
}).passthrough();

const refreshedShipmentSchema = deliveryShipmentSchema.extend({
    providerName: z.string().nullable(),
    providerType: z.string().nullable(),
    lastChecked: z.string(),
    statusChanged: z.boolean(),
    orderStatusUpdate: z.boolean(),
}).passthrough();

const reconcileShipmentResponseSchema = successEnvelope(z.object({
    status: z.literal("repaired"),
    orderId: z.string(),
    shipmentId: z.string(),
    orderStatus: z.string(),
    shipmentStatus: z.string(),
    orderStatusChanged: z.boolean(),
    inventoryReconciled: z.boolean(),
    claimCleared: z.boolean(),
    trackingId: z.string().nullable(),
    message: z.string(),
}));

const unknownShipmentResolutionResponseSchema = successEnvelope(z.discriminatedUnion("status", [
    z.object({
        status: z.literal("repaired"),
        resolution: z.enum(["provider_confirmed_existing", "merchant_confirmed_existing"]),
        orderId: z.string(),
        shipmentId: z.string(),
        orderStatus: z.string(),
        shipmentStatus: z.string(),
        orderStatusChanged: z.boolean(),
        inventoryReconciled: z.boolean(),
        claimCleared: z.boolean(),
        trackingId: z.string().nullable(),
        message: z.string(),
    }),
    z.object({
        status: z.literal("released"),
        resolution: z.enum(["merchant_confirmed_not_created", "merchant_confirmed_cancelled"]),
        orderId: z.string(),
        shipmentId: z.string(),
        claimCleared: z.literal(true),
        orderVersion: z.number().int().min(1),
        message: z.string(),
    }),
]));

const RECONCILE_NOTIFICATION_STATUSES = new Set(["shipped", "delivered", "returned", "cancelled"]);

const adminMutationErrorResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
    409: conflictResponse,
} as const;

const adminProviderMutationErrorResponses = {
    ...adminMutationErrorResponses,
    503: serviceUnavailableResponse,
} as const;

const adminShipmentCreateErrorResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
    404: errorResponses[404],
} as const;

// ─── PUT /:id/status ─────────────────────────────────────────────────────────

const updateStatusRoute = createRoute({
    operationId: "dashboard.orders.update_status",
    method: "put",
    path: "/{id}/status",
    tags: ["Admin - Orders"],
    summary: "Update order status",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        status: z.enum(ORDER_STATUSES),
                        /** Why an order is cancelled; recorded on the timeline. */
                        reason: z.enum(["customer_changed_mind", "unreachable", "fake_order", "out_of_stock", "other"]).optional(),
                        notifyCustomer: z.boolean().optional().openapi({
                            description: "False sends the customer no message about this change (a test or duplicate order). Default true.",
                        }),
                        expectedRevision: z.number().int().min(1).optional().openapi({
                            description: "The order `revision` you read. A change since is refused with 409 and nothing changes. Omit to change it whatever happened since.",
                        }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "The order after the change",
            content: { "application/json": { schema: successEnvelope(orderResourceSchema) } },
        },
        ...adminMutationErrorResponses,
    }
});

function actorIdOf(c: Parameters<typeof requestStaffId>[0]): string | null {
    return requestStaffId(c);
}

/** Hands the message rows a command committed with its change to the sender (the drain sends any it misses). */
async function sendCommittedNotifications(c: Parameters<typeof notificationSender>[0], outboxIds: readonly string[] | undefined) {
    if (outboxIds && outboxIds.length > 0) await notificationSender(c)(outboxIds);
}

app.openapi(updateStatusRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    // The change, its timeline line and its customer message commit together.
    const result = await updateOrderStatus(db, orderId, data.status, { expectedVersion: data.expectedRevision }, {
        event: {
            actorId: actorIdOf(c),
            ...(data.status === "cancelled" && data.reason ? { data: { reason: data.reason } } : {}),
        },
        ...(data.notifyCustomer !== false ? { notify: { source: "orders-status-update" } } : {}),
    });
    await sendCommittedNotifications(c, result.outboxIds);

    return ok(c, { order: await readOrderResource(db, orderId) });
});

// ─── POST /:id/refund-kept ───────────────────────────────────────────────────

const keepOwedRefundRoute = createRoute({
    operationId: "dashboard.orders.refund_owed_keep",
    method: "post",
    path: "/{id}/refund-kept",
    tags: ["Admin - Orders"],
    summary: "Keep the refund owed on an order (a restocking fee)",
    description: "A return refunded only in part: the rest of the received items' value is kept, recorded on the timeline (`refund_kept`), and the order stops showing a refund owed. Refused when nothing is owed.",
    request: {
        params: z.object({ id: z.string() }),
        body: { required: true, content: { "application/json": { schema: z.object({}).strict() } } },
    },
    responses: {
        200: {
            description: "What was kept",
            content: { "application/json": { schema: successEnvelope(z.object({ keptMinor: z.number().int().min(0), replayed: z.boolean() })) } },
        },
        ...adminMutationErrorResponses,
    },
});

app.openapi(keepOwedRefundRoute, async (c) => {
    const result = await keepOwedRefund(c.get("db"), c.req.valid("param").id, actorIdOf(c));
    return ok(c, result);
});

// ─── POST /:id/mark-delivered ────────────────────────────────────────────────

const markDeliveredRoute = createRoute({
    operationId: "dashboard.orders.mark_delivered",
    method: "post",
    path: "/{id}/mark-delivered",
    tags: ["Admin - Orders"],
    summary: "Mark an order your own rider delivered in full as delivered",
    description: "Refused while anything is unsent. A paid order, an invoice, or a cash on delivery order whose cash is remitted later: the order stays unpaid until the cash is recorded (POST /{id}/cod, `collected`), which is also allowed on a delivered order.",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            required: true,
            content: {
                "application/json": {
                    schema: z.object({
                        expectedRevision: z.number().int().min(1).optional().openapi({
                            description: "The order `revision` you read; a change since is refused with 409. Omit to mark it whatever happened since.",
                        }),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "The delivered order",
            content: { "application/json": { schema: successEnvelope(orderResourceSchema) } },
        },
        ...adminMutationErrorResponses,
    },
});

app.openapi(markDeliveredRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const result = await markOrderDelivered(db, orderId, { expectedVersion: c.req.valid("json").expectedRevision }, {
        event: { actorId: actorIdOf(c) },
        notify: { source: "orders-mark-delivered" },
    });
    await sendCommittedNotifications(c, result.outboxIds);

    return ok(c, { order: await readOrderResource(db, orderId) });
});

// ─── GET /:id/cod ────────────────────────────────────────────────────────────

const getCodRoute = createRoute({
    operationId: "dashboard.orders.cod_get",
    method: "get",
    path: "/{id}/cod",
    tags: ["Admin - Orders"],
    summary: "Get COD tracking for an order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "COD tracking info",
            content: { "application/json": { schema: successEnvelope(z.object({ tracking: codTrackingSchema })) } },
        },
    }
});

app.openapi(getCodRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const row = await c.get("db").select({
        tracking: codTracking,
        currencyDecimalPlaces: orders.currencyDecimalPlaces,
    }).from(codTracking)
        .innerJoin(orders, eq(orders.id, codTracking.orderId))
        .where(eq(codTracking.orderId, orderId))
        .get();
    if (!row) return ok(c, { tracking: null });
    const { collectedAmountMinor, ...tracking } = row.tracking;
    return ok(c, {
        tracking: {
            ...tracking,
            collectedAmount: collectedAmountMinor === null ? null : fromMinor(collectedAmountMinor, row.currencyDecimalPlaces),
        },
    });
});

// ─── POST /:id/cod ───────────────────────────────────────────────────────────

const codActionSchema = z.discriminatedUnion("action", [
    z.object({
        action: z.literal("collected"),
        collectedBy: z.string().trim().min(1, "Collector name is required"),
        collectedAmount: z.number().finite().positive("Collected amount must be greater than zero"),
        receiptUrl: z.string().trim().optional(),
    }),
    z.object({
        action: z.literal("failed"),
        reason: z.enum(["not_home", "refused", "no_cash", "wrong_address", "other"]),
        notes: z.string().trim().optional(),
    }),
    z.object({
        action: z.literal("returned"),
    }),
]);

const postCodRoute = createRoute({
    operationId: "dashboard.orders.cod_update",
    method: "post",
    path: "/{id}/cod",
    tags: ["Admin - Orders"],
    summary: "Process COD action",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: codActionSchema } } }
    },
    responses: {
        200: {
            description: "COD action processed",
            content: { "application/json": { schema: codActionResponseSchema } },
        },
        ...adminMutationErrorResponses,
    }
});

app.openapi(postCodRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    // Collected and returned write their timeline line and customer message
    // in the same batch as the cash or the status they announce.
    const result = await processCodAction(db, orderId, data, { actorId: actorIdOf(c) });
    const { availabilityTransitionVariantIds: _availabilityTransitionVariantIds, outboxIds, ...responseData } = result;

    // Collected cash settles the order: hand over its automatic lines.
    if (data.action === "collected") await autoFulfilAfterResponse(c, db, orderId, "orders-cod-action");
    if (data.action === "failed") {
        await recordOrderEvent(db, { orderId, kind: "cod_failed", actorId: actorIdOf(c), body: data.notes || null, data: { reason: data.reason } });
    }
    await sendCommittedNotifications(c, outboxIds);

    return ok(c, responseData);
});

// ─── GET /:id/shipments ──────────────────────────────────────────────────────

const getShipmentsRoute = createRoute({
    operationId: "dashboard.orders.shipments",
    method: "get",
    path: "/{id}/shipments",
    tags: ["Admin - Orders"],
    summary: "Get order shipments",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order shipments",
            content: { "application/json": { schema: successEnvelope(z.array(enhancedShipmentSchema)) } },
        },
    }
});

app.openapi(getShipmentsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");
    const shipments = await getShipments(db, orderId);

    const enhancedShipments = shipments.map((shipment) => ({
        ...shipment,
        providerName: shipment.providerName || shipment.providerType,
        lastChecked: shipment.lastChecked || shipment.updatedAt
    }));

    return ok(c, enhancedShipments);
});

// ─── POST /:id/shipments ─────────────────────────────────────────────────────

export const createShipmentBodySchema = z.object({
    providerId: z.string().trim().min(1).max(180),
    options: shipmentCreationOptionsSchema.optional(),
}).strict();

const createShipmentRoute = createRoute({
    operationId: "dashboard.orders.create_shipment",
    method: "post",
    path: "/{id}/shipments",
    tags: ["Admin - Orders"],
    summary: "Create a shipment for an order",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: createShipmentBodySchema } } }
    },
    responses: {
        201: {
            description: "Shipment created",
            content: { "application/json": { schema: successEnvelope(enhancedShipmentSchema) } },
        },
        ...adminShipmentCreateErrorResponses,
    }
});

app.openapi(createShipmentRoute, async (c) => {
    const { shipment, providerName, lastChecked } = await bookOrderShipment(c, c.req.valid("param").id, c.req.valid("json"));
    return created(c, {
        ...shipment,
        providerName: providerName || shipment.providerType,
        lastChecked: lastChecked.toISOString(),
    });
});

/**
 * Books a courier for an order and records its effects (timeline, the
 * buyer's shipped notification). Shared by `dashboard.orders.create_shipment`
 * and `dashboard.resources.shipments.create`.
 */
export async function bookOrderShipment(
    c: Context<{ Bindings: Env }>,
    orderId: string,
    data: z.infer<typeof createShipmentBodySchema>,
) {
    const db = c.get("db");

    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const [shipmentResult] = await bulkShipOrders(
        db,
        [orderId],
        data.providerId,
        data.options ?? {},
        encryptionKey,
        requestCourierProviders(c),
    );

    if (!shipmentResult?.success) {
        const errorMessage = typeof shipmentResult?.error === "string"
            ? shipmentResult.error
            : "Failed to create shipment";
        console.error(`Failed to create shipment for order ${orderId}: ${errorMessage}`);
        throw new ValidationError(errorMessage);
    }

    const provider = await getDeliveryProvider(db, data.providerId);
    const createdShipmentRecord = await getLatestShipment(db, orderId);

    if (!createdShipmentRecord) {
        throw new NotFoundError("Failed to retrieve created shipment");
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, createdShipmentRecord.id));

    await recordOrderEvent(db, {
        orderId,
        kind: "shipment_created",
        actorId: actorIdOf(c),
        data: { courierName: provider?.name ?? null, trackingId: createdShipmentRecord.trackingId ?? null, final: true },
    });

    if (shipmentResult.shipment) {
        await sendOrderNotificationsForStatus({
            db,
            send: notificationSender(c),
            orderIds: [orderId],
            newStatus: "shipped",
        trackingByOrderId: createdShipmentRecord.trackingId
            ? { [orderId]: createdShipmentRecord.trackingId }
            : undefined,
        dedupeKeyByOrderId: { [orderId]: `shipment:${createdShipmentRecord.id}:order_shipped` },
        source: "orders-shipment-create",
    });
    }

    return { shipment: createdShipmentRecord, providerName: provider?.name ?? null, lastChecked: now };
}

// ─── GET /:id/shipments/:shipmentId ──────────────────────────────────────────

const getShipmentRoute = createRoute({
    operationId: "dashboard.orders.shipment_get",
    method: "get",
    path: "/{id}/shipments/{shipmentId}",
    tags: ["Admin - Orders"],
    summary: "Get a specific shipment",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment details",
            content: { "application/json": { schema: successEnvelope(deliveryShipmentSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(getShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ForbiddenError("Shipment does not belong to this order");

    return ok(c, shipment);
});

// ─── DELETE /:id/shipments/:shipmentId ───────────────────────────────────────

const deleteShipmentRoute = createRoute({
    operationId: "dashboard.orders.shipment_delete",
    method: "delete",
    path: "/{id}/shipments/{shipmentId}",
    tags: ["Admin - Orders"],
    summary: "Delete a shipment",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment deleted",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        ...adminMutationErrorResponses,
    }
});

app.openapi(deleteShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ForbiddenError("Shipment does not belong to this order");

    await assertShipmentDeletable(db, shipmentId);
    await deleteShipmentRecord(db, shipmentId);
    return ok(c, {});
});

// ─── POST /:id/shipments/{shipmentId}/refresh ─────────────────────────────────

const refreshShipmentRoute = createRoute({
    operationId: "dashboard.orders.shipment_refresh",
    method: "post",
    path: "/{id}/shipments/{shipmentId}/refresh",
    tags: ["Admin - Orders"],
    summary: "Refresh shipment status and update order",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment refreshed",
            content: { "application/json": { schema: successEnvelope(refreshedShipmentSchema) } },
        },
        ...adminProviderMutationErrorResponses,
    }
});

app.openapi(refreshShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ValidationError("Shipment does not belong to this order");

    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const result = await checkAndSyncShipmentStatus({
        db,
        shipment,
        encryptionKey,
        couriers: requestCourierProviders(c),
        c,
        source: "orders-shipment-refresh",
    });

    return ok(c, result.payload);
});

// ─── POST /:id/shipments/{shipmentId}/reconcile ─────────────────────────────

const reconcileShipmentRoute = createRoute({
    operationId: "dashboard.orders.shipment_reconcile",
    method: "post",
    path: "/{id}/shipments/{shipmentId}/reconcile",
    tags: ["Admin - Orders"],
    summary: "Repair a shipment reconciliation lock",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
    },
    responses: {
        200: {
            description: "Shipment reconciliation repaired",
            content: { "application/json": { schema: reconcileShipmentResponseSchema } },
        },
        ...adminProviderMutationErrorResponses,
    },
});

app.openapi(reconcileShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const result = await reconcileOrderShipment(db, orderId, shipmentId);
    const { availabilityTransitionVariantIds: _availabilityTransitionVariantIds, ...responseData } = result;

    if (RECONCILE_NOTIFICATION_STATUSES.has(result.orderStatus)) {
        await sendOrderNotificationsForStatus({
            db,
            send: notificationSender(c),
            orderIds: [orderId],
            newStatus: result.orderStatus,
            trackingByOrderId: result.orderStatus === "shipped" && result.trackingId
                ? { [orderId]: result.trackingId }
                : undefined,
            dedupeKeyByOrderId: { [orderId]: `shipment:${shipmentId}:order_${result.orderStatus}` },
            source: "orders-shipment-reconcile",
        });
    }

    return ok(c, responseData);
});

const unknownShipmentLookupRoute = createRoute({
    operationId: "dashboard.orders.shipment_unknown_lookup",
    method: "post",
    path: "/{id}/shipments/{shipmentId}/resolve-unknown/lookup",
    tags: ["Admin - Orders"],
    summary: "Resolve an unknown shipment through a positive provider lookup",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        expectedOrderVersion: z.number().int().min(1),
                        operationKey: z.string().uuid(),
                    }).strict(),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Unknown shipment resolved from provider confirmation",
            content: { "application/json": { schema: unknownShipmentResolutionResponseSchema } },
        },
        ...adminProviderMutationErrorResponses,
    },
});

app.openapi(unknownShipmentLookupRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const data = c.req.valid("json");
    const actingStaffId = requestStaffId(c);
    const db = c.get("db");
    const result = await lookupUnknownOrderShipment(db, {
        ...data,
        operationKey: await principalBodyKey(c, "dashboard.orders.shipment_unknown_lookup", data.operationKey),
        orderId,
        shipmentId,
        actorId: actingStaffId,
        encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        couriers: requestCourierProviders(c),
    });
    const { availabilityTransitionVariantIds: _availabilityTransitionVariantIds, ...responseData } = result;

    if (result.status === "repaired" && RECONCILE_NOTIFICATION_STATUSES.has(result.orderStatus)) {
        await sendOrderNotificationsForStatus({
            db,
            send: notificationSender(c),
            orderIds: [orderId],
            newStatus: result.orderStatus,
            trackingByOrderId: result.orderStatus === "shipped" && result.trackingId
                ? { [orderId]: result.trackingId }
                : undefined,
            dedupeKeyByOrderId: { [orderId]: `shipment:${shipmentId}:order_${result.orderStatus}` },
            source: "orders-shipment-unknown-lookup",
        });
    }
    return ok(c, responseData);
});

const resolveUnknownShipmentRoute = createRoute({
    operationId: "dashboard.orders.shipment_unknown_resolve",
    method: "post",
    path: "/{id}/shipments/{shipmentId}/resolve-unknown",
    tags: ["Admin - Orders"],
    summary: "Resolve an unknown shipment from accountable courier confirmation",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
        body: { content: { "application/json": { schema: unknownShipmentResolutionSchema } } },
    },
    responses: {
        200: {
            description: "Unknown shipment resolution recorded",
            content: { "application/json": { schema: unknownShipmentResolutionResponseSchema } },
        },
        ...adminProviderMutationErrorResponses,
    },
});

app.openapi(resolveUnknownShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const data = c.req.valid("json");
    const actingStaffId = requestStaffId(c);
    const db = c.get("db");
    const result = await resolveUnknownOrderShipment(db, {
        ...data,
        orderId,
        shipmentId,
        actorId: actingStaffId,
        encryptionKey: getCredentialEncryptionKey(c.env as Record<string, unknown>),
        couriers: requestCourierProviders(c),
    });
    if (result.status === "released") return ok(c, result);

    const { availabilityTransitionVariantIds: _availabilityTransitionVariantIds, ...responseData } = result;

    if (RECONCILE_NOTIFICATION_STATUSES.has(result.orderStatus)) {
        await sendOrderNotificationsForStatus({
            db,
            send: notificationSender(c),
            orderIds: [orderId],
            newStatus: result.orderStatus,
            trackingByOrderId: result.orderStatus === "shipped" && result.trackingId
                ? { [orderId]: result.trackingId }
                : undefined,
            dedupeKeyByOrderId: { [orderId]: `shipment:${shipmentId}:order_${result.orderStatus}` },
            source: "orders-shipment-unknown-resolution",
        });
    }
    return ok(c, responseData);
});

export { app as adminOrdersStatusRoutes };
