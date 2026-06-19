import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import * as OrdersService from "@scalius/core/modules/orders";
import type { OrderNotificationType } from "@scalius/core/modules/notifications";
import { getShipments, getDeliveryProvider, getShipment, deleteShipmentRecord, checkShipmentStatus, getLatestShipment } from "@scalius/core/modules/delivery/delivery.service";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { deliveryShipments, codTracking, orders } from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { validateTransition } from "@scalius/core/modules/orders/order-state-machine";
import { assertNoActiveShipmentClaim } from "@scalius/core/modules/orders/shipment-claim";
import { NotFoundError, ForbiddenError, ValidationError } from "../../utils/api-error";
import { ok, created } from "../../utils/api-response";
import { getEncryptionKey } from "../../utils/encryption-key";
import { successEnvelope, messageResponse, errorResponses } from "../../schemas/responses";
import { deliveryShipmentSchema } from "../../schemas/entities";
import { nullableTimestampSchema } from "../../schemas/timestamps";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import {
    enqueueOrderNotificationMessage,
    enqueueOrderNotificationsForStatus,
    enqueueOrderStatusChangeNotification,
} from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ─── Inline response schemas ────────────────────────────────────────────────

const codTrackingSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    deliveryAttempts: z.number(),
    lastAttemptAt: z.union([z.string(), z.number()]).nullable(),
    codStatus: z.string(),
    failureReason: z.string().nullable(),
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

const fulfillmentResultSchema = successEnvelope(z.object({
    shipmentId: z.string(),
    isFinalShipment: z.boolean(),
    fulfillmentStatus: z.string(),
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

// ─── PUT /:id/status ─────────────────────────────────────────────────────────

const updateStatusRoute = createRoute({
    method: "put",
    path: "/{id}/status",
    tags: ["Admin - Orders"],
    summary: "Update order status",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: z.object({ status: z.string() }) } } }
    },
    responses: {
        200: {
            description: "Status updated",
            content: { "application/json": { schema: messageResponse } },
        },
    }
});

app.openapi(updateStatusRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.updateOrderStatus(db, orderId, data.status);
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);

    if (result.notification) {
        await enqueueOrderNotificationMessage({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            message: {
                type: "order.notification",
                orderId: result.notification.orderId,
                customerEmail: result.notification.customerEmail,
                customerName: result.notification.customerName,
                notificationType: result.notification.notificationType,
                data: data.status === "shipped" && result.notification.trackingId
                    ? { trackingId: result.notification.trackingId }
                    : undefined,
            },
            dedupeKey: result.notification.dedupeKey ?? `order_status:${orderId}:${result.notification.notificationType}`,
            source: "orders-status-update",
        });
    }

    return ok(c, { message: result.message });
});

// ─── GET /:id/cod ────────────────────────────────────────────────────────────

const getCodRoute = createRoute({
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
    const tracking = await c.get("db").select().from(codTracking).where(eq(codTracking.orderId, orderId)).get();
    return ok(c, { tracking: tracking ?? null });
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
    }
});

app.openapi(postCodRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.processCodAction(db, orderId, data);
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);

    // Enqueue notification for COD status changes that affect order status
    const COD_NOTIFICATION_MAP: Partial<Record<typeof data.action, OrderNotificationType>> = {
        collected: "order_delivered",
        returned: "order_returned",
    };
    const notifType = COD_NOTIFICATION_MAP[data.action];
    if (notifType) {
        const order = await db.select({
            customerEmail: orders.customerEmail,
            customerName: orders.customerName,
            status: orders.status,
            version: orders.version,
        }).from(orders).where(eq(orders.id, orderId)).get();

        if (order) {
            await enqueueOrderNotificationMessage({
                db,
                queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
                message: {
                    type: "order.notification",
                    orderId,
                    customerEmail: order.customerEmail ?? undefined,
                    customerName: order.customerName,
                    notificationType: notifType,
                },
                dedupeKey: `cod:${orderId}:${data.action}:v${order.version}:${order.status}`,
                source: "orders-cod-action",
            });
        }
    }

    return ok(c, result);
});

