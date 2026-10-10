// Dashboard order list, export, payment-recovery lists, and the order form product picker.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
    ORDER_DELIVERY_METHOD_FILTERS,
    ORDER_LIST_VIEWS,
    listOrders,
    loadOrderExportDetails,
} from "@scalius/core/modules/orders";
import { readStoreDecimalPlaces, readStoredCustomization } from "@scalius/core/modules/products";
import { listProducts } from "@scalius/core/modules/product-admin";
import { customizationViewSchema } from "../../../schemas/order-lines";
import { fromMinor } from "@scalius/shared/money";
import { FulfillmentStatus, PaymentStatus, orders, productVariants, products } from "@scalius/database/schema";
import { and, inArray, isNull, sql } from "drizzle-orm";
import { ValidationError } from "../../../utils/api-error";
import { ok } from "../../../utils/api-response";
import { keysetPaginatedEnvelope, keysetQuerySchema, errorResponses } from "../../../schemas/responses";
import { orderSummarySchema, productSummarySchema } from "../../../schemas/entities";
import { parseStoreDateOnlyBoundary } from "../order-date-filter";
import {
    ORDER_CHANNELS,
    ORDER_CHANNEL_SOURCE_MAX_LENGTH,
    ORDER_CHANNEL_SOURCE_PATTERN,
} from "@scalius/shared/order-channel";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { storeTimeZoneOf } from "../../../utils/store-time-zone";
import { isAppPaymentMethod, isPaymentMethodId, paymentMethodLabel, type PaymentProviders } from "@scalius/core/modules/payments";
import { requestPaymentProviders } from "../../../plugins/providers/payment";
import {
    type OrderPaymentRecoveryFilter,
    createOrdersCsvArtifactBuilder,
    createPaymentRecoveryCsvArtifactBuilder,
    ORDER_CSV_ARTIFACT_MAX_BYTES,
} from "@scalius/core/modules/orders/browser";
import { projectOrderListResult } from "../order-list-projection";
import { appListQuerySchema, appListValuesSchema, planAppList } from "../../../plugins/list-columns";
import { matchingSchema } from "../../../schemas/bulk-matching";
import type { Database } from "@scalius/database/client";
import type { OrderListFilter } from "@scalius/core/modules/orders";

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

/** `cod`, a gateway id, or an app provider's `<plugin id>:<provider id>`. */
const paymentMethodQuerySchema = z.string().max(160).refine(isPaymentMethodId, "Unknown payment method");

const fulfillmentStatusQuerySchema = z.enum([
    FulfillmentStatus.PENDING,
    FulfillmentStatus.PARTIAL,
    FulfillmentStatus.COMPLETE,
]);

const deliveryMethodQuerySchema = z.enum(ORDER_DELIVERY_METHOD_FILTERS).openapi({
    description: "How the order reaches the buyer: delivery (ships to an address), pickup, or none (nothing physical).",
});

const channelQuerySchema = z.enum(ORDER_CHANNELS).openapi({
    description: "Where the order came from: online_store, admin (dashboard), pos, agent (AI agent) or app.",
});

const channelSourceQuerySchema = z.string()
    .max(ORDER_CHANNEL_SOURCE_MAX_LENGTH)
    .regex(ORDER_CHANNEL_SOURCE_PATTERN)
    .openapi({ description: "A stored source slug, e.g. facebook, whatsapp or walk_in." });

const paymentRecoveryQuerySchema = z.enum([
    "recoverable",
    "awaiting_payment",
    "processing",
    "needs_attention",
]);

/**
 * The orders list's filter for "all matching" bulk actions
 * (schemas/bulk-matching.ts): the list query's own fields, never in a URL.
 */
export const orderMatchingSchema = matchingSchema(z.object({
    search: z.string().trim().max(160).optional(),
    status: z.string().max(40).optional(),
    view: orderListViewQuerySchema.optional(),
    openRequest: z.boolean().optional(),
    paymentStatus: paymentStatusQuerySchema.optional(),
    paymentMethod: paymentMethodQuerySchema.optional(),
    fulfillmentStatus: fulfillmentStatusQuerySchema.optional(),
    deliveryMethod: deliveryMethodQuerySchema.optional(),
    channel: channelQuerySchema.optional(),
    channelSource: channelSourceQuerySchema.optional(),
    paymentRecovery: paymentRecoveryQuerySchema.optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    appFilter: appListQuerySchema.appFilter,
}).strict());
export type OrderMatching = z.infer<typeof orderMatchingSchema>;

