import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import * as OrdersService from "@scalius/core/modules/orders";
import {
    createOrderSchema,
    updateOrderSchema,
    bulkDeleteOrderSchema,
    bulkShipOrderSchema
} from "@scalius/core/modules/orders/orders.validation";
import { orderPayments, paymentPlans, orderItems, products, productVariants, productImages, orders } from "@scalius/database/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { NotFoundError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import { successEnvelope, paginatedEnvelope, idResponse, noContentResponse, errorResponses } from "../../schemas/responses";
import { orderSummarySchema, orderDetailSchema, orderItemSchema, productVariantSchema } from "../../schemas/entities";
import { adminOrdersStatusRoutes } from "./orders-status";
import { adminOrdersRefundRoutes } from "./orders-refund";
import { adminOrdersInvoiceRoutes } from "./orders-invoice";
import { getEncryptionKey } from "../../utils/encryption-key";
import {
    invalidateProductAvailabilityCacheSubjects,
    invalidateProductAvailabilityCaches,
    resolveProductAvailabilityCacheSubjects,
    tryResolveProductAvailabilityCacheSubjects,
} from "../../utils/cache-invalidation";
import { parseBangladeshDateOnlyBoundary } from "./order-date-filter";
import { enqueueOrderNotificationsForStatus } from "../../utils/order-notification-queue";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];
type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";

function isSuccessfulOrderResult(result: unknown): result is { success: true; orderId: string } {
    return typeof result === "object"
        && result !== null
        && (result as Record<string, unknown>).success === true
        && typeof (result as Record<string, unknown>).orderId === "string";
}

function isNewShipmentResult(result: unknown): result is {
    success: true;
    orderId: string;
    shipment: { shipmentId?: string | null; data?: { trackingId?: string | null } };
} {
    return isSuccessfulOrderResult(result)
        && typeof (result as Record<string, unknown>).shipment === "object"
        && (result as Record<string, unknown>).shipment !== null;
}

// Mount sub-routers
app.route("/", adminOrdersStatusRoutes);
app.route("/", adminOrdersRefundRoutes);
app.route("/", adminOrdersInvoiceRoutes);

// ─── Inline response schemas (route-specific, not reusable enough for entities) ──

const bulkShipResultItemSchema = z.object({
    orderId: z.string(),
    success: z.boolean(),
    shipment: z.object({ id: z.string(), status: z.string() }).passthrough().optional(),
    error: z.string().optional(),
}).passthrough();

const bulkShipResponseSchema = successEnvelope(z.object({
    totalProcessed: z.number(),
    successCount: z.number(),
    failureCount: z.number(),
    results: z.array(bulkShipResultItemSchema),
}));

const orderPaymentSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    amount: z.number(),
    currency: z.string(),
    paymentMethod: z.string(),
    paymentType: z.string(),
    status: z.string(),
    stripePaymentIntentId: z.string().nullable(),
    stripeChargeId: z.string().nullable(),
    sslcommerzTranId: z.string().nullable(),
    sslcommerzValId: z.string().nullable(),
    sslcommerzBankTranId: z.string().nullable(),
    polarCheckoutId: z.string().nullable(),
    codCollectedBy: z.string().nullable(),
    codCollectedAt: z.union([z.string(), z.number()]).nullable(),
    codReceiptUrl: z.string().nullable(),
    metadata: z.string().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
});

const paymentPlanSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    totalAmount: z.number(),
    depositAmount: z.number(),
    balanceDue: z.number(),
    paidAmount: z.number(),
    depositPaidAt: z.union([z.string(), z.number()]).nullable(),
    balancePaidAt: z.union([z.string(), z.number()]).nullable(),
    balanceDueDate: z.string().nullable(),
    status: z.string(),
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
}).nullable();

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
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
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
    discountType: z.string().nullable(),
    discountAmount: z.number(),
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
            sort: z.enum([
                "relevance",
                "customerName",
                "totalAmount",
                "status",
                "createdAt",
                "updatedAt",
            ]).optional().openapi({
                description: "Sort field. Use relevance with a search query to order by FTS rank.",
            }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" }),
            startDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "Start date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
            endDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "End date filter (YYYY-MM-DD, Bangladesh calendar day)" })
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
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "updatedAt");
    const result = await OrdersService.listOrders(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        status: query.status || undefined,
        showTrashed: query.trashed === "true",
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
        endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end")
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
    await invalidateProductAvailabilityCaches(db, { orderIds: [result.id] }, c);
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
    const subjects = await resolveProductAvailabilityCacheSubjects(db, {
        orderIds: data.orderIds,
    });
    await OrdersService.bulkDeleteOrders(db, data.orderIds, data.permanent);
    await invalidateProductAvailabilityCacheSubjects(subjects, c, db);
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

app.openapi(bulkShipRoute, (async (c: AdminRouteContext<typeof bulkShipRoute>) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const encryptionKey = getEncryptionKey(c.env as Record<string, unknown>);
    const results = await OrdersService.bulkShipOrders(db, data.orderIds, data.providerId, data.options, encryptionKey);
    const successCount = results.filter((r) => r.success).length;
    const successfulOrderIds = results.filter(isSuccessfulOrderResult).map((r) => r.orderId);
    const newlyShippedResults = results.filter(isNewShipmentResult);
    await invalidateProductAvailabilityCaches(db, { orderIds: successfulOrderIds }, c);

    await enqueueOrderNotificationsForStatus({
        db,
        queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
        orderIds: newlyShippedResults.map((result) => result.orderId),
        newStatus: "shipped",
        trackingByOrderId: Object.fromEntries(
            newlyShippedResults
                .map((result) => [result.orderId, result.shipment.data?.trackingId] as const)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
        ),
        dedupeKeyByOrderId: Object.fromEntries(
            newlyShippedResults.map((result) => [
                result.orderId,
                result.shipment.shipmentId
                    ? `shipment:${result.shipment.shipmentId}:order_shipped`
                    : `shipment:${result.orderId}:${result.shipment.data?.trackingId ?? "unknown"}:order_shipped`,
            ] as const),
        ),
        source: "bulk-ship",
    });

    return ok(c, {
        totalProcessed: results.length,
        successCount,
        failureCount: results.length - successCount,
        results
    });
}) as unknown as AdminRouteHandler<typeof bulkShipRoute>);

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

app.openapi(getOrderRoute, (async (c: AdminRouteContext<typeof getOrderRoute>) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const result = await OrdersService.getOrderDetails(db, orderId);
    if (!result) throw new NotFoundError("Order not found");
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof getOrderRoute>);

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
    const beforeSubjects = await resolveProductAvailabilityCacheSubjects(db, {
        orderIds: [orderId],
    });
    const result = await OrdersService.updateOrder(db, orderId, {
        ...data,
        areaName: data.areaName ?? undefined,
        discountAmount: data.discountAmount ?? 0,
    });
    const afterSubjects = await tryResolveProductAvailabilityCacheSubjects(db, {
        orderIds: [orderId],
    });
    await invalidateProductAvailabilityCacheSubjects(
        [...beforeSubjects, ...afterSubjects],
        c,
        db,
    );
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
    const subjects = await resolveProductAvailabilityCacheSubjects(db, {
        orderIds: [orderId],
    });
    await OrdersService.deleteOrder(db, orderId);
    await invalidateProductAvailabilityCacheSubjects(subjects, c, db);
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
    await invalidateProductAvailabilityCaches(db, { orderIds: [orderId] }, c);
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
    const subjects = await resolveProductAvailabilityCacheSubjects(db, {
        orderIds: [orderId],
    });
    await OrdersService.permanentlyDeleteOrder(db, orderId);
    await invalidateProductAvailabilityCacheSubjects(subjects, c, db);
    return noContent(c);
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
            price: orderItems.price,
            fulfillmentStatus: orderItems.fulfillmentStatus,
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

app.openapi(getPaymentsRoute, (async (c: AdminRouteContext<typeof getPaymentsRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [payments, plan] = await Promise.all([
        db.select().from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
        db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get()
    ]);

    return ok(c, { payments, plan: plan ?? null });
}) as unknown as AdminRouteHandler<typeof getPaymentsRoute>);

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

app.openapi(getFormDataRoute, (async (c: AdminRouteContext<typeof getFormDataRoute>) => {
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
                discountType: products.discountType,
                discountAmount: products.discountAmount,
            })
            .from(products)
            .where(isNull(products.deletedAt)),
    ]);

    // Fetch all variants in a single batched query instead of N+1
    const allProductIds = allProducts.map((p) => p.id);
    const allVariants = allProductIds.length > 0
        ? await db
            .select()
            .from(productVariants)
            .where(and(
                inArray(productVariants.productId, allProductIds),
                isNull(productVariants.deletedAt),
            ))
        : [];

    const variantsByProductId = new Map<string, typeof allVariants>();
    for (const variant of allVariants) {
        const existing = variantsByProductId.get(variant.productId) ?? [];
        existing.push(variant);
        variantsByProductId.set(variant.productId, existing);
    }

    const productsWithVariants = allProducts.map((product) => ({
        ...product,
        variants: variantsByProductId.get(product.id) ?? [],
    }));

    return ok(c, {
        order,
        productsWithVariants,
        defaultValues: {
            ...order,
            discountAmount: order.discountAmount || null,
            items: items.map((item) => ({
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                price: item.price,
            })),
        },
    });
}) as unknown as AdminRouteHandler<typeof getFormDataRoute>);

export { app as adminOrdersRoutes };
