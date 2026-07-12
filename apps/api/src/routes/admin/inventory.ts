// src/server/routes/admin/inventory.ts
// Admin OpenAPI routes for inventory.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { getInventoryOverview, adjustInventory, adjustInventorySchema, adjustStock, setStock, lookupByBarcodeOrSku, inventoryOperationKeySchema } from "@scalius/core/modules/inventory";
import { acknowledgeLowStockAlert } from "@scalius/core/modules/inventory/alerts";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses, conflictResponse } from "../../schemas/responses";
import { invalidateProductAvailabilityCaches } from "../../utils/cache-invalidation";
import { nullableTimestampSchema } from "../../schemas/timestamps";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

// ─── Inline response schemas ──

const inventoryVariantSchema = z.object({
    id: z.string(),
    productId: z.string(),
    productName: z.string().nullable(),
    sku: z.string(),
    optionLabel: z.string().nullable(),
    price: z.number(),
    stock: z.number(),
    reservedStock: z.number(),
    available: z.number(),
    lowStockThreshold: z.number().nullable(),
    version: z.number(),
}).passthrough();

const inventoryStatsSchema = z.object({
    totalVariants: z.number(),
    totalOnHand: z.number(),
    totalReserved: z.number(),
    totalAvailable: z.number(),
    outOfStockCount: z.number(),
    lowStockCount: z.number(),
});

const inventoryMovementSchema = z.object({
    id: z.string(),
    variantId: z.string(),
    orderId: z.string().nullable(),
    type: z.string(),
    quantity: z.number(),
    previousStock: z.number(),
    newStock: z.number(),
    notes: z.string().nullable(),
    createdBy: z.string().nullable(),
    ledgerVersion: z.number().int(),
    pool: z.string().nullable(),
    reservationGeneration: z.number().int().nullable(),
    stockVersionBefore: z.number().int().nullable(),
    stockVersionAfter: z.number().int().nullable(),
    stockDelta: z.number().int().nullable(),
    previousReservedStock: z.number().int().nullable(),
    newReservedStock: z.number().int().nullable(),
    reservedStockDelta: z.number().int().nullable(),
    previousPreorderStock: z.number().int().nullable(),
    newPreorderStock: z.number().int().nullable(),
    preorderStockDelta: z.number().int().nullable(),
    createdAt: z.union([z.string(), z.number()]),
    variantSku: z.string().nullable(),
    productName: z.string().nullable(),
}).passthrough();

const inventoryLedgerHealthSchema = z.object({
    legacyRows: z.number().int().nonnegative(),
    v2Rows: z.number().int().nonnegative(),
    v2Variants: z.number().int().nonnegative(),
    invalidV2Rows: z.number().int().nonnegative(),
});

const inventoryAlertSchema = z.object({
    id: z.string(),
    variantId: z.string(),
    productId: z.string(),
    currentQty: z.number(),
    threshold: z.number(),
    alertStatus: z.string(),
    alertSentAt: nullableTimestampSchema,
    acknowledgedAt: nullableTimestampSchema,
    resolvedAt: nullableTimestampSchema,
    createdAt: z.union([z.string(), z.number()]),
    updatedAt: z.union([z.string(), z.number()]),
    productName: z.string().nullable(),
    variantSku: z.string().nullable(),
    variantLabel: z.string().nullable(),
}).passthrough();

// The inventory overview endpoint returns different shapes per section
const inventoryOverviewSchema = z.object({
    variants: z.array(inventoryVariantSchema).optional(),
    movements: z.array(inventoryMovementSchema).optional(),
    alerts: z.array(inventoryAlertSchema).optional(),
    pagination: paginationSchema.optional(),
    stats: inventoryStatsSchema.optional(),
    ledgerHealth: inventoryLedgerHealthSchema.optional(),
}).passthrough();

const adjustResultSchema = z.object({
    variantId: z.string(),
    previousStock: z.number(),
    newStock: z.number(),
    delta: z.number(),
}).passthrough();

const stockAdjustResultSchema = z.object({
    variantId: z.string(),
    previousStock: z.number(),
    newStock: z.number(),
    delta: z.number(),
});

