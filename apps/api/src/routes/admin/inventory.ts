// src/server/routes/admin/inventory.ts
// Admin OpenAPI routes for inventory.

import { idempotencyKeyHeaderSchema, scopedRequestKey } from "./idempotency";
import type { Context } from "hono";
import { OpenAPIHono, createRoute, z, type RouteConfig, type RouteHandler } from "@hono/zod-openapi";
import {
    getInventoryOverview,
    getInventoryLabelVariants,
    adjustInventory,
    adjustInventoryRequestSchema,
    adjustStock,
    setStock,
    lookupByBarcodeOrSku,
    inventoryOperationKeySchema,
    INVENTORY_LABEL_VARIANT_LIMIT,
    INVENTORY_LABEL_ARTIFACT_MAX_COPIES,
    INVENTORY_LABEL_ARTIFACT_MAX_BYTES,
    buildInventoryLabelArtifact,
    buildInventoryMovementCsvArtifact,
    INVENTORY_MOVEMENT_EXPORT_MAX_BYTES,
    INVENTORY_MOVEMENT_EXPORT_MAX_ROWS,
    acknowledgeLowStockAlert,
    setDefaultLowStockThreshold,
    setLowStockThreshold,
    archiveInventoryLocation,
    createInventoryLocation,
    getProductInventoryLevels,
    getVariantInventoryLevels,
    inventoryLocationInputSchema,
    listInventoryLocations,
    readLocationOnHand,
    resolveActiveInventoryLocation,
    setDefaultInventoryLocation,
    unarchiveInventoryLocation,
    updateInventoryLocation,
    updateInventoryLocationSchema,
    getInventoryValuation,
    setSkuCosts,
    setSkuCostsSchema,
    canViewLocationDetails,
    locationWithoutDetails,
} from "@scalius/core/modules/inventory";
import { lowStockThresholdSchema } from "@scalius/core/modules/products";
import { INVENTORY_LOCATION_KINDS, INVENTORY_LOCATION_STATUSES } from "@scalius/database/schema";
import { getCurrencyConfig } from "@scalius/core/modules/settings";
import { NotFoundError, ValidationError } from "../../utils/api-error";

import { ok } from "../../utils/api-response";
import { successEnvelope, paginationSchema, errorResponses, conflictResponse } from "../../schemas/responses";
import { rebuildCatalogProjectionsAfterWrite } from "../../background/catalog";

import { nullableTimestampSchema, timestampSchema } from "../../schemas/timestamps";
import { parseStoreDateOnlyBoundary } from "./order-date-filter";
import { presentSkuCost } from "./cost-access";
import { commerceCalendarDateKey } from "@scalius/shared/commerce-time";
import { storeTimeZoneOf } from "../../utils/store-time-zone";

const app = new OpenAPIHono<{ Bindings: Env }>();

type AdminRouteHandler<R extends RouteConfig> = RouteHandler<R, { Bindings: Env }>;
type AdminRouteContext<R extends RouteConfig> = Parameters<AdminRouteHandler<R>>[0];

const inventoryIdempotencyHeadersSchema = idempotencyKeyHeaderSchema;

/**
 * The stock ledger's operation key for a request. The stable operations take
 * only the Idempotency-Key header (any 8 to 200 printable characters) and
 * derive the ledger key from it (the caller, the operation and the key), so
 * a retry never moves stock twice. The dashboard scanner's own route (beta)
 * keeps its ledger-shaped key, in the header or the body.
 */