// ─── GET /:id/fulfill ────────────────────────────────────────────────────────

const getFulfillRoute = createRoute({
    method: "get",
    path: "/{id}/fulfill",
    tags: ["Admin - Orders"],
    summary: "Get fulfillment shipments for an order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order shipments",
            content: { "application/json": { schema: successEnvelope(z.object({ shipments: z.array(deliveryShipmentSchema) })) } },
        },
    }
});

app.openapi(getFulfillRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const shipments = await OrdersService.getOrderShipments(db, orderId);
    return ok(c, { shipments });
});

// ─── POST /:id/fulfill ──────────────────────────────────────────────────────

const fulfillSchema = z.object({
    itemIds: z.array(z.string()).optional(),
    trackingId: z.string().optional(),
    trackingUrl: z.string().optional(),
    courierName: z.string().optional(),
    note: z.string().optional(),
    isFinalShipment: z.boolean().optional(),
    shipmentAmount: z.number().optional()
});

const postFulfillRoute = createRoute({
    method: "post",
    path: "/{id}/fulfill",
    tags: ["Admin - Orders"],
    summary: "Create a fulfillment shipment",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: fulfillSchema } } }
    },
    responses: {
        201: {
            description: "Fulfillment created",
            content: { "application/json": { schema: fulfillmentResultSchema } },
        },
    }
});

app.openapi(postFulfillRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.createFulfillmentShipment(db, orderId, data);
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
    return created(c, result);
});

// ─── PUT /:id/fulfillment-status ─────────────────────────────────────────────

const updateFulfillmentStatusRoute = createRoute({
    method: "put",
    path: "/{id}/fulfillment-status",
    tags: ["Admin - Orders"],
    summary: "Manually update order fulfillment status",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: z.object({ status: z.enum(["pending", "partial", "complete"]) }) } } }
    },
    responses: {
        200: {
            description: "Fulfillment status updated",
            content: { "application/json": { schema: messageResponse } },
        },
    }
});

app.openapi(updateFulfillmentStatusRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const { status } = c.req.valid("json");

    const order = await db.select({
        fulfillmentStatus: orders.fulfillmentStatus,
        shipmentClaimId: orders.shipmentClaimId,
        shipmentClaimExpiresAt: orders.shipmentClaimExpiresAt,
    }).from(orders).where(eq(orders.id, orderId)).get();
    if (!order) throw new NotFoundError("Order not found");
    assertNoActiveShipmentClaim(order);

    if (order.fulfillmentStatus !== status) {
        validateTransition("fulfillment", order.fulfillmentStatus, status);
        await db.update(orders).set({ fulfillmentStatus: status, updatedAt: sql`unixepoch()` }).where(eq(orders.id, orderId));
    }

    return ok(c, { message: "Fulfillment status updated" });
});

// ─── GET /:id/shipments ──────────────────────────────────────────────────────

const getShipmentsRoute = createRoute({
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

    const enhancedShipments = await Promise.all(
        shipments.map(async (shipment) => {
            const provider = shipment.providerId ? await getDeliveryProvider(db, shipment.providerId) : null;
            return {
                ...shipment,
                providerName: provider?.name || shipment.providerType,
                lastChecked: shipment.lastChecked || shipment.updatedAt
            };
        })
    );

    return ok(c, enhancedShipments);
});

// ─── POST /:id/shipments ─────────────────────────────────────────────────────

const createShipmentBodySchema = z.object({
    providerId: z.string(),
    options: z.record(z.string(), z.string()).optional().openapi({ description: "Provider-specific options" })
});

const createShipmentRoute = createRoute({
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
        400: errorResponses[400],
    }
});

