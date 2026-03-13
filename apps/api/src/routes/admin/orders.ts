import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import * as OrdersService from "@scalius/core/modules/orders/orders.service";
import {
    createOrderSchema,
    updateOrderSchema,
    bulkDeleteOrderSchema,
    bulkShipOrderSchema
} from "@scalius/core/modules/orders/orders.validation";
import { processReturn, processRefund } from "@scalius/core/modules/payments/refund-service";
import { DeliveryService } from "@scalius/core/modules/delivery/service";
import { ShipmentTracker } from "@scalius/core/modules/delivery/tracking";
import { orderPayments, paymentPlans, deliveryShipments, orderItems, products, productVariants, productImages } from "@scalius/database/schema";
import { eq, and } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";

const app = new OpenAPIHono<{
    Variables: {
        db: any;
        user: any;
        session: any;
    };
    Bindings: {
        CACHE: KVNamespace;
    };
}>();

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
            endDate: z.string().optional().openapi({ description: "End date filter" }),
        }),
    },
    responses: {
        200: { description: "Paginated order list", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(listOrdersRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await OrdersService.getOrders({
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        status: query.status || undefined,
        showTrashed: query.trashed === "true",
        sort: query.sort as any,
        order: query.order as "asc" | "desc",
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
    });
    return c.json(result, 200);
});

// ─── POST / (Create) ────────────────────────────────────────────────────────

const createOrderRoute = createRoute({
    method: "post",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "Create a new order (admin)",
    request: {
        body: { content: { "application/json": { schema: createOrderSchema } } },
    },
    responses: {
        201: { description: "Order created", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(createOrderRoute, async (c) => {
    const data = c.req.valid("json");
    const result = await OrdersService.createOrder(data);
    return c.json(result, 201);
});

// ─── POST /bulk-delete ───────────────────────────────────────────────────────

const bulkDeleteRoute = createRoute({
    method: "post",
    path: "/bulk-delete",
    tags: ["Admin - Orders"],
    summary: "Bulk delete orders",
    request: {
        body: { content: { "application/json": { schema: bulkDeleteOrderSchema } } },
    },
    responses: {
        204: { description: "Orders deleted" },
    },
});

app.openapi(bulkDeleteRoute, async (c) => {
    const data = c.req.valid("json");
    await OrdersService.bulkDeleteOrders(data.orderIds, data.permanent);
    return new Response(null, { status: 204 }) as any;
});

// ─── POST /bulk-ship ─────────────────────────────────────────────────────────

const bulkShipRoute = createRoute({
    method: "post",
    path: "/bulk-ship",
    tags: ["Admin - Orders"],
    summary: "Bulk ship orders",
    request: {
        body: { content: { "application/json": { schema: bulkShipOrderSchema } } },
    },
    responses: {
        200: { description: "Bulk ship results", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(bulkShipRoute, async (c) => {
    const data = c.req.valid("json");
    const results = await OrdersService.bulkShipOrders(data.orderIds, data.providerId, data.options);
    const successCount = results.filter((r) => r.success).length;
    return c.json({
        totalProcessed: results.length,
        successCount,
        failureCount: results.length - successCount,
        results,
    }, 200);
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

const getOrderRoute = createRoute({
    method: "get",
    path: "/:id",
    tags: ["Admin - Orders"],
    summary: "Get order details",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "Order details", content: { "application/json": { schema: z.any() } } },
        404: { description: "Order not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const result = await OrdersService.getOrderDetails(orderId);
    if (!result) throw new NotFoundError("Order not found");
    return c.json(result, 200);
});

// ─── PUT /:id ────────────────────────────────────────────────────────────────

const updateOrderRoute = createRoute({
    method: "put",
    path: "/:id",
    tags: ["Admin - Orders"],
    summary: "Update an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: updateOrderSchema } } },
    },
    responses: {
        200: { description: "Order updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(updateOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.updateOrder(orderId, data);
    return c.json(result, 200);
});

// ─── DELETE /:id ─────────────────────────────────────────────────────────────

const deleteOrderRoute = createRoute({
    method: "delete",
    path: "/:id",
    tags: ["Admin - Orders"],
    summary: "Soft delete an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        204: { description: "Order deleted" },
    },
});

app.openapi(deleteOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    await OrdersService.deleteOrder(orderId);
    return new Response(null, { status: 204 }) as any;
});

// ─── POST /:id/restore ──────────────────────────────────────────────────────

const restoreOrderRoute = createRoute({
    method: "post",
    path: "/:id/restore",
    tags: ["Admin - Orders"],
    summary: "Restore a soft-deleted order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        204: { description: "Order restored" },
    },
});

app.openapi(restoreOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    await OrdersService.restoreOrder(orderId);
    return new Response(null, { status: 204 }) as any;
});

// ─── DELETE /:id/permanent ───────────────────────────────────────────────────

const permanentDeleteRoute = createRoute({
    method: "delete",
    path: "/:id/permanent",
    tags: ["Admin - Orders"],
    summary: "Permanently delete an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        204: { description: "Order permanently deleted" },
    },
});

app.openapi(permanentDeleteRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    await OrdersService.permanentlyDeleteOrder(orderId);
    return new Response(null, { status: 204 }) as any;
});

// ─── GET /:id/cod ────────────────────────────────────────────────────────────

const getCodRoute = createRoute({
    method: "get",
    path: "/:id/cod",
    tags: ["Admin - Orders"],
    summary: "Get COD tracking for an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "COD tracking info", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getCodRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const tracking = await c.get("db").select().from(require("@scalius/database/schema").codTracking).where(require("drizzle-orm").eq(require("@scalius/database/schema").codTracking.orderId, orderId)).get();
    return c.json({ tracking: tracking ?? null }, 200);
});

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
    path: "/:id/cod",
    tags: ["Admin - Orders"],
    summary: "Process COD action",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: codActionSchema } } },
    },
    responses: {
        200: { description: "COD action processed", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(postCodRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.processCodAction(orderId, data);
    return c.json(result, 200);
});

// ─── GET /:id/fulfill ────────────────────────────────────────────────────────

const getFulfillRoute = createRoute({
    method: "get",
    path: "/:id/fulfill",
    tags: ["Admin - Orders"],
    summary: "Get fulfillment shipments for an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "Order shipments", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getFulfillRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const shipments = await OrdersService.getOrderShipments(orderId);
    return c.json({ shipments }, 200);
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
    path: "/:id/fulfill",
    tags: ["Admin - Orders"],
    summary: "Create a fulfillment shipment",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: fulfillSchema } } },
    },
    responses: {
        201: { description: "Fulfillment created", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(postFulfillRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.createFulfillmentShipment(orderId, data);
    return c.json(result, 201);
});

// ─── PUT /:id/status ─────────────────────────────────────────────────────────

const updateStatusRoute = createRoute({
    method: "put",
    path: "/:id/status",
    tags: ["Admin - Orders"],
    summary: "Update order status",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: z.object({ status: z.string() }) } } },
    },
    responses: {
        200: { description: "Status updated", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(updateStatusRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const result = await OrdersService.updateOrderStatus(orderId, data.status);
    return c.json(result, 200);
});

// ─── GET /:id/items ──────────────────────────────────────────────────────────

const getItemsRoute = createRoute({
    method: "get",
    path: "/:id/items",
    tags: ["Admin - Orders"],
    summary: "Get order items with product details",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "Order items", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getItemsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db") as any;

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
            price: orderItems.price,
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

    return c.json(items, 200);
});

// ─── GET /:id/payments ───────────────────────────────────────────────────────

const getPaymentsRoute = createRoute({
    method: "get",
    path: "/:id/payments",
    tags: ["Admin - Orders"],
    summary: "Get order payments and payment plan",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "Order payments", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getPaymentsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db") as any;

    const [payments, plan] = await Promise.all([
        db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
        db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get()
    ]);

    return c.json({ payments, plan: plan ?? null }, 200);
});

// ─── GET /:id/shipments ──────────────────────────────────────────────────────

const getShipmentsRoute = createRoute({
    method: "get",
    path: "/:id/shipments",
    tags: ["Admin - Orders"],
    summary: "Get order shipments",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
    },
    responses: {
        200: { description: "Order shipments", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getShipmentsRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const deliveryService = new DeliveryService();
    const shipments = await deliveryService.getShipments(orderId);

    const enhancedShipments = await Promise.all(
        shipments.map(async (shipment) => {
            const provider = shipment.providerId ? await deliveryService.getProvider(shipment.providerId) : null;
            return {
                ...shipment,
                providerName: provider?.name || shipment.providerType,
                lastChecked: shipment.lastChecked || shipment.updatedAt,
            };
        })
    );

    return c.json(enhancedShipments, 200);
});

// ─── POST /:id/shipments ─────────────────────────────────────────────────────

const createShipmentSchema = z.object({
    providerId: z.string(),
    options: z.record(z.string(), z.any()).optional(),
});

const createShipmentRoute = createRoute({
    method: "post",
    path: "/:id/shipments",
    tags: ["Admin - Orders"],
    summary: "Create a shipment for an order",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: createShipmentSchema } } },
    },
    responses: {
        201: { description: "Shipment created", content: { "application/json": { schema: z.any() } } },
        400: { description: "Failed to create shipment", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(createShipmentRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db") as any;
    const deliveryService = new DeliveryService();

    const shipmentResult = await deliveryService.createShipment(orderId, data.providerId, data.options);

    if (!shipmentResult.success) {
        console.error(`Failed to create shipment for order ${orderId}: ${shipmentResult.message}`);
        return c.json({ error: "Failed to create shipment", message: shipmentResult.message }, 400);
    }

    const provider = await deliveryService.getProvider(data.providerId);
    const createdShipment = await deliveryService.getLatestShipment(orderId);

    if (!createdShipment) {
        return c.json({ error: "Failed to retrieve created shipment" }, 500);
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, createdShipment.id));

    const enhancedShipment = {
        ...createdShipment,
        providerName: provider?.name || createdShipment.providerType,
        lastChecked: now.toISOString(),
    };

    return c.json(enhancedShipment, 201);
});