async function inventoryOperationKey(
    c: Context,
    operationId: string,
    headerKey: string | undefined,
    scanner?: { bodyKey: string | undefined },
): Promise<string> {
    if (scanner) {
        if (headerKey && scanner.bodyKey && headerKey !== scanner.bodyKey) {
            throw new ValidationError("Idempotency-Key header must match body.operationKey.");
        }
        const key = headerKey ?? scanner.bodyKey;
        if (!key) throw new ValidationError("Idempotency-Key header or body.operationKey is required.");
        const parsed = inventoryOperationKeySchema.safeParse(key);
        if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "operationKey is not valid.");
        return parsed.data;
    }
    if (!headerKey) {
        throw new ValidationError("Send an Idempotency-Key header: a stock change is never repeated by a retry.");
    }
    return scopedRequestKey(c, operationId, headerKey);
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
    locationOnHand: z.number().int().nullable().openapi({ description: "On-hand at the `locationId` filter; null without one" }),
    cost: z.number().nullable().optional().openapi({ description: "Unit cost (cost per item) in major units; null when not set. Left out without the View product costs permission." }),
    incoming: z.number().int().openapi({ description: "Open purchase order units plus transfers in transit (to the `locationId` filter, if any); not on hand" }),
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
    orderNumber: z.number().int().nullable().openapi({ description: "The order's short number (#1073); null for movements without an order." }),
    type: z.string(),
    quantity: z.number(),
    previousStock: z.number().openapi({ description: "The SKU's on-hand across every location before the movement" }),
    newStock: z.number().openapi({ description: "The SKU's on-hand across every location after the movement" }),
    locationPreviousStock: z.number().int().nullable().openapi({ description: "On-hand at `locationId` before, when the operation recorded it (adjustments, counts, scans, licence keys); null otherwise" }),
    locationNewStock: z.number().int().nullable().openapi({ description: "On-hand at `locationId` after, when recorded; null otherwise" }),
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
    locationId: z.string().nullable().openapi({ description: "Where physical stock moved; null for reservations and releases" }),
    locationName: z.string().nullable(),
    variantSku: z.string().nullable(),
    optionLabel: z.string().nullable(),
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
    defaultLowStockThreshold: z.number().int().nullable().optional().openapi({ description: "Store-wide alert level for SKUs without their own (variants and alerts sections)" }),
}).passthrough();

const locationResultShape = {
    locationId: z.string().optional().openapi({ description: "On-hand stock: the location the units moved at" }),
    locationPreviousStock: z.number().int().optional().openapi({ description: "That location's on-hand before" }),
    locationNewStock: z.number().int().optional().openapi({ description: "That location's on-hand after" }),
};

const adjustResultSchema = z.object({
    variantId: z.string(),
    previousStock: z.number(),
    newStock: z.number(),
    delta: z.number(),
    ...locationResultShape,
}).passthrough();

const stockAdjustResultSchema = z.object({
    variantId: z.string(),
    previousStock: z.number(),
    newStock: z.number(),
    delta: z.number(),
    ...locationResultShape,
});

const optionalLocationIdSchema = z.string().trim().min(1).max(100).optional().openapi({
    description: "Active location counted or adjusted; the default location when omitted",
});

const inventoryLocationSchema = z.object({
    id: z.string(),
    name: z.string(),
    code: z.string(),
    kind: z.enum(INVENTORY_LOCATION_KINDS),
    // The address and phone: left out without inventory.view or settings.general.view.
    addressLine1: z.string().nullable().optional(),
    addressLine2: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    postalCode: z.string().nullable().optional(),
    countryCode: z.string(),
    phone: z.string().nullable().optional(),
    isDefault: z.boolean(),
    status: z.enum(INVENTORY_LOCATION_STATUSES),
    position: z.number().int(),
    version: z.number().int().min(1),
    onHand: z.number().int().openapi({ description: "Units on hand there, every SKU" }),
    stockedSkus: z.number().int().openapi({ description: "SKUs with units on hand there" }),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
});

