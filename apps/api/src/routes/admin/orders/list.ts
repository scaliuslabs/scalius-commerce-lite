// Dashboard order list, export, payment-recovery lists, and the order form product picker.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    ORDER_DELIVERY_METHOD_FILTERS,
    ORDER_LIST_VIEWS,
    listOrders,
    loadOrderExportDetails,
} from "@scalius/core/modules/orders";
import { listProducts } from "@scalius/core/modules/products";
import { fromMinor } from "@scalius/shared/money";
import { FulfillmentStatus, PaymentStatus, productVariants } from "@scalius/database/schema";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { ValidationError } from "../../../utils/api-error";
import { ok } from "../../../utils/api-response";
import { paginatedEnvelope, errorResponses } from "../../../schemas/responses";
import { orderSummarySchema, productSummarySchema } from "../../../schemas/entities";
import { parseBangladeshDateOnlyBoundary } from "../order-date-filter";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { listPaymentMethodIds } from "@scalius/core/modules/payments";
import {
    type OrderPaymentRecoveryFilter,
    createOrdersCsvArtifactBuilder,
    createPaymentRecoveryCsvArtifactBuilder,
    ORDER_CSV_ARTIFACT_MAX_BYTES,
} from "@scalius/core/modules/orders/browser";
import { projectOrderListResult } from "../order-list-projection";

const app = new OpenAPIHono<{ Bindings: Env }>();

type OrderListSort = (typeof ORDER_LIST_SORTS)[number];

const paymentStatusQuerySchema = z.enum([
    PaymentStatus.UNPAID,
    PaymentStatus.PARTIAL,
    PaymentStatus.PAID,
    PaymentStatus.PARTIALLY_REFUNDED,
    PaymentStatus.REFUNDED,
    PaymentStatus.FAILED,
]);

const orderListViewQuerySchema = z.enum(ORDER_LIST_VIEWS).openapi({
    description: "Order tab: unfulfilled, unpaid (money still expected), cod_to_collect, delivery_failed, returned, or ready_for_pickup (marked ready, not collected yet).",
});

const ORDER_LIST_SORTS = ["relevance", "customerName", "totalAmount", "createdAt", "updatedAt"] as const;

const paymentMethodQuerySchema = z.enum(listPaymentMethodIds() as [string, ...string[]]);

const fulfillmentStatusQuerySchema = z.enum([
    FulfillmentStatus.PENDING,
    FulfillmentStatus.PARTIAL,
    FulfillmentStatus.COMPLETE,
]);

const deliveryMethodQuerySchema = z.enum(ORDER_DELIVERY_METHOD_FILTERS).openapi({
    description: "How the order reaches the buyer: delivery (ships to an address), pickup, or none (nothing physical).",
});

const paymentRecoveryQuerySchema = z.enum([
    "recoverable",
    "awaiting_payment",
    "processing",
    "needs_attention",
]);

const ORDER_EXPORT_MAX_ROWS = 5_000;
const ORDER_EXPORT_PAGE_SIZE = 90;
const PAYMENT_RECOVERY_EXPORT_MAX_ROWS = 5_000;
const PAYMENT_RECOVERY_EXPORT_PAGE_SIZE = 100;

function csvStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream({
        pull(controller) {
            const chunk = chunks[index];
            if (chunk === undefined) {
                controller.close();
                return;
            }
            index += 1;
            controller.enqueue(encoder.encode(chunk));
        },
    });
}

// ─── GET /catalog-products ──────────────────────────────────────────────────

