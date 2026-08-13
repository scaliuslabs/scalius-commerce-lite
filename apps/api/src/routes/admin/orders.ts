import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import * as OrdersService from "@scalius/core/modules/orders";
import * as ProductsAdmin from "@scalius/core/modules/products/products.admin";
import { loadVariantSelectedOptions } from "@scalius/core/modules/products";
import {
    createOrderSchema,
    quoteManualOrderSchema,
    updateOrderSchema,
    archiveOrdersSchema,
    restoreOrderSchema,
    bulkShipOrderSchema
} from "@scalius/core/modules/orders/orders.validation";
import {
    FulfillmentStatus,
    PaymentMethod,
    PaymentStatus,
    orderPayments,
    paymentPlans,
    orderItems,
    products,
    productVariants,
    media,
    orders,
} from "@scalius/database/schema";
import { eq, sql } from "drizzle-orm";
import { NotFoundError, ServiceUnavailableError } from "../../utils/api-error";
import { ok, created, noContent } from "../../utils/api-response";
import {
    successEnvelope,
    paginatedEnvelope,
    idResponse,
    noContentResponse,
    errorResponses,
    conflictResponse,
    serviceUnavailableResponse,
} from "../../schemas/responses";
import { getCurrentPublicMediaUrl } from "@scalius/core/integrations/storage";
import {
    activeRefundOperationSchema,
    orderDetailSchema,
    orderItemSchema,
    orderPaymentRecoverySchema,
    orderRefundAttemptSchema,
    orderSummarySchema,
    productSummarySchema,
    productVariantSchema,
    selectedProductOptionSchema,
} from "../../schemas/entities";
import { nullableTimestampSchema, timestampSchema } from "../../schemas/timestamps";
import { adminOrdersStatusRoutes } from "./orders-status";
import { adminOrdersRefundRoutes } from "./orders-refund";
import { adminOrdersInvoiceRoutes } from "./orders-invoice";
import { adminOrdersSupportRequestRoutes } from "./orders-support-requests";
import { adminOrdersReturnRoutes } from "./orders-returns";
import { getCredentialEncryptionKey } from "../../utils/encryption-key";
import {
    findCheckoutReservationAvailabilityTransitions,
    invalidateProductAvailabilityCaches,
} from "../../utils/cache-invalidation";
import { parseBangladeshDateOnlyBoundary } from "./order-date-filter";
import { enqueueOrderNotificationsForStatus } from "../../utils/order-notification-queue";
import {
    listOrderPaymentSessionAttempts,
    listOrderRefundAttempts,
    summarizeActiveRefundOperation,
} from "@scalius/core/modules/payments";
import { listPaymentWebhookIssuesForOrder } from "../../utils/payment-webhook-issues";
import {
    listOrderNotificationOutboxForOrder,
    resendTerminalOrderNotificationOutboxById,
    retryFailedOrderNotificationOutboxById,
} from "@scalius/core/modules/notifications";
import type { OrderPaymentRecoveryFilter } from "@scalius/core/modules/orders";
import {
    createOrdersCsvArtifactBuilder,
    createPaymentRecoveryCsvArtifactBuilder,
    ORDER_CSV_ARTIFACT_MAX_BYTES,
} from "@scalius/core/modules/orders/order-csv-export";
import { resolveCanonicalIdempotencyKey } from "./idempotency-key";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];
type OrderListSort = "relevance" | "customerName" | "totalAmount" | "status" | "createdAt" | "updatedAt";

const paymentStatusQuerySchema = z.enum([
    PaymentStatus.UNPAID,
    PaymentStatus.PARTIAL,
    PaymentStatus.PAID,
    PaymentStatus.REFUNDED,
    PaymentStatus.FAILED,
]);

const paymentMethodQuerySchema = z.enum([
    PaymentMethod.COD,
    PaymentMethod.STRIPE,
    PaymentMethod.SSLCOMMERZ,
    PaymentMethod.POLAR,
]);

const fulfillmentStatusQuerySchema = z.enum([
    FulfillmentStatus.PENDING,
    FulfillmentStatus.PARTIAL,
    FulfillmentStatus.COMPLETE,
]);

const paymentRecoveryQuerySchema = z.enum([
    "recoverable",
    "awaiting_payment",
    "processing",
    "needs_attention",
]);