/** The core list filter a matching request names, with its app filter and store-day dates resolved. */
export async function orderMatchingFilter(db: Database, env: Env, filter: OrderMatching["filter"]): Promise<OrderListFilter> {
    const app = await planAppList(db, "order", orders.id, { appFilter: filter.appFilter });
    return {
        appCondition: app.condition,
        search: filter.search || undefined,
        status: filter.status || undefined,
        view: filter.view,
        openRequest: filter.openRequest === true,
        paymentStatus: filter.paymentStatus,
        paymentMethod: filter.paymentMethod,
        fulfillmentStatus: filter.fulfillmentStatus,
        deliveryMethod: filter.deliveryMethod,
        channel: filter.channel,
        channelSource: filter.channelSource,
        paymentRecovery: filter.paymentRecovery,
        startDate: parseStoreDateOnlyBoundary(filter.startDate, "start", storeTimeZoneOf(env)),
        endDate: parseStoreDateOnlyBoundary(filter.endDate, "end", storeTimeZoneOf(env)),
    };
}

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

/**
 * An export's order. A best-match order is computed per row and can only page
 * through the first matches (1,000 on Free), so a file of up to 5,000 rows lists the
 * matching orders in the list's newest-first (or last-updated) order instead.
 */
function exportSort(requested: OrderListSort | undefined, fallback: OrderListSort = "createdAt"): OrderListSort {
    return requested && requested !== "relevance" ? requested : fallback;
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
                    schema: keysetPaginatedEnvelope("products", productSummarySchema.extend({
                        availableStock: z.number().int().nullable().openapi({
                            description: "Units buyers can still order across active SKUs; null when a SKU has no stock limit.",
                        }),
                        /** A buyer input is required: collect it before adding the line. */
                        requiresCustomization: z.boolean(),
                        /** The product's buyer inputs, to render in the picker; null when none. */
                        customization: customizationViewSchema.nullable(),
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
            untracked: sql<number>`SUM(CASE WHEN ${productVariants.trackInventory} = 1 THEN 0 ELSE 1 END)`,
        }).from(productVariants).where(and(
            inArray(productVariants.productId, productIds),
            isNull(productVariants.deletedAt),
        )).groupBy(productVariants.productId).all()
        : [];
    const stockByProduct = new Map(stockRows.map((row) => [
        row.productId,
        Number(row.untracked) > 0 ? null : Number(row.available) || 0,
    ]));
    // At most 20 ids per page, well under the 90-id chunk bound.
    const [customizationRows, decimalPlaces] = productIds.length > 0
        ? await Promise.all([
            c.get("db").select({ id: products.id, customizationSchema: products.customizationSchema })
                .from(products).where(inArray(products.id, productIds)).all(),
            readStoreDecimalPlaces(c.get("db")),
        ])
        : [[], 0] as const;
    const customizationByProduct = new Map(customizationRows.map((row) => [
        row.id,
        readStoredCustomization(row.customizationSchema, decimalPlaces),
    ]));
    return ok(c, {
        ...result,
        products: result.products.map((product) => ({
            ...product,
            availableStock: stockByProduct.has(product.id) ? stockByProduct.get(product.id)! : 0,
            requiresCustomization: customizationByProduct.get(product.id)?.requiresCustomization ?? false,
            customization: customizationByProduct.get(product.id)?.customization ?? null,
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
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number; reaches the first 1,000 rows only, 10,000 on a Paid deployment (PAGE_TOO_DEEP beyond), use after/before to go deeper" }),
            limit: z.coerce.number().optional().default(10).openapi({ description: "Items per page" }),
            ...keysetQuerySchema,
            search: z.string().optional().openapi({ description: "Search query" }),
            status: z.string().optional().openapi({ description: "Filter by status" }),
            view: orderListViewQuerySchema.optional(),
            openRequest: z.enum(["true", "false"]).optional().openapi({ description: "Only orders with an open customer request" }),
            paymentStatus: paymentStatusQuerySchema.optional().openapi({ description: "Filter by payment status" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment method" }),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional().openapi({ description: "Filter by fulfillment status" }),
            deliveryMethod: deliveryMethodQuerySchema.optional(),
            channel: channelQuerySchema.optional(),
            channelSource: channelSourceQuerySchema.optional(),
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
                .openapi({ description: "End date filter (YYYY-MM-DD, Bangladesh calendar day)" }),
            ...appListQuerySchema,
        })
    },
    responses: {
        200: {
            description: "Cursor-paginated order list with a capped total",
            content: { "application/json": { schema: keysetPaginatedEnvelope("orders", orderSummarySchema, { appValues: appListValuesSchema }) } },
        },
        ...errorResponses,
    }
});

app.openapi(listOrdersRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "createdAt");
    // App columns and filters: nothing more is read unless the request names some.
    const app = await planAppList(db, "order", orders.id, query);
    const result = await listOrders(db, {
        appCondition: app.condition,
        page: query.page,
        limit: query.limit,
        after: query.after,
        before: query.before,
        search: query.search || "",
        status: query.status || undefined,
        view: query.view,
        openRequest: query.openRequest === "true",
        paymentStatus: query.paymentStatus,
        paymentMethod: query.paymentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
        deliveryMethod: query.deliveryMethod,
        channel: query.channel,
        channelSource: query.channelSource,
        paymentRecovery: query.paymentRecovery,
        showArchived: query.archived === "true",
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseStoreDateOnlyBoundary(query.startDate, "start", storeTimeZoneOf(c.env)),
        endDate: parseStoreDateOnlyBoundary(query.endDate, "end", storeTimeZoneOf(c.env))
    });
    const appValues = await app.values(result.orders.map((order) => order.id));
    return ok(c, { ...projectOrderListResult(result), ...(appValues ? { appValues } : {}) });
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
            deliveryMethod: deliveryMethodQuerySchema.optional(),
            channel: channelQuerySchema.optional(),
            channelSource: channelSourceQuerySchema.optional(),
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
    const effectiveSort: OrderListSort = exportSort(query.sort);
    // App methods are named by their providers, read once and only when a page has one.
    let providers: PaymentProviders | null = null;
    const csvBuilder = createOrdersCsvArtifactBuilder(query.format, storeTimeZoneOf(c.env), undefined,
        (id) => (providers ?? null)?.label(id) ?? paymentMethodLabel(id));
    let exportedRows = 0;
    let after: string | undefined;
    // Rows remain beyond the file; the list's own total is only a capped count.
    let moreRows = false;
    let counted: { total: number; totalIsCapped: boolean } | undefined;

    exportPages: for (;;) {
        const result = await listOrders(db, {
            after,
            limit: ORDER_EXPORT_PAGE_SIZE,
            ids,
            search: ids ? "" : query.search || "",
            status: query.status || undefined,
            view: query.view,
            openRequest: query.openRequest === "true",
            paymentStatus: query.paymentStatus,
            paymentMethod: query.paymentMethod,
            fulfillmentStatus: query.fulfillmentStatus,
            deliveryMethod: query.deliveryMethod,
            channel: query.channel,
            channelSource: query.channelSource,
            paymentRecovery: query.paymentRecovery,
            showArchived: query.archived === "true",
            sort: effectiveSort,
            order: query.order,
            startDate: parseStoreDateOnlyBoundary(query.startDate, "start", storeTimeZoneOf(c.env)),
            endDate: parseStoreDateOnlyBoundary(query.endDate, "end", storeTimeZoneOf(c.env)),
        });
        counted = { total: result.pagination.total, totalIsCapped: result.pagination.totalIsCapped };
        if (!providers && result.orders.some((order) => isAppPaymentMethod(order.paymentMethod))) providers = await requestPaymentProviders(c);
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
                shippingAddressLine2: detail?.shippingAddressLine2 ?? null,
                shippingDependentLocality: detail?.shippingDependentLocality ?? null,
                shippingAdminArea: detail?.shippingAdminArea ?? null,
                shippingPostalCode: detail?.shippingPostalCode ?? null,
                billing: detail?.billing,
                notes: detail?.notes ?? null,
                lines: detail?.lines ?? [],
            };
            if (exportedRows >= maxRows || !csvBuilder.append(row)) {
                moreRows = true;
                break exportPages;
            }
            exportedRows += 1;
        }
        if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) break;
        if (exportedRows >= maxRows) {
            moreRows = true;
            break;
        }
        after = result.pageInfo.endCursor;
    }

    const artifact = csvBuilder.finish();
    const limited = artifact.truncatedByBytes || moreRows;
    const truncatedBy = artifact.truncatedByBytes
        ? "bytes"
        : moreRows
            ? "rows"
            : "none";
    const filename = `orders-${commerceCalendarDateKey(storeTimeZoneOf(c.env))}.csv`;
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
        // Exact up to the list's count cap; above it a lower bound (X-Export-Total-Capped).
        "X-Export-Total-Count": String(counted?.totalIsCapped ? Math.max(counted.total, artifact.rowCount) : counted?.total ?? 0),
        "X-Export-Total-Capped": counted?.totalIsCapped ? "true" : "false",
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
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number; reaches the first 1,000 rows only, 10,000 on a Paid deployment (PAGE_TOO_DEEP beyond), use after/before to go deeper" }),
            limit: z.coerce.number().max(100).optional().default(20).openapi({ description: "Items per page" }),
            ...keysetQuerySchema,
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
            description: "Cursor-paginated hosted-payment recovery order list with a capped total",
            content: { "application/json": { schema: keysetPaginatedEnvelope("orders", orderSummarySchema) } },
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
        after: query.after,
        before: query.before,
        search: query.search || "",
        paymentMethod: query.paymentMethod,
        paymentRecovery: query.state as OrderPaymentRecoveryFilter,
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseStoreDateOnlyBoundary(query.startDate, "start", storeTimeZoneOf(c.env)),
        endDate: parseStoreDateOnlyBoundary(query.endDate, "end", storeTimeZoneOf(c.env)),
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
    const effectiveSort: OrderListSort = exportSort(query.sort, "updatedAt");
    const csvBuilder = createPaymentRecoveryCsvArtifactBuilder();
    let exportedRows = 0;
    let after: string | undefined;
    let moreRows = false;
    let counted: { total: number; totalIsCapped: boolean } | undefined;

    exportPages: for (;;) {
        const result = await listOrders(db, {
            after,
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
            startDate: parseStoreDateOnlyBoundary(query.startDate, "start", storeTimeZoneOf(c.env)),
            endDate: parseStoreDateOnlyBoundary(query.endDate, "end", storeTimeZoneOf(c.env)),
        });
        counted = { total: result.pagination.total, totalIsCapped: result.pagination.totalIsCapped };
        for (const order of result.orders) {
            if (exportedRows >= maxRows || !csvBuilder.append(order)) {
                moreRows = true;
                break exportPages;
            }
            exportedRows += 1;
        }
        if (!result.pageInfo.hasNextPage || !result.pageInfo.endCursor) break;
        if (exportedRows >= maxRows) {
            moreRows = true;
            break;
        }
        after = result.pageInfo.endCursor;
    }

    const artifact = csvBuilder.finish();
    const limited = artifact.truncatedByBytes || moreRows;
    const truncatedBy = artifact.truncatedByBytes
        ? "bytes"
        : moreRows
            ? "rows"
            : "none";
    const filename = `payment-recovery-${commerceCalendarDateKey(storeTimeZoneOf(c.env))}.csv`;
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
        // Exact up to the list's count cap; above it a lower bound (X-Export-Total-Capped).
        "X-Export-Total-Count": String(counted?.totalIsCapped ? Math.max(counted.total, artifact.rowCount) : counted?.total ?? 0),
        "X-Export-Total-Capped": counted?.totalIsCapped ? "true" : "false",
    });
});

export { app as adminOrderListRoutes };