const variantInventoryLevelsSchema = z.object({
    variantId: z.string(),
    stock: z.number().int(),
    reservedStock: z.number().int(),
    levels: z.array(z.object({
        locationId: z.string(),
        name: z.string(),
        code: z.string(),
        isDefault: z.boolean(),
        status: z.enum(INVENTORY_LOCATION_STATUSES),
        onHand: z.number().int(),
    })),
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
        locationOnHand: z.number().int().nullable().openapi({ description: "On-hand at the `locationId` asked for; null without one" }),
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
            movementType: z.enum(["all", "reserved", "deducted", "released", "adjusted", "restored", "preorder_reserved", "preorder_deducted", "received", "transfer_out", "transfer_in"]).optional().default("all").openapi({ description: "Movement type filter" }),
            movementOrderId: z.string().trim().max(100).optional().openapi({ description: "Exact order ID filter for movements" }),
            movementLocationId: z.string().trim().min(1).max(100).optional().openapi({ description: "Movements at this inventory location only" }),
            movementStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "Movement start date (YYYY-MM-DD, Bangladesh calendar day)" }),
            movementEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().openapi({ description: "Movement end date (YYYY-MM-DD, Bangladesh calendar day)" }),
            movementCursor: z.string().max(512).optional().openapi({ description: "Opaque cursor for the next movement page" }),
            movementHealthOnly: z.enum(["true"]).optional().openapi({ description: "Return only ledger health diagnostics" }),
            sort: z.enum(["productName", "sku", "available"]).optional().default("available").openapi({ description: "Sort field" }),
            order: z.enum(["asc", "desc"]).optional().default("asc").openapi({ description: "Sort order" }),
            locationId: z.string().trim().min(1).max(100).optional().openapi({ description: "Variants section: also return each SKU's on-hand at this location (locationOnHand)" }),
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
        const movementStartDate = parseStoreDateOnlyBoundary(query.movementStartDate, "start", storeTimeZoneOf(c.env));
        const movementEndDate = parseStoreDateOnlyBoundary(query.movementEndDate, "end", storeTimeZoneOf(c.env));
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
            movementLocationId: query.movementLocationId,
            movementStartDate,
            movementEndDate,
            movementCursor: query.movementCursor,
            movementHealthOnly: query.movementHealthOnly === "true",
            sort: query.sort,
            order: query.order,
            locationId: query.locationId,
        });
        // Unit costs only with "View product costs".
        if ("variants" in result && result.variants) {
            return ok(c, { ...result, variants: result.variants.map((variant) => presentSkuCost(c, variant)) });
        }
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
    movementType: z.enum(["all", "reserved", "deducted", "released", "adjusted", "restored", "preorder_reserved", "preorder_deducted", "received", "transfer_out", "transfer_in"]).optional().default("all"),
    movementOrderId: z.string().trim().max(100).optional(),
    movementLocationId: z.string().trim().min(1).max(100).optional(),
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
    const startDate = parseStoreDateOnlyBoundary(input.movementStartDate, "start", storeTimeZoneOf(c.env));
    const endDate = parseStoreDateOnlyBoundary(input.movementEndDate, "end", storeTimeZoneOf(c.env));
    if (input.movementStartDate && !startDate) throw new ValidationError("Invalid movement start date");
    if (input.movementEndDate && !endDate) throw new ValidationError("Invalid movement end date");
    if (startDate && endDate && startDate > endDate) {
        throw new ValidationError("Movement start date must not be after end date");
    }
    const artifact = await buildInventoryMovementCsvArtifact(db, {
        search: input.search,
        movementType: input.movementType,
        orderId: input.movementOrderId,
        locationId: input.movementLocationId,
        startDate,
        endDate,
        maxRows: input.maxRows,
    });
    const filename = `inventory-movements-${commerceCalendarDateKey(storeTimeZoneOf(c.env))}.csv`;
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
    locale: z.enum(["en", "bn"]).default("en").openapi({ description: "Dashboard language, so printed prices match the preview" }),
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
        artifact = buildInventoryLabelArtifact(projection.variants, job, currency);
    } catch (error: unknown) {
        if (error instanceof Error) throw new ValidationError(error.message);
        throw error;
    }
    const filename = `barcode-labels-${commerceCalendarDateKey(storeTimeZoneOf(c.env))}.${artifact.extension}`;
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
    const payload = c.req.valid("json");
    const operationKey = await inventoryOperationKey(c, "dashboard.inventory.adjust", c.req.valid("header")["idempotency-key"]);
    const user = c.get("user");
    try {
        const result = await adjustInventory(db, variantId, { ...payload, operationKey }, user?.id);

        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Alert level ──

const alertLevelRoute = createRoute({
    method: "put",
    path: "/{variantId}/alert-level",
    operationId: "dashboard.inventory.set_alert_level",
    tags: ["Admin - Inventory"],
    summary: "Set a SKU's low-stock alert level",
    description: "Alert when available stock falls to this level or below: a whole number from 0 to 1,000,000 (0 turns the alert off for this SKU), or null to use the store default. Stock is not changed.",
    request: {
        params: z.object({ variantId: z.string() }),
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        lowStockThreshold: lowStockThresholdSchema,
                    }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Alert level saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        variantId: z.string(),
                        lowStockThreshold: z.number().int().nullable(),
                    })),
                },
            },
        },
        400: errorResponses[400],
        404: errorResponses[404],
    },
});

app.openapi(alertLevelRoute, async (c) => {
    const { variantId } = c.req.valid("param");
    const { lowStockThreshold } = c.req.valid("json");
    const result = await setLowStockThreshold(c.get("db"), variantId, lowStockThreshold);
    // The alert level shapes the buyer availability band.

    return ok(c, result);
});

// ── Store default alert level ──