const manualOrderRequestKeySchema = z.uuid("A valid manual-order request key is required");
const manualOrderIdempotencyHeadersSchema = z.object({
    "idempotency-key": manualOrderRequestKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.requestKey; if both are sent they must match.",
    }),
});
const createOrderRequestSchema = createOrderSchema.extend({
    requestKey: manualOrderRequestKeySchema.optional(),
});

const recoveryLinkPaymentTypeSchema = z.enum(["full", "deposit", "balance"]);

const ORDER_EXPORT_MAX_ROWS = 5_000;
const ORDER_EXPORT_PAGE_SIZE = 100;
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

function resolveStorefrontUrl(env: Env): URL {
    const configuredUrl = env.STOREFRONT_URL?.trim();
    if (!configuredUrl) {
        throw new ServiceUnavailableError("Storefront URL is not configured.");
    }

    try {
        const url = new URL(configuredUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            throw new Error("Unsupported storefront URL protocol");
        }
        return url;
    } catch {
        throw new ServiceUnavailableError("Storefront URL is invalid.");
    }
}

function buildPaymentRecoveryUrl(
    storefrontUrl: URL,
    result: OrdersService.OrderPaymentRecoveryPreview,
): string {
    const url = new URL("/payment-recovery", storefrontUrl);
    url.searchParams.set("orderId", result.orderId);
    url.searchParams.set("payment", result.gateway);
    url.searchParams.set("result", "failed");
    if (result.paymentType) url.searchParams.set("paymentType", result.paymentType);
    if (typeof result.depositAmount === "number" && Number.isFinite(result.depositAmount)) {
        url.searchParams.set("depositAmount", String(result.depositAmount));
    }
    return url.toString();
}

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

const adminWriteErrorResponses = {
    400: errorResponses[400],
    401: errorResponses[401],
    403: errorResponses[403],
} as const;

const adminOrderResourceMutationErrorResponses = {
    ...adminWriteErrorResponses,
    404: errorResponses[404],
    409: conflictResponse,
} as const;

// Mount sub-routers
app.route("/", adminOrdersStatusRoutes);
app.route("/", adminOrdersRefundRoutes);
app.route("/", adminOrdersInvoiceRoutes);
app.route("/", adminOrdersSupportRequestRoutes);
app.route("/", adminOrdersReturnRoutes);

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

const paymentWebhookIssueSchema = z.object({
    id: z.string(),
    provider: z.string(),
    eventType: z.string(),
    status: z.enum(["failed", "manual_reconciliation"]),
    message: z.string(),
    error: z.string().nullable(),
    queueType: z.string().nullable(),
    queueMessageId: z.string().nullable(),
    processedAt: timestampSchema,
});

const paymentSessionAttemptSchema = z.object({
    id: z.string(),
    orderId: z.string(),
    gateway: z.string(),
    paymentType: z.string(),
    amount: z.number(),
    currency: z.string(),
    status: z.string(),
    attempts: z.number(),
    providerSessionId: z.string().nullable(),
    providerCorrelationId: z.string().nullable(),
    lastError: z.string().nullable(),
    claimExpiresAt: nullableTimestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    activeProcessing: z.boolean(),
    staleProcessing: z.boolean(),
});

const paymentRecoveryLinkResponseSchema = successEnvelope(z.object({
    orderId: z.string(),
    url: z.string().url(),
    expiresAt: timestampSchema.nullable(),
    accessMode: z.literal("buyer_verified_receipt"),
    note: z.string(),
    gateway: z.enum(["sslcommerz", "polar"]),
    paymentType: recoveryLinkPaymentTypeSchema.nullable(),
    depositAmount: z.number().nullable(),
    paymentRecovery: orderPaymentRecoverySchema,
}));

const orderFormDataSchema = z.object({
    id: z.string(),
    version: z.number().int().min(1),
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

const orderFullEditReadinessSchema = z.object({
    allowed: z.boolean(),
    reason: z.string().nullable(),
});

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
    isActive: z.boolean(),
    deletedAt: nullableTimestampSchema,
    discountPercentage: z.number().nullable(),
    discountType: z.string().nullable(),
    discountAmount: z.number().nullable(),
    variants: z.array(productVariantSchema.extend({
        selectedOptions: z.array(selectedProductOptionSchema),
    })),
}).passthrough();

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
                    schema: paginatedEnvelope("products", productSummarySchema),
                },
            },
        },
        ...errorResponses,
    },
});