const scannerLookupSchema = z.object({
    variant: z.object({
        id: z.string(),
        sku: z.string(),
        optionLabel: z.string().nullable(),
        price: z.number(),
        stock: z.number(),
        reservedStock: z.number(),
        available: z.number(),
        barcode: z.string().nullable(),
        barcodeType: z.string().nullable(),
        lowStockThreshold: z.number().nullable(),
    }).passthrough(),
    product: z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        price: z.number(),
        isActive: z.boolean(),
        imageUrl: z.string().nullable(),
    }).passthrough(),
});

// ── List Inventory ──

const listRoute = createRoute({
    method: "get",
    path: "/",
    tags: ["Admin - Inventory"],
    summary: "Get inventory overview",
    request: {
        query: z.object({
            section: z.enum(["variants", "movements", "alerts"]).optional().default("variants").openapi({ description: "Section type" }),
            search: z.string().trim().max(120).optional().default("").openapi({ description: "Product, SKU, or order search term" }),
            status: z.enum(["all", "low", "out", "reserved"]).optional().default("all").openapi({ description: "Variant stock status filter" }),
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(100).default(50).openapi({ description: "Items per page" }),
            alertStatus: z.enum(["active", "acknowledged", "resolved", "all"]).optional().openapi({ description: "Alert status filter" }),
            movementType: z.enum(["all", "reserved", "deducted", "released", "adjusted", "restored", "preorder_reserved", "preorder_deducted"]).optional().default("all").openapi({ description: "Movement type filter" }),
            sort: z.enum(["productName", "sku", "available"]).optional().default("available").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
        })
    },
    responses: {
        200: {
            description: "Inventory overview",
            content: { "application/json": { schema: successEnvelope(inventoryOverviewSchema) } },
        },
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    try {
        const result = await getInventoryOverview(db, {
            section: query.section,
            search: query.search,
            status: query.status,
            page: query.page,
            limit: query.limit,
            alertStatus: query.alertStatus,
            movementType: query.movementType,
            sort: query.sort,
            order: query.order,
        });
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Invalid section parameter") {
            throw new ValidationError(error.message);
        }
        throw error;
    }
});

// ── Get Alerts ──

const alertsRoute = createRoute({
    method: "get",
    path: "/alerts",
    tags: ["Admin - Inventory"],
    summary: "Get inventory alerts",
    request: {
        query: z.object({
            status: z.enum(["active", "acknowledged", "resolved", "all"]).optional().default("active").openapi({ description: "Alert status" })
        })
    },
    responses: {
        200: {
            description: "Inventory alerts",
            content: { "application/json": { schema: successEnvelope(z.object({ alerts: z.array(inventoryAlertSchema) })) } },
        },
    }
});

app.openapi(alertsRoute, (async (c: AdminRouteContext<typeof alertsRoute>) => {
    const db = c.get("db");
    const { status } = c.req.valid("query");
    const result = await getInventoryOverview(db, {
        section: "alerts",
        search: "",
        status: "all",
        page: 1,
        limit: 50,
        alertStatus: status
    });
    return ok(c, result);
}) as unknown as AdminRouteHandler<typeof alertsRoute>);

// ── Acknowledge Alert ──

const acknowledgeAlertRoute = createRoute({
    method: "patch",
    path: "/alerts",
    tags: ["Admin - Inventory"],
    summary: "Acknowledge a low stock alert",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        variantId: z.string().openapi({ description: "Variant ID" })
                    })
                }
            }
        }
    },
    responses: {
        200: {
            description: "Alert acknowledged",
            content: { "application/json": { schema: successEnvelope(z.object({})) } },
        },
        404: errorResponses[404],
    }
});

app.openapi(acknowledgeAlertRoute, async (c) => {
    const db = c.get("db");
    const { variantId } = c.req.valid("json");
    const acknowledged = await acknowledgeLowStockAlert(db, variantId);
    if (!acknowledged) {
        throw new NotFoundError("Active low-stock alert not found");
    }
    return ok(c, {});
});

// ── Adjust Inventory ──