const defaultAlertLevelRoute = createRoute({
    method: "put",
    path: "/default-alert-level",
    operationId: "dashboard.inventory.set_default_alert_level",
    tags: ["Admin - Inventory"],
    summary: "Set the store-wide low-stock alert level",
    description: "SKUs without their own alert level use this one: a whole number from 0 to 1,000,000, or null to turn it off. Stock is not changed.",
    request: {
        body: {
            content: {
                "application/json": {
                    schema: z.object({ defaultLowStockThreshold: lowStockThresholdSchema }),
                },
            },
        },
    },
    responses: {
        200: {
            description: "Store alert level saved",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({ defaultLowStockThreshold: z.number().int().nullable() })),
                },
            },
        },
        400: errorResponses[400],
    },
});

app.openapi(defaultAlertLevelRoute, async (c) => {
    const { defaultLowStockThreshold } = c.req.valid("json");
    const result = await setDefaultLowStockThreshold(c.get("db"), defaultLowStockThreshold);
    // The level shapes buyer availability bands for every SKU that uses it,
    // including each product's stored card band: rebuild those off the
    // request path; database triggers advance the affected dependencies.

    await rebuildCatalogProjectionsAfterWrite(c, c.get("db"), "inventory");
    return ok(c, result);
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
            locationId: z.string().trim().min(1).max(100).optional().openapi({ description: "Active location being counted: the variant also carries its on-hand there (locationOnHand)" }),
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
    const { code, locationId } = c.req.valid("query");
    // A named location must be active: the scanner adjusts stock there next.
    const [result, location] = await Promise.all([
        lookupByBarcodeOrSku(db, code),
        locationId ? resolveActiveInventoryLocation(db, locationId) : null,
    ]);
    if (!result) {
        throw new NotFoundError("No variant found with this barcode or SKU");
    }
    const locationOnHand = location
        ? (await readLocationOnHand(db, location.id, [result.variant.id])).get(result.variant.id) ?? 0
        : null;
    return ok(c, { ...result, variant: { ...result.variant, locationOnHand } });
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
                        locationId: optionalLocationIdSchema,
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
    const { operationKey: bodyOperationKey, variantId, adjustment, reason, locationId } = c.req.valid("json");
    const operationKey = await inventoryOperationKey(
        c,
        "dashboard.inventory.adjust_stock",
        c.req.valid("header")["idempotency-key"],
        { bodyKey: bodyOperationKey },
    );
    const user = c.get("user");
    try {
        const result = await adjustStock(db, variantId, adjustment, operationKey, reason, user?.id, locationId);

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
    summary: "Set the counted stock of a SKU at a location (stocktaking)",
    request: {
        headers: inventoryIdempotencyHeadersSchema,
        body: {
            content: {
                "application/json": {
                    schema: z.object({
                        variantId: z.string().openapi({ description: "Variant ID" }),
                        newStock: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).openapi({ description: "Counted whole-number stock at the location" }),
                        reason: z.string().trim().max(500).optional().openapi({ description: "Reason for stocktake" }),
                        locationId: optionalLocationIdSchema,
                        expectedStockVersion: z.number().int().min(0).optional().openapi({
                            description: "The SKU's stockVersion you read; any stock change since is refused with 409. Omit to set the count whatever happened since.",
                        }),
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
    const { variantId, newStock, reason, locationId, expectedStockVersion } = c.req.valid("json");
    const operationKey = await inventoryOperationKey(c, "dashboard.inventory.set_stock", c.req.valid("header")["idempotency-key"]);
    const user = c.get("user");
    try {
        const result = await setStock(db, variantId, newStock, operationKey, reason, user?.id, locationId, { expectedStockVersion });

        return ok(c, result);
    } catch (error: unknown) {
        if (error instanceof Error && error.message === "Variant not found") throw new NotFoundError(error.message);
        throw error;
    }
});

// ── Valuation ──

const valuationLocationSchema = z.object({
    locationId: z.string(),
    name: z.string(),
    code: z.string(),
    isDefault: z.boolean(),
    status: z.enum(INVENTORY_LOCATION_STATUSES),
    units: z.number().int(),
    value: z.number().openapi({ description: "On hand x unit cost (major units), SKUs with a cost only" }),
    unitsWithoutCost: z.number().int(),
    skusWithoutCost: z.number().int(),
});

const valuationRoute = createRoute({
    method: "get",
    path: "/valuation",
    operationId: "dashboard.inventory.valuation",
    tags: ["Admin - Inventory"],
    summary: "Get the inventory value per location",
    description: "On-hand units times each SKU's current unit cost, per location, plus units in transit. SKUs without a cost are counted (unitsWithoutCost, skusWithoutCost), not valued.",
    responses: {
        200: {
            description: "Inventory valuation",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        currencyCode: z.string(),
                        locations: z.array(valuationLocationSchema),
                        total: z.object({ units: z.number().int(), value: z.number(), unitsWithoutCost: z.number().int(), skusWithoutCost: z.number().int() }),
                        inTransit: z.object({ units: z.number().int(), value: z.number(), unitsWithoutCost: z.number().int() }),
                    })),
                },
            },
        },
    },
});

app.openapi(valuationRoute, async (c) => ok(c, await getInventoryValuation(c.get("db"))));

// ── Unit costs ──

const setCostsRoute = createRoute({
    method: "put",
    path: "/costs",
    operationId: "dashboard.inventory.set_costs",
    tags: ["Admin - Inventory"],
    summary: "Set the unit cost of SKUs",
    description: "Cost per item in major units (null clears it), up to 100 live SKUs in one atomic write. With expectedCost, a SKU whose cost changed since it was read (a receipt average or another editor) refuses the whole change. Never shown to buyers.",
    request: { body: { content: { "application/json": { schema: setSkuCostsSchema } } } },
    responses: {
        200: {
            description: "Costs saved",
            content: { "application/json": { schema: successEnvelope(z.object({ items: z.array(z.object({ variantId: z.string(), cost: z.number().nullable() })) })) } },
        },
        400: errorResponses[400],
        404: errorResponses[404],
        409: conflictResponse,
    },
});

app.openapi(setCostsRoute, async (c) => ok(c, await setSkuCosts(c.get("db"), c.req.valid("json"))));

// ── Per-location levels of a product's SKUs ──

const productLevelsRoute = createRoute({
    method: "get",
    path: "/levels",
    operationId: "dashboard.inventory.product_levels",
    tags: ["Admin - Inventory"],
    summary: "Get the on-hand stock of a product's SKUs at each location",
    description: "One bounded read for the product editor: every live SKU's units at each location holding some. A SKU's levels sum to its on-hand stock; locations without units are omitted.",
    request: {
        query: z.object({
            productId: z.string().trim().min(1).max(100).openapi({ description: "Product whose live SKUs to read" }),
        }),
    },
    responses: {
        200: {
            description: "Per-location on-hand of the product's SKUs",
            content: {
                "application/json": {
                    schema: successEnvelope(z.object({
                        productId: z.string(),
                        levels: z.array(z.object({
                            variantId: z.string(),
                            locationId: z.string(),
                            onHand: z.number().int(),
                        })),
                        incoming: z.array(z.object({
                            variantId: z.string(),
                            locationId: z.string(),
                            purchaseOrders: z.number().int().openapi({ description: "Open purchase order units arriving there" }),
                            transfers: z.number().int().openapi({ description: "Units in transit to there" }),
                        })).openapi({ description: "Units coming to each location (not on hand); rows with nothing incoming are omitted" }),
                    })),
                },
            },
        },
    },
});

app.openapi(productLevelsRoute, async (c) => {
    const { productId } = c.req.valid("query");
    return ok(c, await getProductInventoryLevels(c.get("db"), productId));
});

// ── Per-location levels of one SKU ──

const variantLevelsRoute = createRoute({
    method: "get",
    path: "/{variantId}/levels",
    operationId: "dashboard.inventory.levels",
    tags: ["Admin - Inventory"],
    summary: "Get a SKU's on-hand stock at each location",
    description: "On-hand at every active location (0 where it holds none). The levels sum to the SKU's on-hand stock.",
    request: { params: z.object({ variantId: z.string() }) },
    responses: {
        200: {
            description: "Per-location on-hand",
            content: { "application/json": { schema: successEnvelope(variantInventoryLevelsSchema) } },
        },
        404: errorResponses[404],
    },
});

app.openapi(variantLevelsRoute, async (c) => {
    const { variantId } = c.req.valid("param");
    return ok(c, await getVariantInventoryLevels(c.get("db"), variantId));
});

// ── Locations ──

const locationParamsSchema = z.object({ locationId: z.string().trim().min(1).max(100) });
const locationEnvelope = successEnvelope(inventoryLocationSchema);

const listLocationsRoute = createRoute({
    method: "get",
    path: "/locations",
    operationId: "dashboard.inventory_locations.list",
    tags: ["Admin - Inventory"],
    summary: "List inventory locations",
    description: "Where stock is held. Active locations first (the default leads); archived ones only when asked for.",
    request: {
        query: z.object({
            includeArchived: z.enum(["true", "false"]).optional().default("false").openapi({ description: "Also list archived locations" }),
        }),
    },
    responses: {
        200: {
            description: "Inventory locations",
            content: { "application/json": { schema: successEnvelope(z.object({ locations: z.array(inventoryLocationSchema) })) } },
        },
    },
});

app.openapi(listLocationsRoute, async (c) => {
    const { includeArchived } = c.req.valid("query");
    const locations = await listInventoryLocations(c.get("db"), { includeArchived: includeArchived === "true" });
    // Stock screens need where units are, not the warehouse's address.
    if (!canViewLocationDetails(c.get("adminPermissions"))) {
        return ok(c, { locations: locations.map(locationWithoutDetails) });
    }
    return ok(c, { locations });
});

const createLocationRoute = createRoute({
    method: "post",
    path: "/locations",
    operationId: "dashboard.inventory_locations.create",
    tags: ["Admin - Inventory"],
    summary: "Add an inventory location",
    request: { body: { content: { "application/json": { schema: inventoryLocationInputSchema } } } },
    responses: {
        200: { description: "Location added", content: { "application/json": { schema: locationEnvelope } } },
        400: errorResponses[400],
        409: conflictResponse,
    },
});

app.openapi(createLocationRoute, async (c) => {
    return ok(c, await createInventoryLocation(c.get("db"), c.req.valid("json")));
});

const updateLocationRoute = createRoute({
    method: "patch",
    path: "/locations/{locationId}",
    operationId: "dashboard.inventory_locations.update",
    tags: ["Admin - Inventory"],
    summary: "Edit an inventory location",
    description: "Replaces the location's details; expectedVersion must be its current version.",
    request: {
        params: locationParamsSchema,
        body: { content: { "application/json": { schema: updateInventoryLocationSchema } } },
    },
    responses: {
        200: { description: "Location saved", content: { "application/json": { schema: locationEnvelope } } },
        400: errorResponses[400],
        404: errorResponses[404],
        409: conflictResponse,
    },
});

app.openapi(updateLocationRoute, async (c) => {
    const { locationId } = c.req.valid("param");
    return ok(c, await updateInventoryLocation(c.get("db"), locationId, c.req.valid("json")));
});

const archiveLocationRoute = createRoute({
    method: "post",
    path: "/locations/{locationId}/archive",
    operationId: "dashboard.inventory_locations.archive",
    tags: ["Admin - Inventory"],
    summary: "Archive an inventory location",
    description: "Refused for the default location, while it holds any units, or while an open order is set to ship from it.",
    request: { params: locationParamsSchema },
    responses: {
        200: { description: "Location archived", content: { "application/json": { schema: locationEnvelope } } },
        404: errorResponses[404],
        409: conflictResponse,
    },
});

app.openapi(archiveLocationRoute, async (c) => {
    const { locationId } = c.req.valid("param");
    return ok(c, await archiveInventoryLocation(c.get("db"), locationId));
});

const unarchiveLocationRoute = createRoute({
    method: "post",
    path: "/locations/{locationId}/unarchive",
    operationId: "dashboard.inventory_locations.unarchive",
    tags: ["Admin - Inventory"],
    summary: "Make an archived inventory location active again",
    request: { params: locationParamsSchema },
    responses: {
        200: { description: "Location active", content: { "application/json": { schema: locationEnvelope } } },
        404: errorResponses[404],
    },
});

app.openapi(unarchiveLocationRoute, async (c) => {
    const { locationId } = c.req.valid("param");
    return ok(c, await unarchiveInventoryLocation(c.get("db"), locationId));
});

const defaultLocationRoute = createRoute({
    method: "post",
    path: "/locations/{locationId}/default",
    operationId: "dashboard.inventory_locations.set_default",
    tags: ["Admin - Inventory"],
    summary: "Make an active location the default",
    description: "Stock that moves without a named location (product editor edits, orders without their own location) moves at the default.",
    request: { params: locationParamsSchema },
    responses: {
        200: { description: "Default location set", content: { "application/json": { schema: locationEnvelope } } },
        400: errorResponses[400],
        404: errorResponses[404],
    },
});

app.openapi(defaultLocationRoute, async (c) => {
    const { locationId } = c.req.valid("param");
    return ok(c, await setDefaultInventoryLocation(c.get("db"), locationId));
});

export { app as adminInventoryRoutes };