app.openapi(catalogProductsRoute, async (c) => {
    const query = c.req.valid("query");
    const result = await ProductsAdmin.listProducts(c.get("db"), {
        page: query.page,
        limit: query.limit,
        search: query.search || undefined,
        activeOnly: true,
        sort: "name",
        order: "asc",
        agentSummary: true,
    });
    return ok(c, result);
});

// ─── GET / (List) ────────────────────────────────────────────────────────────

const listOrdersRoute = createRoute({
    operationId: "dashboard.orders.list",
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
            statusGroup: z.enum(["open", "in_transit", "delivered", "closed"])
                .optional()
                .openapi({ description: "Filter by order lifecycle view" }),
            paymentStatus: paymentStatusQuerySchema.optional().openapi({ description: "Filter by payment status" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment method" }),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional().openapi({ description: "Filter by fulfillment status" }),
            paymentRecovery: paymentRecoveryQuerySchema.optional().openapi({ description: "Filter by hosted-payment recovery state" }),
            archived: z.enum(["true", "false"]).optional().openapi({ description: "Show archived orders" }),
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
        statusGroup: query.statusGroup,
        paymentStatus: query.paymentStatus,
        paymentMethod: query.paymentMethod,
        fulfillmentStatus: query.fulfillmentStatus,
        paymentRecovery: query.paymentRecovery,
        showArchived: query.archived === "true",
        sort: effectiveSort,
        order: query.order as "asc" | "desc",
        startDate: parseBangladeshDateOnlyBoundary(query.startDate, "start"),
        endDate: parseBangladeshDateOnlyBoundary(query.endDate, "end")
    });
    return ok(c, result);
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
            statusGroup: z.enum(["open", "in_transit", "delivered", "closed"]).optional(),
            paymentStatus: paymentStatusQuerySchema.optional(),
            paymentMethod: paymentMethodQuerySchema.optional(),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional(),
            paymentRecovery: paymentRecoveryQuerySchema.optional(),
            archived: z.enum(["true", "false"]).optional(),
            sort: z.enum([
                "relevance", "customerName", "totalAmount", "status", "createdAt", "updatedAt",
            ]).optional(),
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
    const maxRows = Math.min(query.maxRows, ORDER_EXPORT_MAX_ROWS);
    const effectiveSort: OrderListSort = query.sort
        ?? (query.search?.trim() ? "relevance" : "updatedAt");
    const csvBuilder = createOrdersCsvArtifactBuilder();
    let exportedRows = 0;
    let page = 1;
    let total = 0;

    exportPages: while (exportedRows < maxRows) {
        const result = await OrdersService.listOrders(c.get("db"), {
            page,
            limit: Math.min(ORDER_EXPORT_PAGE_SIZE, maxRows - exportedRows),
            search: query.search || "",
            status: query.status || undefined,
            statusGroup: query.statusGroup,
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
        for (const order of result.orders) {
            if (!csvBuilder.append(order)) break exportPages;
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
    const filename = `orders-${new Date().toISOString().slice(0, 10)}.csv`;
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
    request: {
        query: z.object({
            page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().max(100).optional().default(20).openapi({ description: "Items per page" }),
            search: z.string().optional().openapi({ description: "Search query" }),
            state: paymentRecoveryQuerySchema.optional().default("recoverable").openapi({ description: "Hosted-payment recovery state" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment gateway" }),
            sort: z.enum([
                "relevance",
                "customerName",
                "totalAmount",
                "status",
                "createdAt",
                "updatedAt",
            ]).optional().openapi({ description: "Sort field" }),
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
    const result = await OrdersService.listOrders(db, {
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
    return ok(c, result);
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
            statusGroup: z.enum(["open", "in_transit", "delivered", "closed"])
                .optional()
                .openapi({ description: "Filter by order lifecycle view" }),
            paymentStatus: paymentStatusQuerySchema.optional().openapi({ description: "Filter by payment status" }),
            paymentMethod: paymentMethodQuerySchema.optional().openapi({ description: "Filter by payment gateway" }),
            fulfillmentStatus: fulfillmentStatusQuerySchema.optional().openapi({ description: "Filter by fulfillment status" }),
            archived: z.enum(["true", "false"]).optional().openapi({ description: "Show archived orders" }),
            sort: z.enum([
                "relevance",
                "customerName",
                "totalAmount",
                "status",
                "createdAt",
                "updatedAt",
            ]).optional().openapi({ description: "Sort field" }),
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
        const result = await OrdersService.listOrders(db, {
            page,
            limit: Math.min(PAYMENT_RECOVERY_EXPORT_PAGE_SIZE, maxRows - exportedRows),
            search: query.search || "",
            status: query.status || undefined,
            statusGroup: query.statusGroup,
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
            if (!csvBuilder.append(order)) break exportPages;
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
    const filename = `payment-recovery-${new Date().toISOString().slice(0, 10)}.csv`;
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

// ─── POST / (Create) ────────────────────────────────────────────────────────

const manualOrderQuoteSchema = z.object({
    currencyCode: z.string(),
    decimalPlaces: z.number().int().min(0).max(3),
    subtotalAmount: z.number().nonnegative(),
    shippingAmount: z.number().nonnegative(),
    discountAmount: z.number().nonnegative(),
    taxAmount: z.number().nonnegative(),
    totalAmount: z.number().nonnegative(),
    taxLabel: z.string(),
    pricesIncludeTax: z.boolean(),
    taxEnabled: z.boolean(),
    settingsVersion: z.number().int().nonnegative(),
    lines: z.array(z.object({
        index: z.number().int().nonnegative(),
        productId: z.string(),
        variantId: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: z.number().nonnegative(),
        lineSubtotal: z.number().nonnegative(),
    })),
});

const quoteManualOrderRoute = createRoute({
    operationId: "dashboard.orders.quote",
    method: "post",
    path: "/quote",
    tags: ["Admin - Orders"],
    summary: "Preview authoritative money and tax for a manual order",
    request: {
        body: { content: { "application/json": { schema: quoteManualOrderSchema } } },
    },
    responses: {
        200: {
            description: "Authoritative manual-order quote",
            content: { "application/json": { schema: successEnvelope(manualOrderQuoteSchema) } },
        },
        ...errorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(quoteManualOrderRoute, async (c) => {
    const quote = await OrdersService.quoteManualOrder(c.get("db"), c.req.valid("json"));
    return ok(c, quote);
});

const createOrderRoute = createRoute({
    operationId: "dashboard.orders.create",
    method: "post",
    path: "/",
    tags: ["Admin - Orders"],
    summary: "Create a new order (admin)",
    request: {
        headers: manualOrderIdempotencyHeadersSchema,
        body: { required: true, content: { "application/json": { schema: createOrderRequestSchema } } }
    },
    responses: {
        201: {
            description: "Order created",
            content: { "application/json": { schema: idResponse } },
        },
        ...adminWriteErrorResponses,
        503: serviceUnavailableResponse,
    }
});

app.openapi(createOrderRoute, async (c) => {
    const db = c.get("db");
    const { requestKey: bodyRequestKey, ...payload } = c.req.valid("json");
    const requestKey = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyRequestKey,
        "requestKey",
    );
    const data = { ...payload, requestKey };
    const user = c.get("user") as { id?: string } | undefined;
    const result = await OrdersService.createOrder(db, data, user?.id ?? null);
    const availabilityTransitionVariantIds =
        await findCheckoutReservationAvailabilityTransitions(
            db,
            data.items.flatMap((item) =>
                item.variantId && item.quantity > 0
                    ? [{ variantId: item.variantId, quantity: item.quantity }]
                    : [],
            ),
        );
    if (availabilityTransitionVariantIds.length > 0) {
        await invalidateProductAvailabilityCaches(
            db,
            { variantIds: availabilityTransitionVariantIds },
            c,
        );
    }
    return created(c, result);
});

// ─── POST /archive ───────────────────────────────────────────────────────────

const archiveOrdersRoute = createRoute({
    operationId: "dashboard.orders.archive",
    method: "post",
    path: "/archive",
    tags: ["Admin - Orders"],
    summary: "Archive completed orders without changing commerce state",
    request: {
        body: { content: { "application/json": { schema: archiveOrdersSchema } } }
    },
    responses: {
        204: noContentResponse,
        ...adminWriteErrorResponses,
        409: conflictResponse,
    }
});

app.openapi(archiveOrdersRoute, async (c) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    await OrdersService.archiveOrders(db, data.orders);
    return noContent(c);
});

// ─── POST /bulk-ship ─────────────────────────────────────────────────────────

const bulkShipRoute = createRoute({
    operationId: "dashboard.orders.bulk_ship",
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
        ...adminWriteErrorResponses,
    }
});

app.openapi(bulkShipRoute, (async (c: AdminRouteContext<typeof bulkShipRoute>) => {
    const db = c.get("db");
    const data = c.req.valid("json");
    const encryptionKey = getCredentialEncryptionKey(c.env as Record<string, unknown>);
    const results = await OrdersService.bulkShipOrders(db, data.orderIds, data.providerId, data.options, encryptionKey);
    const successCount = results.filter((r) => r.success).length;
    const newlyShippedResults = results.filter(isNewShipmentResult);
    const availabilityTransitionVariantIds = results.flatMap((result) =>
        "availabilityTransitionVariantIds" in result
        && Array.isArray(result.availabilityTransitionVariantIds)
            ? result.availabilityTransitionVariantIds
            : [],
    );
    if (availabilityTransitionVariantIds.length > 0) {
        await invalidateProductAvailabilityCaches(
            db,
            { variantIds: availabilityTransitionVariantIds },
            c,
        );
    }
    const responseResults = results.map((result) => {
        const {
            availabilityTransitionVariantIds: _internalCacheSignal,
            ...responseResult
        } = result as typeof result & { availabilityTransitionVariantIds?: string[] };
        return responseResult;
    });

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
        results: responseResults,
    });
}) as unknown as AdminRouteHandler<typeof bulkShipRoute>);

// ─── POST /:id/payment-recovery-link ─────────────────────────────────────────

const createPaymentRecoveryLinkRoute = createRoute({
    operationId: "dashboard.orders.payment_recovery_link",
    method: "post",
    path: "/{id}/payment-recovery-link",
    tags: ["Admin - Orders"],
    summary: "Issue a hosted-payment receipt recovery link",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        201: {
            description: "Hosted-payment recovery link issued",
            content: { "application/json": { schema: paymentRecoveryLinkResponseSchema } },
        },
        ...adminOrderResourceMutationErrorResponses,
        503: serviceUnavailableResponse,
    },
});

app.openapi(createPaymentRecoveryLinkRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const storefrontUrl = resolveStorefrontUrl(c.env);
    const recoveryLink = await OrdersService.previewOrderPaymentRecoveryLink(db, orderId);
    const url = buildPaymentRecoveryUrl(storefrontUrl, recoveryLink);

    return created(c, {
        orderId: recoveryLink.orderId,
        url,
        expiresAt: null,
        accessMode: "buyer_verified_receipt" as const,
        note: "This clean recovery URL contains no private receipt proof. The buyer must verify the order contact before this browser receives receipt access.",
        gateway: recoveryLink.gateway,
        paymentType: recoveryLink.paymentType,
        depositAmount: recoveryLink.depositAmount,
        paymentRecovery: recoveryLink.paymentRecovery,
    });
});

// ─── GET /:id ────────────────────────────────────────────────────────────────

const getOrderRoute = createRoute({
    operationId: "dashboard.orders.get",
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
    operationId: "dashboard.orders.update",
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
        ...adminOrderResourceMutationErrorResponses,
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
    if (
        Array.isArray(result.inventoryMutationVariantIds)
        && result.inventoryMutationVariantIds.length > 0
    ) {
        await invalidateProductAvailabilityCaches(
            db,
            { variantIds: result.inventoryMutationVariantIds },
            c,
        );
    }
    return ok(c, { id: result.id });
});

// ─── POST /:id/restore ──────────────────────────────────────────────────────

const restoreOrderRoute = createRoute({
    operationId: "dashboard.orders.restore",
    method: "post",
    path: "/{id}/restore",
    tags: ["Admin - Orders"],
    summary: "Restore an archived order to the active workspace",
    request: {
        params: z.object({ id: z.string() }),
        body: { content: { "application/json": { schema: restoreOrderSchema } } },
    },
    responses: {
        204: noContentResponse,
        ...adminOrderResourceMutationErrorResponses,
    }
});

app.openapi(restoreOrderRoute, async (c) => {
    const db = c.get("db");
    const orderId = c.req.valid("param").id;
    const data = c.req.valid("json");
    await OrdersService.restoreOrder(db, orderId, data.expectedVersion);
    return noContent(c);
});

// ─── GET /:id/items ──────────────────────────────────────────────────────────

const getItemsRoute = createRoute({
    operationId: "dashboard.orders.items",
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
            productName: orderItems.productName,
            productImageObjectKey: media.objectKey,
            productImageStatus: media.status,
            variantId: orderItems.variantId,
            variantLabel: orderItems.variantLabel,
            quantity: orderItems.quantity,
            price: orderItems.price,
            fulfillmentStatus: orderItems.fulfillmentStatus,
            unitPriceMinor: orderItems.unitPriceMinor,
            lineSubtotalMinor: orderItems.lineSubtotalMinor,
            discountAmountMinor: orderItems.discountAmountMinor,
            taxableAmountMinor: orderItems.taxableAmountMinor,
            taxAmountMinor: orderItems.taxAmountMinor,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId))
        .leftJoin(media, eq(orderItems.productImageMediaId, media.id));

    return ok(c, items.map(({ productImageObjectKey, productImageStatus, ...item }) => ({
        ...item,
        productImage:
            productImageObjectKey &&
            (productImageStatus === "ready" || productImageStatus === "trashed")
                ? getCurrentPublicMediaUrl(productImageObjectKey)
                : null,
    })));
});

// ─── GET /:id/payments ───────────────────────────────────────────────────────

const getPaymentsRoute = createRoute({
    operationId: "dashboard.orders.payments",
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
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        payments: z.array(orderPaymentSchema),
                        plan: paymentPlanSchema,
                        refundAttempts: z.array(orderRefundAttemptSchema),
                        activeRefundOperation: activeRefundOperationSchema.nullable(),
                        paymentWebhookIssues: z.array(paymentWebhookIssueSchema),
                        paymentSessionAttempts: z.array(paymentSessionAttemptSchema),
                    })),
                },
            },
        },
    }
});

app.openapi(getPaymentsRoute, (async (c: AdminRouteContext<typeof getPaymentsRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");

    const [payments, plan, refundAttemptViews, paymentWebhookIssues, paymentSessionAttemptViews] = await Promise.all([
        db.select({
            id: orderPayments.id,
            orderId: orderPayments.orderId,
            amount: orderPayments.amount,
            currency: orderPayments.currency,
            paymentMethod: orderPayments.paymentMethod,
            paymentType: orderPayments.paymentType,
            status: orderPayments.status,
            stripePaymentIntentId: orderPayments.stripePaymentIntentId,
            stripeChargeId: orderPayments.stripeChargeId,
            sslcommerzTranId: orderPayments.sslcommerzTranId,
            sslcommerzValId: orderPayments.sslcommerzValId,
            sslcommerzBankTranId: orderPayments.sslcommerzBankTranId,
            polarCheckoutId: orderPayments.polarCheckoutId,
            codCollectedBy: orderPayments.codCollectedBy,
            codCollectedAt: orderPayments.codCollectedAt,
            codReceiptUrl: orderPayments.codReceiptUrl,
            createdAt: orderPayments.createdAt,
            updatedAt: orderPayments.updatedAt,
        }).from(orderPayments).where(eq(orderPayments.orderId, orderId)).all(),
        db.select().from(paymentPlans).where(eq(paymentPlans.orderId, orderId)).get(),
        listOrderRefundAttempts(db, orderId, { audience: "admin" }),
        listPaymentWebhookIssuesForOrder(db, orderId),
        listOrderPaymentSessionAttempts(db, orderId),
    ]);

    return ok(c, {
        payments,
        plan: plan ?? null,
        refundAttempts: refundAttemptViews,
        activeRefundOperation: summarizeActiveRefundOperation(refundAttemptViews, "admin"),
        paymentWebhookIssues,
        paymentSessionAttempts: paymentSessionAttemptViews,
    });
}) as unknown as AdminRouteHandler<typeof getPaymentsRoute>);

// ─── GET /:id/notifications ────────────────────────────────────────────────

const orderNotificationReceiptSchema = z.object({
    id: z.string(),
    receiptKey: z.string(),
    channel: z.string(),
    provider: z.string(),
    recipientMasked: z.string().nullable(),
    status: z.string(),
    providerMessageId: z.string().nullable(),
    providerStatus: z.string().nullable(),
    attempts: z.number(),
    nextAttemptAt: timestampSchema.nullable(),
    lastAttemptAt: timestampSchema.nullable(),
    lastError: z.string().nullable(),
    acceptedAt: timestampSchema.nullable(),
    deliveredAt: timestampSchema.nullable(),
    failedAt: timestampSchema.nullable(),
    skippedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});

const orderNotificationOutboxSchema = z.object({
    id: z.string(),
    dedupeKey: z.string(),
    orderId: z.string(),
    notificationType: z.string(),
    source: z.string(),
    status: z.string(),
    attempts: z.number(),
    nextAttemptAt: timestampSchema,
    lastError: z.string().nullable(),
    queuedAt: timestampSchema.nullable(),
    sentAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    receipts: z.array(orderNotificationReceiptSchema),
});

const getNotificationsRoute = createRoute({
    operationId: "dashboard.orders.notifications",
    method: "get",
    path: "/{id}/notifications",
    tags: ["Admin - Orders"],
    summary: "Get order notification delivery history",
    request: {
        params: z.object({ id: z.string() }),
    },
    responses: {
        200: {
            description: "Order notification history",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        notifications: z.array(orderNotificationOutboxSchema),
                    })),
                },
            },
        },
    },
});

