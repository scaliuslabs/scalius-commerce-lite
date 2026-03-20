import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as OrdersService from "@scalius/core/modules/orders";
import {
    createOrderSchema,
    updateOrderSchema,
    bulkDeleteOrderSchema,
    bulkShipOrderSchema
} from "@scalius/core/modules/orders/orders.validation";
import { processReturn, processRefund } from "@scalius/core/modules/payments/refund-service";
import { getShipments, getDeliveryProvider, getShipment, deleteShipmentRecord, checkShipmentStatus, createShipment, getLatestShipment } from "@scalius/core/modules/delivery/delivery.service";
import { updateOrderStatusFromShipment } from "@scalius/core/modules/delivery/tracking";
import { orderPayments, paymentPlans, deliveryShipments, orderItems, products, productVariants, productImages, orders } from "@scalius/database/schema";
import { eq, and, isNull } from "drizzle-orm";
import { NotFoundError, ForbiddenError, ValidationError } from "../../utils/api-error";

import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, paginatedEnvelope, messageResponse, idResponse, noContentResponse, errorResponses } from "../../schemas/responses";
import { orderSummarySchema, orderDetailSchema, orderItemSchema, deliveryShipmentSchema, productVariantSchema } from "../../schemas/entities";

const app = new OpenAPIHono<{ Bindings: Env }>();

// ─── Inline response schemas (route-specific, not reusable enough for entities) ──

const bulkShipResultItemSchema = z.object({
    orderId: z.string(),
    success: z.boolean(),
    shipment: z.any().optional(),
    error: z.string().optional(),
}).passthrough();

const bulkShipResponseSchema = successEnvelope(z.object({
    totalProcessed: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
    results: z.array(bulkShipResultItemSchema),
}));

const codTrackingSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    status: z.string(),
    collectedBy: z.string().nullable(),
    collectedAmount: z.number().nullable(),
    receiptUrl: z.string().nullable(),
    reason: z.string().nullable(),
    notes: z.string().nullable(),
    createdAt: z.any(),
    updatedAt: z.any(),
}).passthrough().nullable();

const codActionResponseSchema = successEnvelope(z.object({
    success: z.boolean(),
    message: z.string(),
}));

const fulfillmentResultSchema = successEnvelope(z.object({
    success: z.boolean(),
    shipmentId: z.string(),
    isFinalShipment: z.boolean(),
    fulfillmentStatus: z.string(),
}));

const enhancedShipmentSchema = deliveryShipmentSchema.extend({
    providerName: z.string().nullable(),
    lastChecked: z.string().or(z.date()).nullable(),
}).passthrough();

const refreshedShipmentSchema = deliveryShipmentSchema.extend({
    providerName: z.string().nullable(),
    providerType: z.string().nullable(),
    lastChecked: z.string(),
    statusChanged: z.boolean(),
    orderStatusUpdate: z.boolean(),
}).passthrough();

const refundResultSchema = z.object({
    success: z.boolean(),
    gateway: z.string(),
    refundId: z.string().optional(),
    amount: z.number(),
    isFullRefund: z.boolean(),
    error: z.string().optional(),
}).passthrough();

const returnResultSchema = successEnvelope(z.object({
    success: z.boolean(),
    refundResult: refundResultSchema.optional(),
    error: z.string().optional(),
}));

const orderPaymentSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    paymentMethod: z.string(),
    amount: z.number(),
    status: z.string(),
}).passthrough();

const paymentPlanSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    totalAmount: z.number(),
    paidAmount: z.number(),
}).passthrough().nullable();

const orderFormDataSchema = z.object({
    id: z.string(),
    customerName: z.string(),
    customerPhone: z.string(),
    customerEmail: z.string().nullable(),
    shippingAddress: z.string(),
    city: z.string(),
    zone: z.string(),
    area: z.string().nullable(),
    notes: z.string().nullable(),
    discountAmount: z.number().nullable(),
    shippingCharge: z.number(),
    status: z.string(),
    createdAt: z.any(),
    updatedAt: z.any(),
}).passthrough();

const formDataItemSchema = z.object({
    productId: z.string(),
    variantId: z.string().nullable(),
    quantity: z.number(),
    price: z.number(),
});

const formDataProductSchema = z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    discountPercentage: z.number(),
    variants: z.array(productVariantSchema),
}).passthrough();

// ─── GET / (List) ────────────────────────────────────────────────────────────

const listOrdersRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "List orders with pagination and filters",
    request: {
        query: z.object({
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().optional().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search query" }),
            status: z.string().optional().openapi({ description: "Filter by status" }),
            trashed: z.enum(["true", "false"]).optional().openapi({ description: "Show trashed orders" }),
            sort: z.enum(["customerName", "totalAmount", "status", "createdAt", "updatedAt"]).optional().default("updatedAt").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" }),
            startDate: z.string().optional().openapi({ description: "Start date filter" }),
            endDate: z.string().optional().openapi({ description: "End date filter" })
        })
    },
    responses: {
        200: {
            description: "Paginated order list",
            content: { "application/json": { schema: paginatedEnvelope("orders", orderSummarySchema) } },
        },
    }
});

app.openapi(listOrdersRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const result = await OrdersService.listOrders(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        status: query.status || undefined,
        showTrashed: query.trashed === "true",
        sort: query.sort,
        order: query.order as "asc" | "desc",
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined
    });
    return ok(c, result);
});

// ─── POST / (Create) ────────────────────────────────────────────────────────

const createOrderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "Create a new order (admin)",
    request: {
        body: { content: { "application/json": { schema: createOrderSchema } } }
    },
    responses: {
        201: {
            description: "Order created",
            content: { "application/json": { schema: idResponse } },
        },
    }
});

app.openapi(createOrderRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const result = await OrdersService.createOrder(db, data);
    return created(c, result);
});

// ─── POST /bulk-delete ───────────────────────────────────────────────────────

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Orders"],
    summary: "Bulk delete orders",
    request: {
        body: { content: { "application/json": { schema: bulkDeleteOrderSchema } } }
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(bulkDeleteRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    await OrdersService.bulkDeleteOrders(db, data.orderIds, data.permanent);
    return noContent(c);
});

// ─── POST /bulk-ship ─────────────────────────────────────────────────────────

const bulkShipRoute = createRoute({
    method: "post",
    path: "/bulk-ship",
    tags: ["Admin - Orders"],
    summary: "Bulk ship orders",
    request: {
        body: { content: { "application/json": { schema: bulkShipOrderSchema } } }
    },
    responses: {
        200: {
            description: "Bulk ship results",
            content: { "application/json": { schema: bulkShipResponseSchema } },
        },
    }
});

app.openapi(bulkShipRoute, (async (c: any) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const results = await OrdersService.bulkShipOrders(db, data.orderIds, data.providerId, data.options);
    const successCount = results.filter((r) => r.success).length;
    return ok(c, {
        totalProcessed: results.length,
        successCount,
        failureCount: results.length - successCount,
        results
    });
}) as any);

// ─── GET /:id ────────────────────────────────────────────────────────────────

const getOrderRoute = createRoute({
    method: "get",
    path: "/{id}",
    tags: ["Admin - Orders"],
    summary: "Get order details",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order details",
            content: { "application/json": { schema: successEnvelope(orderDetailSchema) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(getOrderRoute, (async (c: any) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const result = await OrdersService.getOrderDetails(db, orderId);
    if (!result) throw new NotFoundError("Order not found");
    return ok(c, result);
}) as any);

// ─── PUT /:id ────────────────────────────────────────────────────────────────

const updateOrderRoute = createRoute({
    method: "put",
    path: "/{id}",
    tags: ["Admin - Orders"],
    summary: "Update an order",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: updateOrderSchema } } }
    },
    responses: {
        200: {
            description: "Order updated",
            content: { "application/json": { schema: idResponse } },
        },
    }
});

app.openapi(updateOrderRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.updateOrder(db, orderId, {
        ...data,
        areaName: data.areaName ?? undefined,
        discountAmount: data.discountAmount ?? 0,
    });
    return ok(c, result);
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

const deleteOrderRoute = createRoute({
    method: "delete",
    path: "/{id}",
    tags: ["Admin - Orders"],
    summary: "Soft delete an order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(deleteOrderRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    await OrdersService.deleteOrder(db, orderId);
    return noContent(c);
});

// ─── POST /:id/restore ──────────────────────────────────────────────────────

const restoreOrderRoute = createRoute({
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Orders"],
    summary: "Restore a soft-deleted order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(restoreOrderRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    await OrdersService.restoreOrder(db, orderId);
    return noContent(c);
});

// ─── DELETE /:id/permanent ───────────────────────────────────────────────────

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/{id}/permanent",
    tags: ["Admin - Orders"],
    summary: "Permanently delete an order",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        204: noContentResponse,
    }
});