const adjustRoute = createRoute({
    method: "post",
    path: "/{variantId}/adjust",
    tags: ["Admin - Inventory"],
    summary: "Adjust inventory for a variant",
    request: {
        params: z.object({ variantId: z.string() }),
        body: { content: { "application/json": { schema: adjustInventorySchema } } }
    },
    responses: {
        200: {
            description: "Inventory adjusted",
            content: { "application/json": { schema: successEnvelope(adjustResultSchema) } },
        },
        404: errorResponses[404],
        409: conflictResponse,
    }
});

app.openapi(adjustRoute, async (c) => {
    const db = c.get("db");
    const { variantId } = c.req.valid("param");
    const payload = c.req.valid("json");
    const user = c.get("user");
    try {
        const result = await adjustInventory(db, variantId, payload, user?.id);
        await invalidateProductAvailabilityCaches(db, { variantIds: [variantId] }, c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Scanner: Barcode/SKU Lookup ──

const scannerLookupRoute = createRoute({
    method: "get",
    path: "/scanner/lookup",
    tags: ["Admin - Inventory"],
    summary: "Look up a product variant by barcode or SKU (scanner workflow)",
    request: {
        query: z.object({
            code: z.string().trim().min(1).max(256).openapi({ description: "Barcode or SKU value to search for" }),
        }),
    },
    responses: {
        200: {
            description: "Variant found with product details and image",
            content: { "application/json": { schema: successEnvelope(scannerLookupSchema) } },
        },
        404: errorResponses[404],
    },
});

app.openapi(scannerLookupRoute, async (c) => {
    const db = c.get("db");
    const { code } = c.req.valid("query");
    const result = await lookupByBarcodeOrSku(db, code);
    if (!result) {
        throw new NotFoundError("No variant found with this barcode or SKU");
    }
    return ok(c, result);
});

// ── Scanner: Stock Adjust (relative) ──

const stockAdjustRoute = createRoute({
    method: "post",
    path: "/stock-adjust",
    tags: ["Admin - Inventory"],
    summary: "Adjust stock by a relative amount (+/-)",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        operationKey: inventoryOperationKeySchema,
                        variantId: z.string().openapi({ description: "Variant ID" }),
                        adjustment: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine((value) => value !== 0, "Adjustment must not be zero.").openapi({ description: "Whole-number stock adjustment (positive=add, negative=remove)" }),
                        reason: z.string().trim().max(500).optional().openapi({ description: "Reason for adjustment" }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Stock adjusted",
            content: { "application/json": { schema: successEnvelope(stockAdjustResultSchema) } },
        },
        404: errorResponses[404],
        409: conflictResponse,
    },
});

app.openapi(stockAdjustRoute, async (c) => {
    const db = c.get("db");
    const { operationKey, variantId, adjustment, reason } = c.req.valid("json");
    const user = c.get("user");
    try {
        const result = await adjustStock(db, variantId, adjustment, operationKey, reason, user?.id);
        await invalidateProductAvailabilityCaches(db, { variantIds: [variantId] }, c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Scanner: Stock Set (absolute) ──

const stockSetRoute = createRoute({
    method: "post",
    path: "/stock-set",
    tags: ["Admin - Inventory"],
    summary: "Set stock to an absolute value (stocktaking)",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        operationKey: inventoryOperationKeySchema,
                        variantId: z.string().openapi({ description: "Variant ID" }),
                        newStock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).openapi({ description: "New absolute whole-number stock value" }),
                        reason: z.string().trim().max(500).optional().openapi({ description: "Reason for stocktake" }),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Stock set",
            content: { "application/json": { schema: successEnvelope(stockAdjustResultSchema) } },
        },
        404: errorResponses[404],
        409: conflictResponse,
    },
});

app.openapi(stockSetRoute, async (c) => {
    const db = c.get("db");
    const { operationKey, variantId, newStock, reason } = c.req.valid("json");
    const user = c.get("user");
    try {
        const result = await setStock(db, variantId, newStock, operationKey, reason, user?.id);
        await invalidateProductAvailabilityCaches(db, { variantIds: [variantId] }, c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

export { app as adminInventoryRoutes };