app.openapi(getNotificationsRoute, (async (c: AdminRouteContext<typeof getNotificationsRoute>) => {
    const orderId = c.req.valid("param").id;
    const db = c.get("db");
    const notifications = await listOrderNotificationOutboxForOrder(db, orderId);
    return ok(c, { notifications });
}) as unknown as AdminRouteHandler<typeof getNotificationsRoute>);

// ─── POST /:id/notifications/:outboxId/retry ───────────────────────────────

const retryNotificationRoute = createRoute({
    operationId: "dashboard.orders.notification_retry",
    method: "post",
    path: "/{id}/notifications/{outboxId}/retry",
    tags: ["Admin - Orders"],
    summary: "Retry a failed order notification",
    request: {
        params: z.object({ id: z.string(), outboxId: z.string() }),
    },
    responses: {
        200: {
            description: "Retry result",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        outboxId: z.string(),
                        dedupeKey: z.string(),
                        created: z.boolean(),
                        enqueued: z.boolean(),
                        skippedReason: z.string().optional(),
                    })),
                },
            },
        },
    },
});

app.openapi(retryNotificationRoute, (async (c: AdminRouteContext<typeof retryNotificationRoute>) => {
    const { id: orderId, outboxId } = c.req.valid("param");
    const db = c.get("db");
    const result = await retryFailedOrderNotificationOutboxById({
        db,
        queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
        orderId,
        outboxId,
    });
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof retryNotificationRoute>);

// ─── POST /:id/notifications/:outboxId/resend ──────────────────────────────

const resendNotificationBodySchema = z.object({
    resendRequestId: z.string().trim().min(1).max(128).optional(),
});
const resendNotificationRequestIdSchema = z.string().trim().min(1).max(128);
const resendNotificationIdempotencyHeadersSchema = z.object({
    "idempotency-key": resendNotificationRequestIdSchema.optional().openapi({
        description: "Standard retry key. May replace body.resendRequestId; if both are sent they must match.",
    }),
});

const resendNotificationRoute = createRoute({
    operationId: "dashboard.orders.notification_resend",
    method: "post",
    path: "/{id}/notifications/{outboxId}/resend",
    tags: ["Admin - Orders"],
    summary: "Manually resend an already-sent order notification",
    request: {
        params: z.object({ id: z.string(), outboxId: z.string() }),
        headers: resendNotificationIdempotencyHeadersSchema,
        body: { required: true, content: { "application/json": { schema: resendNotificationBodySchema } } },
    },
    responses: {
        200: {
            description: "Manual resend result",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        outboxId: z.string(),
                        dedupeKey: z.string(),
                        created: z.boolean(),
                        enqueued: z.boolean(),
                        skippedReason: z.string().optional(),
                    })),
                },
            },
        },
    },
});