app.openapi(permanentDeleteRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    await OrdersService.permanentlyDeleteOrder(db, orderId);
    return noContent(c);
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

app.openapi(getCodRoute, (async (c: any) => {
    const orderId = c.req.valid("param").id;
    const tracking = await c.get("db").select().from(require("@scalius/database/schema").codTracking).where(require("drizzle-orm").eq(require("@scalius/database/schema").codTracking.orderId, orderId)).get();
    return ok(c, { tracking: tracking ?? null });
}) as any);

// ─── POST /:id/cod ───────────────────────────────────────────────────────────

const codActionSchema = z.object({
    action: z.enum(["collected", "failed", "returned"]),
    collectedBy: z.string().optional(),
    collectedAmount: z.number().optional(),
    receiptUrl: z.string().optional(),
    reason: z.enum(["not_home", "refused", "no_cash", "wrong_address", "other"]).optional(),
    notes: z.string().optional()
});

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
    return created(c, result);
});

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

    // Queue customer notification if the status change warrants one
    if (result.notification && c.env.ORDER_NOTIFICATIONS_QUEUE) {
        try {
            await c.env.ORDER_NOTIFICATIONS_QUEUE.send({
                type: "order.notification",
                orderId: result.notification.orderId,
                customerEmail: result.notification.customerEmail,
                customerName: result.notification.customerName,
                notificationType: result.notification.notificationType,
            });
        } catch (err: unknown) {
            console.error(`[orders] Failed to enqueue notification for ${orderId}:`, err);
        }
    }

    return ok(c, { message: result.message });
});

// ─── GET /:id/items ──────────────────────────────────────────────────────────

const getItemsRoute = createRoute({
    method: "get",
    path: "/{id}/items",
    tags: ["Admin - Orders"],
    summary: "Get order items with product details",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order items",
            content: { "application/json": { schema: successEnvelope(z.array(orderItemSchema)) } },
        },
    }
});

app.openapi(getItemsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const items = await db
        .select({
            id: orderItems.id,
            productId: orderItems.productId,
            productName: products.name,
            productImage: productImages.url,
            variantId: orderItems.variantId,
            variantSize: productVariants.size,
            variantColor: productVariants.color,
            quantity: orderItems.quantity,
            price: orderItems.price
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .leftJoin(products, eq(orderItems.productId, products.id))
        .leftJoin(productVariants, eq(orderItems.variantId, productVariants.id))
        .leftJoin(
            productImages,
            and(
                eq(productImages.productId, orderItems.productId),
                eq(productImages.isPrimary, true),
            ),
        );

    return ok(c, items);
});

// ─── GET /:id/payments ───────────────────────────────────────────────────────

const getPaymentsRoute = createRoute({
    method: "get",
    path: "/{id}/payments",
    tags: ["Admin - Orders"],
    summary: "Get order payments and payment plan",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order payments",
            content: { "application/json": { schema: successEnvelope(z.object({ payments: z.array(orderPaymentSchema), plan: paymentPlanSchema })) } },
        },
    }
});

app.openapi(getPaymentsRoute, (async (c: any) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [payments, plan] = await Promise.all([
        db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
        db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get()
    ]);

    return ok(c, { payments, plan: plan ?? null });
}) as any);

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

const createShipmentSchema = z.object({
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
        body: { content: { "application/json": { schema: createShipmentSchema } } }
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

    const encryptionKey = (c.env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY as string | undefined
        ?? (c.env as Record<string, unknown>).JWT_SECRET as string | undefined;
    const shipmentResult = await createShipment(db, orderId, data.providerId, data.options, encryptionKey);

    if (!shipmentResult.success) {
        console.error(`Failed to create shipment for order ${orderId}: ${shipmentResult.message}`);
        throw new ValidationError(shipmentResult.message || "Failed to create shipment");
    }

    const provider = await getDeliveryProvider(db, data.providerId);
    const createdShipment = await getLatestShipment(db, orderId);

    if (!createdShipment) {
        throw new Error("Failed to retrieve created shipment");
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, createdShipment.id));

    const enhancedShipment = {
        ...createdShipment,
        providerName: provider?.name || createdShipment.providerType,
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

app.openapi(checkShipmentStatusRoute, (async (c: any) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const db = c.get("db");

    const shipment = await getShipment(db, shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) throw new ForbiddenError("Shipment does not belong to this order");

    const encryptionKey = (c.env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY as string | undefined
        ?? (c.env as Record<string, unknown>).JWT_SECRET as string | undefined;
    const updatedShipment = await checkShipmentStatus(db, shipmentId, encryptionKey);
    return ok(c, updatedShipment);
}) as any);

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
    const encryptionKey = (c.env as Record<string, unknown>).CREDENTIAL_ENCRYPTION_KEY as string | undefined
        ?? (c.env as Record<string, unknown>).JWT_SECRET as string | undefined;
    try {
        await checkShipmentStatus(db, shipmentId, encryptionKey);
    } catch (e: unknown) {
        throw new ValidationError(e instanceof Error ? e.message : String(e));
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, shipmentId));

    const updatedShipment = await getShipment(db, shipmentId);
    if (!updatedShipment) throw new Error("Failed to retrieve updated shipment");

    const provider = updatedShipment.providerId ? await getDeliveryProvider(db, updatedShipment.providerId) : null;
    const statusChanged = previousStatus !== updatedShipment.status;
    let orderStatusUpdate = false;

    if (statusChanged) {
        try {
            const orderUpdate = await updateOrderStatusFromShipment(db, shipmentId, updatedShipment.status);
            orderStatusUpdate = !!orderUpdate && !!orderUpdate.orderId;
        } catch (e: unknown) {
            console.error("Error updating order status:", e);
        }
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

// ─── POST /:id/return ────────────────────────────────────────────────────────

const returnOrderRoute = createRoute({
    method: "post",
    path: "/{id}/return",
    tags: ["Admin - Orders"],
    summary: "Process order return",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: z.object({ reason: z.string().optional(), autoRefund: z.boolean().optional() }) } } }
    },
    responses: {
        200: {
            description: "Return processed",
            content: { "application/json": { schema: returnResultSchema } },
        },
    }
});

