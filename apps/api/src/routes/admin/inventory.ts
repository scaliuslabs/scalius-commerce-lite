// src/server/routes/admin/inventory.ts
// Admin OpenAPI routes for inventory.

import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import { getInventoryOverview, getInventoryLabelVariants, adjustInventory, adjustInventoryRequestSchema, adjustStock, setStock, lookupByBarcodeOrSku, inventoryOperationKeySchema, INVENTORY_LABEL_VARIANT_LIMIT, INVENTORY_LABEL_ARTIFACT_MAX_COPIES, INVENTORY_LABEL_ARTIFACT_MAX_BYTES, buildInventoryLabelArtifact, buildInventoryMovementCsvArtifact, INVENTORY_MOVEMENT_EXPORT_MAX_BYTES, INVENTORY_MOVEMENT_EXPORT_MAX_ROWS } from "@scalius/core/modules/inventory";
import { acknowledgeLowStockAlert } from "@scalius/core/modules/inventory/alerts";
import { getCurrencyConfig } from "@scalius/core/modules/settings/settings.service";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses, conflictResponse } from "../../schemas/responses";
import {
    findStockMutationAvailabilityTransitions,
    invalidateProductAvailabilityCaches,
} from "../../utils/cache-invalidation";
import { nullableTimestampSchema } from "../../schemas/timestamps";
import { parseBangladeshDateOnlyBoundary } from "./order-date-filter";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

const inventoryIdempotencyHeadersSchema = z.object({
    "idempotency-key": inventoryOperationKeySchema.optional().openapi({
        description: "Standard retry key. May replace body.operationKey; if both are sent they must match.",
    }),
});