app.openapi(resendNotificationRoute, (async (c: AdminRouteContext<typeof resendNotificationRoute>) => {
    const { id: orderId, outboxId } = c.req.valid("param");
    const { resendRequestId: bodyResendRequestId } = c.req.valid("json");
    const resendRequestId = resolveCanonicalIdempotencyKey(
        c.req.valid("header")["idempotency-key"],
        bodyResendRequestId,
        "resendRequestId",
    );
    const db = c.get("db");
    const result = await resendTerminalOrderNotificationOutboxById({
        db,
        queue: c.env.ORDER_NOTIFICATIONS_QUEUE,
        orderId,
        outboxId,
        resendRequestId,
    });
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof resendNotificationRoute>);

// ─── GET /:id/form-data ──────────────────────────────────────────────────────

const getFormDataRoute = createRoute({
    operationId: "dashboard.orders.form_data",
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
                        fullEditReadiness: orderFullEditReadinessSchema,
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
            version: orders.version,
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

    let fullEditReadiness = await OrdersService.getAdminOrderFullEditReadiness(db, orderId);
    if (!fullEditReadiness) throw new NotFoundError("Order not found");

    const items = await db
        .select({
            id: orderItems.id,
            productId: orderItems.productId,
            variantId: orderItems.variantId,
            quantity: orderItems.quantity,
            price: orderItems.price,
            productName: orderItems.productName,
            variantLabel: orderItems.variantLabel,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));

    // The edit payload contains only the exact catalog identities already on
    // the order. New item discovery is independently paginated by
    // /catalog-products, so this read stays bounded by the order rather than
    // growing with the merchant's entire catalog.
    const orderProductIds = [...new Set(items.map((item) => item.productId).filter(Boolean))];
    const orderVariantIds = [...new Set(items.map((item) => item.variantId).filter((id): id is string => Boolean(id)))];
    const allProducts = orderProductIds.length > 0
        ? await db
            .select({
                id: products.id,
                name: products.name,
                price: products.price,
                isActive: products.isActive,
                deletedAt: products.deletedAt,
                discountPercentage: products.discountPercentage,
                discountType: products.discountType,
                discountAmount: products.discountAmount,
            })
            .from(products)
            .where(sql`${products.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(orderProductIds)})
            )`)
        : [];
    const allVariants = orderVariantIds.length > 0
        ? await db
            .select()
            .from(productVariants)
            .where(sql`${productVariants.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(orderVariantIds)})
            )`)
        : [];

    const selectedOptionsByVariant = await loadVariantSelectedOptions(
        db,
        allVariants.map((variant) => variant.id),
    );
    const variantsWithOptions = allVariants.map((variant) => ({
        ...variant,
        selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
    }));
    const variantsByProductId = new Map<
        string,
        Array<(typeof variantsWithOptions)[number]>
    >();
    for (const variant of variantsWithOptions) {
        const existing = variantsByProductId.get(variant.productId) ?? [];
        existing.push(variant);
        variantsByProductId.set(variant.productId, existing);
    }

    if (fullEditReadiness.allowed) {
        const productById = new Map(allProducts.map((product) => [product.id, product]));
        const variantById = new Map(allVariants.map((variant) => [variant.id, variant]));
        const hasUnavailableOriginalLine = items.some((item) => {
            const product = productById.get(item.productId);
            const variant = item.variantId ? variantById.get(item.variantId) : null;
            return !product
                || !product.isActive
                || Boolean(product.deletedAt)
                || !variant
                || variant.productId !== item.productId
                || Boolean(variant.deletedAt);
        });
        if (hasUnavailableOriginalLine) {
            fullEditReadiness = {
                allowed: false,
                reason: "One or more original SKUs are no longer active. The historical order remains viewable, but its contents cannot be safely rewritten.",
            };
        }
    }

    const productsWithVariants = allProducts.map((product) => ({
        ...product,
        variants: variantsByProductId.get(product.id) ?? [],
    }));

    return ok(c, {
        order,
        fullEditReadiness,
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
