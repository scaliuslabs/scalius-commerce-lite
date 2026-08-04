// src/server/routes/admin/inventory.ts
// Admin OpenAPI routes for inventory.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { stream } from "hono/streaming";
import { getInventoryOverview, getInventoryLabelVariants, listInventoryMovements, adjustInventory, adjustInventorySchema, adjustStock, setStock, lookupByBarcodeOrSku, inventoryOperationKeySchema, INVENTORY_LABEL_VARIANT_LIMIT } from "@scalius/core/modules/inventory";
import { acknowledgeLowStockAlert } from "@scalius/core/modules/inventory/alerts";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses, conflictResponse } from "../../schemas/responses";
import {
    findStockMutationAvailabilityTransitions,
    invalidateProductAvailabilityCaches,
} from "../../utils/cache-invalidation";
import { nullableTimestampSchema } from "../../schemas/timestamps";
import { parseBangladeshDateOnlyBoundary } from "./order-date-filter";

const app = new OpenAPIHono<{ Bindings: Env }>();
const INVENTORY_MOVEMENT_EXPORT_MAX_ROWS = 5_000;
const INVENTORY_MOVEMENT_EXPORT_PAGE_SIZE = 100;

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

async function invalidateStockMutationIfVisible(
    db: Parameters<typeof findStockMutationAvailabilityTransitions>[0],
    result: {
        variantId: string;
        previousStock: number;
        newStock: number;
        pool?: "stock" | "preorderStock";
    },
    c: Parameters<typeof invalidateProductAvailabilityCaches>[2],
): Promise<void> {
    const variantIds = await findStockMutationAvailabilityTransitions(db, [result]);
    if (variantIds.length > 0) {
        await invalidateProductAvailabilityCaches(db, { variantIds }, c);
    }
}

// ─── Inline response schemas ──

const inventoryVariantSchema = z.object({
    id: z.string(),
    productId: z.string(),
    productName: z.string().nullable(),
    sku: z.string(),
    barcode: z.string().nullable(),
    barcodeType: z.string().nullable(),
    optionLabel: z.string().nullable(),
    price: z.number(),
    effectivePrice: z.number(),
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
    actorName: z.string(),
    actorType: z.enum(["system", "admin", "former_admin"]),
}).passthrough();

const inventoryMovementPageInfoSchema = z.object({
    limit: z.number().int().min(1).max(100),
    hasMore: z.boolean(),
    nextCursor: z.string().nullable(),
});

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
    pageInfo: inventoryMovementPageInfoSchema.optional(),
}).passthrough();

function movementCsvCell(value: unknown): string {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
}

function movementTimestampIso(value: string | number | Date): string {
    const date = value instanceof Date
        ? value
        : new Date(typeof value === "number" && value < 10_000_000_000 ? value * 1_000 : value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function inventoryMovementCsvRow(movement: Awaited<ReturnType<typeof listInventoryMovements>>["movements"][number]): string {
    return [
        movementTimestampIso(movement.createdAt),
        movement.id,
        movement.type,
        movement.variantSku,
        movement.productName,
        movement.orderId,
        movement.actorName,
        movement.pool,
        movement.reservationGeneration,
        movement.stockDelta,
        movement.previousStock,
        movement.newStock,
        movement.reservedStockDelta,
        movement.previousReservedStock,
        movement.newReservedStock,
        movement.preorderStockDelta,
        movement.previousPreorderStock,
        movement.newPreorderStock,
        movement.notes,
    ].map(movementCsvCell).join(",");
}

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
        imageMediaId: z.string().nullable(),
    }).passthrough(),
});

const inventoryLabelVariantSchema = z.object({
    id: z.string(),
    productId: z.string(),
    productName: z.string(),
    sku: z.string(),
    optionLabel: z.string().nullable(),
    price: z.number(),
    effectivePrice: z.number(),
    stock: z.number().int(),
    reservedStock: z.number().int(),
    available: z.number().int(),
    barcode: z.string().nullable(),
    barcodeType: z.string().nullable(),
    trackInventory: z.boolean(),
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
            search: z.string().trim().max(120).optional().default("").openapi({ description: "Product or SKU search term" }),
            status: z.enum(["all", "low", "out", "reserved"]).optional().default("all").openapi({ description: "Variant stock status filter" }),
            page: z.coerce.number().int().min(1).default(1).openapi({ description: "Page number" }),
            limit: z.coerce.number().int().min(1).max(100).default(50).openapi({ description: "Items per page" }),
            alertStatus: z.enum(["active", "acknowledged", "resolved", "all"]).optional().openapi({ description: "Alert status filter" }),
            movementType: z.enum(["all", "reserved", "deducted", "released", "adjusted", "restored", "preorder_reserved", "preorder_deducted"]).optional().default("all").openapi({ description: "Movement type filter" }),
            movementOrderId: z.string().trim().max(100).optional().openapi({ description: "Exact order ID filter for movements" }),
            movementStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "Movement start date (YYYY-MM-DD, Bangladesh calendar day)" }),
            movementEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "Movement end date (YYYY-MM-DD, Bangladesh calendar day)" }),
            movementCursor: z.string().max(512).optional().openapi({ description: "Opaque cursor for the next movement page" }),
            movementHealthOnly: z.enum(["true"]).optional().openapi({ description: "Return only ledger health diagnostics" }),
            format: z.enum(["json", "csv"]).optional().default("json").openapi({ description: "Response format; CSV is supported for movement history" }),
            maxRows: z.coerce.number().int().min(1).max(INVENTORY_MOVEMENT_EXPORT_MAX_ROWS).optional().default(1_000).openapi({ description: "Maximum CSV rows, hard-capped at 5000" }),
            sort: z.enum(["productName", "sku", "available"]).optional().default("available").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
        })
    },
    responses: {
        200: {
            description: "Inventory overview",
            content: {
                "application/json": { schema: successEnvelope(inventoryOverviewSchema) },
                "text/csv": { schema: z.string() },
            },
        },
    }
});