app.openapi(returnOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    const envCache = c.env?.CACHE;
    const result = await processReturn(db, envCache, { orderId, reason: data.reason ?? "Customer return", autoRefund: data.autoRefund ?? false });
    if (!result.success) throw new ValidationError(result.error || "Return processing failed");
    return ok(c, result);
});

// ─── POST /:id/refund ────────────────────────────────────────────────────────

const refundOrderRoute = createRoute({
    method: "post",
    path: "/{id}/refund",
    tags: ["Admin - Orders"],
    summary: "Process order refund",
    request: {
        params: z.object({ id: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        amount: z.number().optional(),
                        reason: z.string().optional(),
                        gateway: z.enum(["stripe", "sslcommerz"]).optional()
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Refund processed",
            content: { "application/json": { schema: successEnvelope(refundResultSchema) } },
        },
    }
});

app.openapi(refundOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db");
    const envCache = c.env?.CACHE;
    const result = await processRefund(db, envCache, { orderId, amount: data.amount, reason: data.reason ?? "Refund requested", gateway: data.gateway });
    if (!result.success) throw new ValidationError(result.error || "Refund processing failed");
    return ok(c, result);
});

// ─── GET /:id/form-data ──────────────────────────────────────────────────────

const getFormDataRoute = createRoute({
    method: "get",
    path: "/{id}/form-data",
    tags: ["Admin - Orders"],
    summary: "Get order data with products for the edit form",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order form data",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        order: orderFormDataSchema,
                        productsWithVariants: z.array(formDataProductSchema),
                        defaultValues: orderFormDataSchema.extend({
                            discountAmount: z.number().nullable(),
                            items: z.array(formDataItemSchema),
                        }),
                    })),
                },
            },
        },
        404: errorResponses[404],
    }
});

app.openapi(getFormDataRoute, (async (c: any) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [order] = await db
        .select({
            id: orders.id,
            customerName: orders.customerName,
            customerPhone: orders.customerPhone,
            customerEmail: orders.customerEmail,
            shippingAddress: orders.shippingAddress,
            city: orders.city,
            zone: orders.zone,
            area: orders.area,
            notes: orders.notes,
            discountAmount: orders.discountAmount,
            shippingCharge: orders.shippingCharge,
            status: orders.status,
            createdAt: orders.createdAt,
            updatedAt: orders.updatedAt,
        })
        .from(orders)
        .where(eq(orders.id, orderId));

    if (!order) throw new NotFoundError("Order not found");

    const [items, allProducts] = await Promise.all([
        db
            .select({
                id: orderItems.id,
                productId: orderItems.productId,
                variantId: orderItems.variantId,
                quantity: orderItems.quantity,
                price: orderItems.price,
            })
            .from(orderItems)
            .where(eq(orderItems.orderId, orderId)),
        db
            .select({
                id: products.id,
                name: products.name,
                price: products.price,
                discountPercentage: products.discountPercentage,
            })
            .from(products)
            .where(isNull(products.deletedAt)),
    ]);

    // Fetch variants for each product
    const productsWithVariants = await Promise.all(
        allProducts.map(async (product: any) => {
            const variants = await db
                .select()
                .from(productVariants)
                .where(and(
                    eq(productVariants.productId, product.id),
                    isNull(productVariants.deletedAt),
                ));
            return { ...product, variants };
        })
    );

    return ok(c, {
        order,
        productsWithVariants,
        defaultValues: {
            ...order,
            discountAmount: order.discountAmount || null,
            items: items.map((item: any) => ({
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                price: item.price,
            })),
        },
    });
}) as any);

export { app as adminOrdersRoutes };