// ─── GET /:id/shipments/:shipmentId ──────────────────────────────────────────

const getShipmentRoute = createRoute({
    method: "get",
    path: "/:id/shipments/:shipmentId",
    tags: ["Admin - Orders"],
    summary: "Get a specific shipment",
    request: {
        params: z.object({
            id: z.string().openapi({ description: "Order ID" }),
            shipmentId: z.string().openapi({ description: "Shipment ID" }),
        }),
    },
    responses: {
        200: { description: "Shipment details", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(getShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const deliveryService = new DeliveryService();

    const shipment = await deliveryService.getShipment(shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) return c.json({ error: "Shipment does not belong to this order" }, 403);

    return c.json(shipment, 200);
});

// ─── DELETE /:id/shipments/:shipmentId ───────────────────────────────────────

const deleteShipmentRoute = createRoute({
    method: "delete",
    path: "/:id/shipments/:shipmentId",
    tags: ["Admin - Orders"],
    summary: "Delete a shipment",
    request: {
        params: z.object({
            id: z.string().openapi({ description: "Order ID" }),
            shipmentId: z.string().openapi({ description: "Shipment ID" }),
        }),
    },
    responses: {
        200: { description: "Shipment deleted", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(deleteShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const deliveryService = new DeliveryService();

    const shipment = await deliveryService.getShipment(shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) return c.json({ error: "Shipment does not belong to this order" }, 403);

    await deliveryService.deleteShipment(shipmentId);
    return c.json({ success: true }, 200);
});

// ─── POST /:id/shipments/:shipmentId/status ──────────────────────────────────

const checkShipmentStatusRoute = createRoute({
    method: "post",
    path: "/:id/shipments/:shipmentId/status",
    tags: ["Admin - Orders"],
    summary: "Check shipment status from provider",
    request: {
        params: z.object({
            id: z.string().openapi({ description: "Order ID" }),
            shipmentId: z.string().openapi({ description: "Shipment ID" }),
        }),
    },
    responses: {
        200: { description: "Status checked", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(checkShipmentStatusRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const deliveryService = new DeliveryService();

    const shipment = await deliveryService.getShipment(shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) return c.json({ error: "Shipment does not belong to this order" }, 403);

    const updatedShipment = await deliveryService.checkShipmentStatus(shipmentId);
    return c.json(updatedShipment, 200);
});

// ─── POST /:id/shipments/:shipmentId/refresh ─────────────────────────────────

const refreshShipmentRoute = createRoute({
    method: "post",
    path: "/:id/shipments/:shipmentId/refresh",
    tags: ["Admin - Orders"],
    summary: "Refresh shipment status and update order",
    request: {
        params: z.object({
            id: z.string().openapi({ description: "Order ID" }),
            shipmentId: z.string().openapi({ description: "Shipment ID" }),
        }),
    },
    responses: {
        200: { description: "Shipment refreshed", content: { "application/json": { schema: z.any() } } },
        400: { description: "Failed to refresh", content: { "application/json": { schema: z.any() } } },
        404: { description: "Shipment not found", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(refreshShipmentRoute, async (c) => {
    const { id: orderId, shipmentId } = c.req.valid("param");
    const deliveryService = new DeliveryService();
    const db = c.get("db") as any;

    const shipment = await deliveryService.getShipment(shipmentId);
    if (!shipment) throw new NotFoundError("Shipment not found");
    if (shipment.orderId !== orderId) return c.json({ error: "Shipment does not belong to this order" }, 400);

    const previousStatus = shipment.status;
    try {
        await deliveryService.checkShipmentStatus(shipmentId);
    } catch (e: any) {
        return c.json({ error: "Failed to refresh shipment status", message: e.message }, 400);
    }

    const now = new Date();
    await db.update(deliveryShipments).set({ lastChecked: now }).where(eq(deliveryShipments.id, shipmentId));

    const updatedShipment = await deliveryService.getShipment(shipmentId);
    if (!updatedShipment) return c.json({ error: "Failed to retrieve updated shipment" }, 500);

    const provider = updatedShipment.providerId ? await deliveryService.getProvider(updatedShipment.providerId) : null;
    const statusChanged = previousStatus !== updatedShipment.status;
    let orderStatusUpdate = false;

    if (statusChanged) {
        try {
            const orderUpdate = await ShipmentTracker.updateOrderStatusFromShipment(shipmentId, updatedShipment.status);
            orderStatusUpdate = !!orderUpdate && !!orderUpdate.orderId;
        } catch (e) {
            console.error("Error updating order status:", e);
        }
    }

    return c.json({
        ...updatedShipment,
        providerName: provider?.name || updatedShipment.providerType,
        providerType: updatedShipment.providerType,
        lastChecked: now.toISOString(),
        statusChanged,
        orderStatusUpdate,
    }, 200);
});

// ─── POST /:id/return ────────────────────────────────────────────────────────

const returnOrderRoute = createRoute({
    method: "post",
    path: "/:id/return",
    tags: ["Admin - Orders"],
    summary: "Process order return",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: { content: { "application/json": { schema: z.object({ reason: z.string().optional(), autoRefund: z.boolean().optional() }) } } },
    },
    responses: {
        200: { description: "Return processed", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(returnOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db") as any;
    const envCache = c.env?.CACHE;
    const result = await processReturn(db, envCache, { orderId, reason: data.reason ?? "Customer return", autoRefund: data.autoRefund ?? false });
    return c.json(result, result.success ? 200 : 400);
});

// ─── POST /:id/refund ────────────────────────────────────────────────────────

const refundOrderRoute = createRoute({
    method: "post",
    path: "/:id/refund",
    tags: ["Admin - Orders"],
    summary: "Process order refund",
    request: {
        params: z.object({ id: z.string().openapi({ description: "Order ID" }) }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        amount: z.number().optional(),
                        reason: z.string().optional(),
                        gateway: z.enum(["stripe", "sslcommerz"]).optional(),
                    }),
                },
            },
        },
    },
    responses: {
        200: { description: "Refund processed", content: { "application/json": { schema: z.any() } } },
    },
});

app.openapi(refundOrderRoute, async (c) => {
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    const db = c.get("db") as any;
    const envCache = c.env?.CACHE;
    const result = await processRefund(db, envCache, { orderId, amount: data.amount, reason: data.reason ?? "Refund requested", gateway: data.gateway });
    return c.json(result, result.success ? 200 : 400);
});

export { app as adminOrdersRoutes };