app.openapi(listRoute, async (c) => {
    const db = c.get("db");
    const query = c.req.valid("query");
    try {
        const movementStartDate = parseBangladeshDateOnlyBoundary(query.movementStartDate, "start");
        const movementEndDate = parseBangladeshDateOnlyBoundary(query.movementEndDate, "end");
        if (query.movementStartDate && !movementStartDate) throw new ValidationError("Invalid movement start date");
        if (query.movementEndDate && !movementEndDate) throw new ValidationError("Invalid movement end date");
        if (movementStartDate && movementEndDate && movementStartDate > movementEndDate) {
            throw new ValidationError("Movement start date must not be after end date");
        }

        if (query.format === "csv") {
            if (query.section !== "movements") {
                throw new ValidationError("CSV export is available only for inventory movements");
            }
            const filename = `inventory-movements-${new Date().toISOString().slice(0, 10)}.csv`;
            c.header("Content-Disposition", `attachment; filename="${filename}"`);
            c.header("Content-Type", "text/csv; charset=utf-8");
            c.header("Cache-Control", "private, no-store");
            c.header("X-Content-Type-Options", "nosniff");
            c.header("X-Export-Max-Rows", String(query.maxRows));
            return stream(c, async (stream) => {
                await stream.write([
                    "Timestamp", "Movement ID", "Type", "SKU", "Product", "Order ID", "Actor",
                    "Pool", "Generation", "Stock delta", "Stock before", "Stock after",
                    "Reserved delta", "Reserved before", "Reserved after", "Preorder delta",
                    "Preorder before", "Preorder after", "Notes",
                ].map(movementCsvCell).join(",") + "\n");

                let cursor: string | undefined;
                let written = 0;
                while (!stream.aborted && written < query.maxRows) {
                    const result = await listInventoryMovements(db, {
                        search: query.search,
                        movementType: query.movementType,
                        orderId: query.movementOrderId,
                        startDate: movementStartDate,
                        endDate: movementEndDate,
                        cursor,
                        limit: Math.min(INVENTORY_MOVEMENT_EXPORT_PAGE_SIZE, query.maxRows - written),
                    });
                    if (result.movements.length === 0) break;
                    await stream.write(result.movements.map(inventoryMovementCsvRow).join("\n") + "\n");
                    written += result.movements.length;
                    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
                    cursor = result.pageInfo.nextCursor;
                }
            });
        }

        const result = await getInventoryOverview(db, {
            section: query.section,
            search: query.search,
            status: query.status,
            page: query.page,
            limit: query.limit,
            alertStatus: query.alertStatus,
            movementType: query.movementType,
            movementOrderId: query.movementOrderId,
            movementStartDate,
            movementEndDate,
            movementCursor: query.movementCursor,
            movementHealthOnly: query.movementHealthOnly === "true",
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

// ── Barcode label projection ──

const labelPreviewRoute = createRoute({
    method: "post",
    path: "/labels/preview",
    tags: ["Admin - Inventory"],
    summary: "Get exact SKU facts for a barcode label batch",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        variantIds: z.array(z.string().trim().min(1).max(100))
                            .min(1)
                            .max(INVENTORY_LABEL_VARIANT_LIMIT),
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Exact active SKU label projection",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        variants: z.array(inventoryLabelVariantSchema),
                        missingVariantIds: z.array(z.string()),
                    })),
                },
            },
        },
    },
});

app.openapi(labelPreviewRoute, async (c) => {
    const db = c.get("db");
    const { variantIds } = c.req.valid("json");
    return ok(c, await getInventoryLabelVariants(db, variantIds));
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
        await invalidateStockMutationIfVisible(db, { ...result, pool: payload.pool }, c);
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
        await invalidateStockMutationIfVisible(db, result, c);
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
        await invalidateStockMutationIfVisible(db, result, c);
        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

export { app as adminInventoryRoutes };