const catalogProductsRoute = createRoute({
    operationId: "dashboard.orders.catalog_products",
    method: "get",
    path: "/catalog-products",
    tags: ["Admin - Orders"],
    summary: "Search active products for manual order forms",
    request: {
        query: z.object({
            page: z.coerce.number().int().min(1).default(1),
            limit: z.coerce.number().int().min(1).max(20).default(10),
            search: z.string().trim().max(100).optional().default(""),
        }),
    },
    responses: {
        200: {
            description: "Paginated active product catalog",
            content: {
                "application/json": {
                    schema: paginatedEnvelope("products", productSummarySchema.extend({
                        availableStock: z.number().int().nullable().openapi({
                            description: "Units buyers can still order across active SKUs; null when a SKU has no stock limit.",
                        }),
                    })),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(catalogProductsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await listProducts(c.get("db"), {
        page: query.page,
        limit: query.limit,
        search: query.search || undefined,
        status: "active",
        sort: "name",
        order: "asc",
        includeDescription: false,
    });
    const productIds = result.products.map((product) => product.id);
    const stockRows = productIds.length > 0
        ? await c.get("db").select({
            productId: productVariants.productId,
            available: sql<number>`SUM(CASE WHEN ${productVariants.stock} > ${productVariants.reservedStock}
                THEN ${productVariants.stock} - ${productVariants.reservedStock} ELSE 0 END)`,
            untracked: sql<number>`SUM(CASE WHEN ${productVariants.trackInventory} THEN 0 ELSE 1 END)`,
        }).from(productVariants).where(and(
            inArray(productVariants.productId, productIds),
            isNull(productVariants.deletedAt),
        )).groupBy(productVariants.productId).all()
        : [];
    const stockByProduct = new Map(stockRows.map((row) => [
        row.productId,
        Number(row.untracked) > 0 ? null : Number(row.available) || 0,
    ]));
    return ok(c, {
        ...result,
        products: result.products.map((product) => ({
            ...product,
            availableStock: stockByProduct.has(product.id) ? stockByProduct.get(product.id)! : 0,
        })),
    });
});

// ─── GET / (List) ────────────────────────────────────────────────────────────

const listOrdersRoute = createRoute({
    operationId: "dashboard.orders.list",
    method: "get",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "List orders with pagination and filters",
    description: "Find recent orders and orders needing fulfillment, shipping, payment, or lifecycle attention.",
    request: {
        query: z.object({
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().optional().default(10).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search query" }),
            status: z.string().optional().openapi({ description: "Filter by status" }),
            view: orderListViewQuerySchema.optional(),
            openRequest: z.enum(["true", "false"]).optional().openapi({ description: "Only orders with an open customer request" }),
            paymentStatus: paymentStatusQuerySchema.optional().openapi({ description: "Filter by payment status" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment method" }),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional().openapi({ description: "Filter by fulfillment status" }),
            deliveryMethod: deliveryMethodQuerySchema.optional(),
            paymentRecovery: paymentRecoveryQuerySchema.optional().openapi({ description: "Filter by hosted-payment recovery state" }),
            archived: z.enum(["true", "false"]).optional().openapi({ description: "Show archived orders" }),
            sort: z.enum(ORDER_LIST_SORTS).optional().openapi({
                description: "Sort field (default: newest first; relevance when searching).",
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
        ?? (query.search?.trim() ? "relevance" : "createdAt");
    const result = await listOrders(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        status: query.status || undefined,
        view: query.view,
        openRequest: query.openRequest === "true",
        paymentStatus: query.paymentStatus,
        paymentMethod: query.paymentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
        deliveryMethod: query.deliveryMethod,
        paymentRecovery: query.paymentRecovery,
        showArchived: query.archived === "true",
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
        endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end")
    });
    return ok(c, projectOrderListResult(result));
});

// ─── GET /export (bounded CSV artifact) ────────────────────────────────────

const exportOrdersRoute = createRoute({
    operationId: "dashboard.orders.export",
    method: "get",
    path: "/export",
    tags: ["Admin - Orders"],
    summary: "Export filtered orders as a bounded CSV artifact",
    request: {
        query: z.object({
            search: z.string().optional().openapi({ description: "Search query" }),
            status: z.string().optional().openapi({ description: "Filter by status" }),
            view: orderListViewQuerySchema.optional(),
            openRequest: z.enum(["true", "false"]).optional(),
            ids: z.string().optional().openapi({
                description: "Comma-separated order ids (at most 100): export exactly these orders, e.g. the current page or a selection.",
            }),
            format: z.enum(["summary", "items"]).optional().default("summary").openapi({
                description: "One row per order (summary) or one row per item (items).",
            }),
            paymentStatus: paymentStatusQuerySchema.optional(),
            paymentMethod: paymentMethodQuerySchema.optional(),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional(),
            paymentRecovery: paymentRecoveryQuerySchema.optional(),
            archived: z.enum(["true", "false"]).optional(),
            sort: z.enum(ORDER_LIST_SORTS).optional(),
            order: z.enum(["asc", "desc"]).optional().default("desc"),
            startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            maxRows: z.coerce.number()
                .int()
                .min(1)
                .max(ORDER_EXPORT_MAX_ROWS)
                .optional()
                .default(1_000)
                .openapi({ description: "Maximum rows to export. Hard-capped at 5000." }),
        }),
    },
    responses: {
        200: {
            description: "Private spreadsheet-safe order CSV",
            content: { "text/csv": { schema: z.string() } },
        },
        ...errorResponses,
    },
});

app.openapi(exportOrdersRoute, async (c) => {
    const query = c.req.valid("query");
    const db = c.get("db");
    const ids = query.ids
        ? [...new Set(query.ids.split(",").map((id) => id.trim()).filter(Boolean))]
        : undefined;
    if (ids && ids.length > 100) throw new ValidationError("Export at most 100 selected orders at a time.");
    const maxRows = Math.min(query.maxRows, ORDER_EXPORT_MAX_ROWS);
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "createdAt");
    const csvBuilder = createOrdersCsvArtifactBuilder(query.format);
    let exportedRows = 0;
    let page = 1;
    let total = 0;

    exportPages: while (exportedRows < maxRows) {
        const result = await listOrders(db, {
            page,
            limit: ORDER_EXPORT_PAGE_SIZE,
            ids,
            search: ids ? "" : query.search || "",
            status: query.status || undefined,
            view: query.view,
            openRequest: query.openRequest === "true",
            paymentStatus: query.paymentStatus,
            paymentMethod: query.paymentMethod,
            fulfillmentStatus: query.fulfillmentStatus,
            paymentRecovery: query.paymentRecovery,
            showArchived: query.archived === "true",
            sort: effectiveSort,
            order: query.order,
            startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
            endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end"),
        });
        total = result.pagination.total;
        const details = await loadOrderExportDetails(db, result.orders.map((order) => order.id));
        for (const order of result.orders) {
            const detail = details.get(order.id);
            const row = {
                ...order,
                subtotalAmount: fromMinor(order.subtotalAmountMinor ?? 0, order.currencyDecimalPlaces),
                codStatus: order.cod?.status ?? null,
                courierName: detail?.courierName ?? null,
                trackingId: detail?.trackingId ?? null,
                shippingAddress: detail?.shippingAddress ?? "",
                notes: detail?.notes ?? null,
                lines: detail?.lines ?? [],
            };
            if (exportedRows >= maxRows || !csvBuilder.append(row)) break exportPages;
            exportedRows += 1;
        }
        if (result.orders.length === 0 || page >= result.pagination.totalPages) break;
        page += 1;
    }

    const artifact = csvBuilder.finish();
    const limited = artifact.truncatedByBytes || total > artifact.rowCount;
    const truncatedBy = artifact.truncatedByBytes
        ? "bytes"
        : total > artifact.rowCount
            ? "rows"
            : "none";
    const filename = `orders-${commerceCalendarDateKey()}.csv`;
    return c.body(csvStream(artifact.chunks), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(artifact.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Limited": limited ? "true" : "false",
        "X-Export-Truncated-By": truncatedBy,
        "X-Export-Artifact-Bytes": String(artifact.byteLength),
        "X-Export-Max-Bytes": String(ORDER_CSV_ARTIFACT_MAX_BYTES),
        "X-Export-Row-Count": String(artifact.rowCount),
        "X-Export-Total-Count": String(total),
    });
});

// ─── GET /payment-recovery (Dedicated queue view) ───────────────────────────

const paymentRecoveryListRoute = createRoute({
    operationId: "dashboard.orders.payment_recovery_list",
    method: "get",
    path: "/payment-recovery",
    tags: ["Admin - Orders"],
    summary: "List hosted-payment recovery orders",
    description: "Find failed or incomplete payment attempts that need merchant or buyer attention.",
    request: {
        query: z.object({
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).optional().default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search query" }),
            state: paymentRecoveryQuerySchema.optional().default("recoverable").openapi({ description: "Hosted-payment recovery state" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment gateway" }),
            sort: z.enum(ORDER_LIST_SORTS).optional().openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" }),
            startDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "Start date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
            endDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "End date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
        }),
    },
    responses: {
        200: {
            description: "Paginated hosted-payment recovery order list",
            content: { "application/json": { schema: paginatedEnvelope("orders", orderSummarySchema) } },
        },
        ...errorResponses,
    },
});

app.openapi(paymentRecoveryListRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "updatedAt");
    const result = await listOrders(db, {
        page: query.page,
        limit: query.limit,
        search: query.search || "",
        paymentMethod: query.paymentMethod,
        paymentRecovery: query.state as OrderPaymentRecoveryFilter,
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
        endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end"),
    });
    return ok(c, projectOrderListResult(result));
});

const paymentRecoveryExportRoute = createRoute({
    operationId: "dashboard.orders.payment_recovery_export",
    method: "get",
    path: "/payment-recovery/export",
    tags: ["Admin - Orders"],
    summary: "Export hosted-payment recovery orders as CSV",
    request: {
        query: z.object({
            search: z.string().optional().openapi({ description: "Search query" }),
            state: paymentRecoveryQuerySchema.optional().default("recoverable").openapi({ description: "Hosted-payment recovery state" }),
            status: z.string().optional().openapi({ description: "Filter by exact order status" }),
            paymentStatus: paymentStatusQuerySchema.optional().openapi({ description: "Filter by payment status" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment gateway" }),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional().openapi({ description: "Filter by fulfillment status" }),
            archived: z.enum(["true", "false"]).optional().openapi({ description: "Show archived orders" }),
            sort: z.enum(ORDER_LIST_SORTS).optional().openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").openapi({ description: "Sort order" }),
            startDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "Start date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
            endDate: z.string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional()
                .openapi({ description: "End date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
            maxRows: z.coerce.number()
                .int()
                .min(1)
                .max(PAYMENT_RECOVERY_EXPORT_MAX_ROWS)
                .optional()
                .default(1_000)
                .openapi({ description: "Maximum rows to export. Hard-capped at 5000." }),
        }),
    },
    responses: {
        200: {
            description: "Hosted-payment recovery CSV",
            content: { "text/csv": { schema: z.string() } },
        },
        ...errorResponses,
    },
});

app.openapi(paymentRecoveryExportRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const maxRows = Math.min(query.maxRows, PAYMENT_RECOVERY_EXPORT_MAX_ROWS);
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "updatedAt");
    const csvBuilder = createPaymentRecoveryCsvArtifactBuilder();
    let exportedRows = 0;
    let page = 1;
    let total = 0;

    exportPages: while (exportedRows < maxRows) {
        const result = await listOrders(db, {
            page,
            limit: PAYMENT_RECOVERY_EXPORT_PAGE_SIZE,
            search: query.search || "",
            status: query.status || undefined,
            paymentStatus: query.paymentStatus,
            paymentMethod: query.paymentMethod,
            fulfillmentStatus: query.fulfillmentStatus,
            paymentRecovery: query.state as OrderPaymentRecoveryFilter,
            showArchived: query.archived === "true",
            sort: effectiveSort,
            order: query.order as "asc" | "desc",
            startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
            endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end"),
        });
        total = result.pagination.total;
        for (const order of result.orders) {
            if (exportedRows >= maxRows || !csvBuilder.append(order)) break exportPages;
            exportedRows += 1;
        }
        if (result.orders.length === 0 || page >= result.pagination.totalPages) break;
        page += 1;
    }

    const artifact = csvBuilder.finish();
    const limited = artifact.truncatedByBytes || total > artifact.rowCount;
    const truncatedBy = artifact.truncatedByBytes
        ? "bytes"
        : total > artifact.rowCount
            ? "rows"
            : "none";
    const filename = `payment-recovery-${commerceCalendarDateKey()}.csv`;
    return c.body(csvStream(artifact.chunks), 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(artifact.byteLength),
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Export-Limited": limited ? "true" : "false",
        "X-Export-Truncated-By": truncatedBy,
        "X-Export-Artifact-Bytes": String(artifact.byteLength),
        "X-Export-Max-Bytes": String(ORDER_CSV_ARTIFACT_MAX_BYTES),
        "X-Export-Row-Count": String(artifact.rowCount),
        "X-Export-Total-Count": String(total),
    });
});

export { app as adminOrderListRoutes };