function resolveInventoryOperationKey(
    headerKey: string | undefined,
    bodyKey: string | undefined,
): string {
    if (headerKey && bodyKey && headerKey !== bodyKey) {
        throw new ValidationError("Idempotency-Key header must match body.operationKey.");
    }
    const operationKey = headerKey ?? bodyKey;
    if (!operationKey) {
        throw new ValidationError("Idempotency-Key header or body.operationKey is required.");
    }
    return operationKey;
}

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
    effectivePrice: z.number().optional(),
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
    operationId: "dashboard.inventory.list",
    tags: ["Admin - Inventory"],
    summary: "Get inventory overview",
    description: "Answer inventory and stock-status questions with bounded variant, movement, or alert pages.",
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
            sort: z.enum(["productName", "sku", "available"]).optional().default("available").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
        })
    },
    responses: {
        200: {
            description: "Inventory overview",
            content: {
                "application/json": { schema: successEnvelope(inventoryOverviewSchema) },
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

// ── Bounded movement CSV artifact ──

const movementExportBodySchema = z.object({
    search: z.string().trim().max(120).optional().default(""),
    movementType: z.enum(["all", "reserved", "deducted", "released", "adjusted", "restored", "preorder_reserved", "preorder_deducted"]).optional().default("all"),
    movementOrderId: z.string().trim().max(100).optional(),
    movementStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    movementEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    maxRows: z.number().int().min(1).max(INVENTORY_MOVEMENT_EXPORT_MAX_ROWS).default(INVENTORY_MOVEMENT_EXPORT_MAX_ROWS),
});

const movementsExportRoute = createRoute({
    method: "post",
    path: "/movements/export",
    operationId: "dashboard.inventory.movements_export",
    tags: ["Admin - Inventory"],
    summary: "Generate a bounded inventory movement CSV artifact",
    request: {
        body: { content: { "application/json": { schema: movementExportBodySchema } } },
    },
    responses: {
        200: {
            description: "Bounded inventory movement CSV attachment",
            content: { "text/csv": { schema: z.string() } },
        },
        ...errorResponses,
    },
});

app.openapi(movementsExportRoute, async (c) => {
    const db = c.get("db");
    const input = c.req.valid("json");
    const startDate = parseBangladeshDateOnlyBoundary(input.movementStartDate, "start");
    const endDate = parseBangladeshDateOnlyBoundary(input.movementEndDate, "end");
    if (input.movementStartDate && !startDate) throw new ValidationError("Invalid movement start date");
    if (input.movementEndDate && !endDate) throw new ValidationError("Invalid movement end date");
    if (startDate && endDate && startDate > endDate) {
        throw new ValidationError("Movement start date must not be after end date");
    }
    const artifact = await buildInventoryMovementCsvArtifact(db, {
        search: input.search,
        movementType: input.movementType,
        orderId: input.movementOrderId,
        startDate,
        endDate,
        maxRows: input.maxRows,
    });
    const filename = `inventory-movements-${commerceCalendarDateKey()}.csv`;
    c.header("Content-Type", artifact.contentType);
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Content-Length", String(artifact.byteLength));
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Export-Max-Rows", String(input.maxRows));
    c.header("X-Export-Row-Count", String(artifact.rowCount));
    c.header("X-Artifact-Max-Bytes", String(INVENTORY_MOVEMENT_EXPORT_MAX_BYTES));
    return c.body(artifact.body);
});

// ── Get Alerts ──

const alertsRoute = createRoute({
    method: "get",
    path: "/alerts",
    operationId: "dashboard.inventory_alerts.list",
    tags: ["Admin - Inventory"],
    summary: "Get low-stock and out-of-stock product inventory alerts",
    description: "Find low-stock, out-of-stock, and other inventory issues needing attention.",
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
    operationId: "dashboard.inventory_alerts.acknowledge",
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
    operationId: "dashboard.inventory_labels.preview",
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

const labelArtifactPresetSchema = z.object({
    pageWidthMm: z.number().min(20).max(320),
    pageHeightMm: z.number().min(15).max(450),
    columns: z.number().int().min(1).max(10),
    rows: z.number().int().min(1).max(20),
    marginXmm: z.number().min(0).max(50),
    marginYmm: z.number().min(0).max(50),
    gapXmm: z.number().min(0).max(30),
    gapYmm: z.number().min(0).max(30),
    cropMarks: z.boolean(),
}).superRefine((preset, context) => {
    const width = (preset.pageWidthMm - 2 * preset.marginXmm - (preset.columns - 1) * preset.gapXmm) / preset.columns;
    const height = (preset.pageHeightMm - 2 * preset.marginYmm - (preset.rows - 1) * preset.gapYmm) / preset.rows;
    if (width < 20) context.addIssue({ code: "custom", message: "Each label must be at least 20 mm wide." });
    if (height < 15) context.addIssue({ code: "custom", message: "Each label must be at least 15 mm high." });
});

const labelArtifactBodySchema = z.object({
    format: z.enum(["csv", "html", "pdf"]),
    mode: z.enum(["job", "test"]).default("job"),
    variantIds: z.array(z.string().trim().min(1).max(100)).min(1).max(INVENTORY_LABEL_VARIANT_LIMIT),
    quantities: z.record(z.string().trim().min(1).max(100), z.number().int().min(0).max(INVENTORY_LABEL_ARTIFACT_MAX_COPIES)),
    order: z.enum(["selected", "product", "sku"]).default("selected"),
    preset: labelArtifactPresetSchema,
    startOffset: z.number().int().min(0).max(199).default(0),
    alignment: z.object({ xMm: z.number().min(-5).max(5), yMm: z.number().min(-5).max(5) }),
    content: z.object({
        showProduct: z.boolean(),
        showVariant: z.boolean(),
        showSku: z.boolean(),
        showPrice: z.boolean(),
    }),
}).superRefine((job, context) => {
    const allowedIds = new Set(job.variantIds);
    if (Object.keys(job.quantities).some((id) => !allowedIds.has(id))) {
        context.addIssue({ code: "custom", path: ["quantities"], message: "Quantities may reference only selected SKUs." });
    }
    const copies = job.variantIds.reduce((sum, id) => sum + (job.quantities[id] ?? 0), 0);
    if (copies < 1 || copies > INVENTORY_LABEL_ARTIFACT_MAX_COPIES) {
        context.addIssue({ code: "custom", path: ["quantities"], message: `Select from 1 through ${INVENTORY_LABEL_ARTIFACT_MAX_COPIES} label copies.` });
    }
    if (job.startOffset >= job.preset.columns * job.preset.rows) {
        context.addIssue({ code: "custom", path: ["startOffset"], message: "Start offset must fit on the first page." });
    }
});

const labelArtifactRoute = createRoute({
    method: "post",
    path: "/labels/artifact",
    operationId: "dashboard.inventory_labels.generate_artifact",
    tags: ["Admin - Inventory"],
    summary: "Generate a bounded barcode-label CSV, printable HTML, or PDF artifact",
    request: { body: { content: { "application/json": { schema: labelArtifactBodySchema } } } },
    responses: {
        200: {
            description: "Generated barcode-label artifact",
            content: {
                "text/csv": { schema: z.string() },
                "text/html": { schema: z.string() },
                "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
            },
        },
        ...errorResponses,
    },
});

app.openapi(labelArtifactRoute, async (c) => {
    const db = c.get("db");
    const job = c.req.valid("json");
    const projection = await getInventoryLabelVariants(db, job.variantIds);
    if (projection.missingVariantIds.length > 0) {
        throw new ValidationError("One or more selected SKUs are no longer printable. Refresh the label job.");
    }
    const currency = await getCurrencyConfig(db);
    let artifact: ReturnType<typeof buildInventoryLabelArtifact>;
    try {
        artifact = buildInventoryLabelArtifact(projection.variants, job, currency.code);
    } catch (error: unknown) {
        if (error instanceof Error) throw new ValidationError(error.message);
        throw error;
    }
    const filename = `barcode-labels-${commerceCalendarDateKey()}.${artifact.extension}`;
    c.header("Content-Type", artifact.contentType);
    c.header("Content-Disposition", `attachment; filename="${filename}"`);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Label-Copy-Count", String(artifact.copyCount));
    c.header("X-Label-Page-Count", String(artifact.pageCount));
    c.header("X-Artifact-Max-Bytes", String(INVENTORY_LABEL_ARTIFACT_MAX_BYTES));
    c.header("Content-Length", String(artifact.byteLength));
    return c.body(artifact.body);
});

// ── Adjust Inventory ──

const adjustRoute = createRoute({
    method: "post",
    path: "/{variantId}/adjust",
    operationId: "dashboard.inventory.adjust",
    tags: ["Admin - Inventory"],
    summary: "Adjust inventory for a variant",
    request: {
        params: z.object({ variantId: z.string() }),
        headers: inventoryIdempotencyHeadersSchema,
        body: { content: { "application/json": { schema: adjustInventoryRequestSchema } } }
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
    const { operationKey: bodyOperationKey, ...payload } = c.req.valid("json");
    const operationKey = resolveInventoryOperationKey(
        c.req.valid("header")["idempotency-key"],
        bodyOperationKey,
    );
    const user = c.get("user");
    try {
        const result = await adjustInventory(db, variantId, { ...payload, operationKey }, user?.id);
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
    operationId: "dashboard.inventory.lookup_sku",
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
    operationId: "dashboard.inventory.adjust_stock",
    tags: ["Admin - Inventory"],
    summary: "Adjust stock by a relative amount (+/-)",
    request: {
        headers: inventoryIdempotencyHeadersSchema,
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        operationKey: inventoryOperationKeySchema.optional(),
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
    const { operationKey: bodyOperationKey, variantId, adjustment, reason } = c.req.valid("json");
    const operationKey = resolveInventoryOperationKey(
        c.req.valid("header")["idempotency-key"],
        bodyOperationKey,
    );
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
    operationId: "dashboard.inventory.set_stock",
    tags: ["Admin - Inventory"],
    summary: "Set stock to an absolute value (stocktaking)",
    request: {
        headers: inventoryIdempotencyHeadersSchema,
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        operationKey: inventoryOperationKeySchema.optional(),
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
    const { operationKey: bodyOperationKey, variantId, newStock, reason } = c.req.valid("json");
    const operationKey = resolveInventoryOperationKey(
        c.req.valid("header")["idempotency-key"],
        bodyOperationKey,
    );
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