app.openapi(createShipmentRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");

    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    const [shipmentResult] = await OrdersService.bulkShipOrders(
        db,
        [orderId],
        data.providerId,
        data.options ?? {},
        encryptionKey,
    );

    if (!shipmentResult?.success) {
        const errorMessage = typeof shipmentResult?.error === "string"
            ? shipmentResult.error
            : "Failed to create shipment";
        console.error(`Failed to create shipment for order ${orderId}: ${errorMessage}`);
        throw new ValidationError(errorMessage);
    }
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);

    const provider = await getDeliveryProvider(db, data.providerId);
    const createdShipmentRecord = await getLatestShipment(db, orderId);

    if (!createdShipmentRecord) {
        throw new NotFoundError("Failed to retrieve created shipment");
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, createdShipmentRecord.id));

    if (shipmentResult.shipment) {
        await enqueueOrderNotificationsForStatus({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            orderIds: [orderId],
            newStatus: "shipped",
        trackingByOrderId: createdShipmentRecord.trackingId
            ? { [orderId]: createdShipmentRecord.trackingId }
            : undefined,
        dedupeKeyByOrderId: { [orderId]: `shipment:${createdShipmentRecord.id}:order_shipped` },
        source: "orders-shipment-create",
    });
    }

    const enhancedShipment = {
        ...createdShipmentRecord,
        providerName: provider?.name || createdShipmentRecord.providerType,
        lastChecked: now.toISOString()
    };

    return created(c, enhancedShipment);
});

// ─── GET /:id/shipments/:shipmentId ──────────────────────────────────────────

const getShipmentRoute = createRoute({
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
        404: errorResponses[404],
    }
});

app.openapi(deleteShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ForbiddenError("Shipment does not belong to this order");

    await deleteShipmentRecord(db, shipmentId);
    return ok(c, {});
});

// ─── POST /:id/shipments/{shipmentId}/status ──────────────────────────────────

const checkShipmentStatusRoute = createRoute({
    method: "post",
    path: "/{id}/shipments/{shipmentId}/status",
    tags: ["Admin - Orders"],
    summary: "Check shipment status from provider",
    request: {
        params: z.object({ id: z.string(), shipmentId: z.string() }),
    },
    responses: {
        200: {
            description: "Status checked",
            content: { "application/json": { schema: successEnvelope(deliveryShipmentSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(checkShipmentStatusRoute, (async (c: AdminRouteContext<typeof checkShipmentStatusRoute>) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ForbiddenError("Shipment does not belong to this order");

    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    const updatedShipment = await checkShipmentStatus(db, shipmentId, encryptionKey);
    return ok(c, updatedShipment);
}) as unknown as AdminRouteHandler<typeof checkShipmentStatusRoute>);

// ─── POST /:id/shipments/{shipmentId}/refresh ─────────────────────────────────

const refreshShipmentRoute = createRoute({
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
        400: errorResponses[400],
        404: errorResponses[404],
    }
});

app.openapi(refreshShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ValidationError("Shipment does not belong to this order");

    const previousStatus = shipment.status;
    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    try {
        await checkShipmentStatus(db, shipmentId, encryptionKey);
    } catch (e: unknown) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, shipmentId));

    const updatedShipment = await getShipment(db, shipmentId);
    if (!updatedShipment) throw new NotFoundError("Failed to retrieve updated shipment");

    const provider = updatedShipment.providerId ? await getDeliveryProvider(db, updatedShipment.providerId) : null;
    const statusChanged = previousStatus !== updatedShipment.status;
    let orderStatusUpdate = false;

    try {
        const orderUpdate = await updateOrderStatusFromShipment(db, shipmentId, updatedShipment.status);
        await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
        await enqueueOrderStatusChangeNotification({
            db,
            queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
            statusChange: orderUpdate,
            trackingId: updatedShipment.trackingId,
            source: "orders-shipment-refresh",
        });
        orderStatusUpdate = !!orderUpdate && !!orderUpdate.orderId;
    } catch (e: unknown) {
        console.error("Error updating order status:", e);
    }

    return ok(c, {
        ...updatedShipment,
        providerName: provider?.name || updatedShipment.providerType,
        providerType: updatedShipment.providerType,
        lastChecked: now.toISOString(),
        statusChanged,
        orderStatusUpdate
    });
});

export { app as adminOrdersStatusRoutes };
