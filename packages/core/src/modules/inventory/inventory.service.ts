import { productVariants, products, inventoryLocations, inventoryMovements, inventoryOperations, orders, productLowStockAlerts, user as adminUsers } from "@scalius/database/schema";
import { eq, sql, and, isNull, desc, asc, or, inArray } from "drizzle-orm";
import { containsText } from "../../utils/text-match";
import type { Database } from "@scalius/database/client";
import type { SQL, SQLWrapper } from "drizzle-orm";
import { ValidationError } from "@scalius/core/errors";
import { discountedPriceMinor, fromMinor } from "@scalius/shared/money";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { readStoreCurrency } from "../markets";
import {
  buildInventoryLowStockCondition,
  buildNeedsRestockCondition,
  effectiveLowStockThresholdSql,
  operationalSkuRowPredicate,
  storeDefaultLowStockThresholdSql,
  variantOptionLabelSql,
} from "../products";

const availableStockSql = sql<number>`(${productVariants.stock} - ${productVariants.reservedStock})`;
import { adjustInventorySchema } from "./inventory.validation";
import { executeInventoryOperation } from "./inventory-operations";
import { locationOnHandSql } from "./locations";
import { incomingUnitsSql } from "./inventory-insights";

const ALLOWED_INVENTORY_SECTIONS: ReadonlySet<string> = new Set(["variants", "movements", "alerts"]);
const ALLOWED_INVENTORY_STATUSES: ReadonlySet<string> = new Set(["all", "low", "out", "reserved"]);
const ALLOWED_ALERT_STATUSES: ReadonlySet<string> = new Set(["active", "acknowledged", "resolved", "all"]);
const ALLOWED_INVENTORY_SORTS: ReadonlySet<string> = new Set(["productName", "sku", "available"]);
const ALLOWED_SORT_ORDERS: ReadonlySet<string> = new Set(["asc", "desc"]);
const ALLOWED_MOVEMENT_TYPES: ReadonlySet<string> = new Set([
    "all",
    "reserved",
    "deducted",
    "released",
    "adjusted",
    "restored",
    "preorder_reserved",
    "preorder_deducted",
    "received",
    "transfer_out",
    "transfer_in",
]);
const MAX_MOVEMENT_CURSOR_LENGTH = 512;
export const INVENTORY_LABEL_VARIANT_LIMIT = 150;

type InventoryLabelPricingFacts = {
    priceMinor: number;
    variantDiscountType: string | null;
    variantDiscountBps: number;
    variantDiscountAmountMinor: number;
    productDiscountType: string | null;
    productDiscountBps: number;
    productDiscountAmountMinor: number;
};

/**
 * Barcode price labels must match the automatic catalog price a buyer sees.
 * A positive SKU discount takes precedence; otherwise the product discount
 * applies, matching checkout and the buyer catalog projection.
 */
export function calculateInventoryLabelEffectivePriceMinor(
    facts: InventoryLabelPricingFacts,
    /** The store's price increment. */
    priceIncrementMinor: number,
): number {
    const hasVariantDiscount =
        (facts.variantDiscountType === "percentage" && facts.variantDiscountBps > 0)
        || (facts.variantDiscountType === "flat" && facts.variantDiscountAmountMinor > 0);

    return discountedPriceMinor(
        facts.priceMinor,
        hasVariantDiscount ? facts.variantDiscountType : facts.productDiscountType,
        hasVariantDiscount ? facts.variantDiscountBps : facts.productDiscountBps,
        hasVariantDiscount ? facts.variantDiscountAmountMinor : facts.productDiscountAmountMinor,
        priceIncrementMinor,
    );
}

type InventoryMovementCursor = {
    createdAt: number;
    id: string;
};

export function encodeInventoryMovementCursor(cursor: InventoryMovementCursor): string {
    return `${cursor.createdAt}|${encodeURIComponent(cursor.id)}`;
}

export function decodeInventoryMovementCursor(value: string): InventoryMovementCursor {
    if (!value || value.length > MAX_MOVEMENT_CURSOR_LENGTH) {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    const separator = value.indexOf("|");
    if (separator < 1) throw new ValidationError("Invalid inventory movement cursor");
    const createdAt = Number(value.slice(0, separator));
    let id: string;
    try {
        id = decodeURIComponent(value.slice(separator + 1));
    } catch {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !id || id.length > 256) {
        throw new ValidationError("Invalid inventory movement cursor");
    }
    return { createdAt, id };
}

function movementTimestampSeconds(value: Date | number | string): number {
    if (value instanceof Date) return Math.floor(value.getTime() / 1000);
    if (typeof value === "number") return value > 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
    const parsed = new Date(value).getTime();
    if (!Number.isFinite(parsed)) throw new ValidationError("Inventory movement timestamp is invalid");
    return Math.floor(parsed / 1000);
}

/**
 * The location's on-hand before and after a movement, when the operation that
 * wrote it recorded them (`previousStock`/`newStock` are the SKU's total across
 * every location). Null for movements without one (orders, purchase orders,
 * transfers): History then names the location and labels the total.
 */
export function movementLocationCounts(
    operationPayload: string | null,
    locationId: string | null,
): { locationPreviousStock: number | null; locationNewStock: number | null } {
    const none = { locationPreviousStock: null, locationNewStock: null };
    if (!operationPayload || !locationId) return none;
    try {
        const result = JSON.parse(operationPayload) as Record<string, unknown>;
        const previous = result.locationPreviousStock;
        const next = result.locationNewStock;
        if (result.locationId !== locationId || !Number.isSafeInteger(previous) || !Number.isSafeInteger(next)) return none;
        return { locationPreviousStock: previous as number, locationNewStock: next as number };
    } catch {
        return none;
    }
}

export async function listInventoryMovements(db: Database, params: {
    search?: string;
    movementType?: string;
    orderId?: string;
    /** Only movements that moved physical stock at this location. */
    locationId?: string;
    startDate?: Date;
    endDate?: Date;
    cursor?: string;
    limit: number;
}) {
    const search = params.search?.trim() ?? "";
    const orderId = params.orderId?.trim() ?? "";
    const locationId = params.locationId?.trim() ?? "";
    if (search.length > 120) throw new ValidationError("Inventory search must be at most 120 characters");
    if (orderId.length > 100) throw new ValidationError("Inventory order ID must be at most 100 characters");
    if (locationId.length > 100) throw new ValidationError("Inventory location ID must be at most 100 characters");
    if (params.movementType && !ALLOWED_MOVEMENT_TYPES.has(params.movementType)) {
        throw new ValidationError("Invalid movement type parameter");
    }
    if (!Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
        throw new ValidationError("Inventory movement page size must be between 1 and 100");
    }
    if (params.startDate && !Number.isFinite(params.startDate.getTime())) {
        throw new ValidationError("Inventory movement start date is invalid");
    }
    if (params.endDate && !Number.isFinite(params.endDate.getTime())) {
        throw new ValidationError("Inventory movement end date is invalid");
    }
    if (params.startDate && params.endDate && params.startDate > params.endDate) {
        throw new ValidationError("Inventory movement start date must not be after end date");
    }

    const conditions: SQL[] = [];
    if (params.movementType && params.movementType !== "all") {
        conditions.push(eq(inventoryMovements.type, params.movementType));
    }
    if (search) {
        conditions.push(or(
            containsText(productVariants.sku, search),
            containsText(products.name, search),
        )!);
    }
    if (orderId) conditions.push(eq(inventoryMovements.orderId, orderId));
    if (locationId) conditions.push(eq(inventoryMovements.locationId, locationId));
    if (params.startDate) {
        conditions.push(sql`CAST(${inventoryMovements.createdAt} AS INTEGER) >= ${Math.floor(params.startDate.getTime() / 1000)}`);
    }
    if (params.endDate) {
        conditions.push(sql`CAST(${inventoryMovements.createdAt} AS INTEGER) <= ${Math.floor(params.endDate.getTime() / 1000)}`);
    }
    if (params.cursor) {
        const cursor = decodeInventoryMovementCursor(params.cursor);
        conditions.push(sql`(
            CAST(${inventoryMovements.createdAt} AS INTEGER) < ${cursor.createdAt}
            OR (
                CAST(${inventoryMovements.createdAt} AS INTEGER) = ${cursor.createdAt}
                AND ${inventoryMovements.id} < ${cursor.id}
            )
        )`);
    }

    const rows = await db
        .select({
            id: inventoryMovements.id,
            variantId: inventoryMovements.variantId,
            orderId: inventoryMovements.orderId,
            /** The short number merchants know the order by (#1073). */
            orderNumber: orders.orderNumber,
            type: inventoryMovements.type,
            quantity: inventoryMovements.quantity,
            previousStock: inventoryMovements.previousStock,
            newStock: inventoryMovements.newStock,
            notes: inventoryMovements.notes,
            createdBy: inventoryMovements.createdBy,
            actorDisplayName: adminUsers.name,
            ledgerVersion: inventoryMovements.ledgerVersion,
            pool: inventoryMovements.pool,
            reservationGeneration: inventoryMovements.reservationGeneration,
            stockVersionBefore: inventoryMovements.stockVersionBefore,
            stockVersionAfter: inventoryMovements.stockVersionAfter,
            stockDelta: inventoryMovements.stockDelta,
            previousReservedStock: inventoryMovements.previousReservedStock,
            newReservedStock: inventoryMovements.newReservedStock,
            reservedStockDelta: inventoryMovements.reservedStockDelta,
            previousPreorderStock: inventoryMovements.previousPreorderStock,
            newPreorderStock: inventoryMovements.newPreorderStock,
            preorderStockDelta: inventoryMovements.preorderStockDelta,
            createdAt: inventoryMovements.createdAt,
            locationId: inventoryMovements.locationId,
            locationName: inventoryLocations.name,
            variantSku: productVariants.sku,
            optionLabel: variantOptionLabelSql(productVariants.id),
            productName: products.name,
            // A merchant operation (adjustment, count, scan, licence keys) keeps
            // the location's own count before and after; read it from there.
            operationPayload: inventoryOperations.resultPayload,
        })
        .from(inventoryMovements)
        .leftJoin(inventoryOperations, eq(inventoryOperations.movementId, inventoryMovements.id))
        .leftJoin(inventoryLocations, eq(inventoryLocations.id, inventoryMovements.locationId))
        .leftJoin(productVariants, eq(productVariants.id, inventoryMovements.variantId))
        .leftJoin(products, eq(products.id, productVariants.productId))
        .leftJoin(adminUsers, eq(adminUsers.id, inventoryMovements.createdBy))
        .leftJoin(orders, eq(orders.id, inventoryMovements.orderId))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
        .limit(params.limit + 1)
        .all();

    const hasMore = rows.length > params.limit;
    const pageRows = rows.slice(0, params.limit);
    const movements = pageRows.map(({ actorDisplayName, operationPayload, ...row }) => ({
        ...row,
        ...movementLocationCounts(operationPayload, row.locationId),
        actorName: row.createdBy ? actorDisplayName ?? "Former admin" : "System",
        actorType: row.createdBy
            ? actorDisplayName
                ? "admin" as const
                : "former_admin" as const
            : "system" as const,
    }));
    const last = pageRows.at(-1);

    return {
        movements,
        pageInfo: {
            limit: params.limit,
            hasMore,
            nextCursor: hasMore && last
                ? encodeInventoryMovementCursor({
                    createdAt: movementTimestampSeconds(last.createdAt),
                    id: last.id,
                })
                : null,
        },
    };
}

export async function getInventoryLedgerHealth(db: Database) {
    const result = await db.select({
        legacyRows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 1 THEN 1 ELSE 0 END), 0)`,
        v2Rows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 2 THEN 1 ELSE 0 END), 0)`,
        v2Variants: sql<number>`COUNT(DISTINCT CASE WHEN ${inventoryMovements.ledgerVersion} = 2 THEN ${inventoryMovements.variantId} END)`,
        invalidV2Rows: sql<number>`COALESCE(SUM(CASE WHEN ${inventoryMovements.ledgerVersion} = 2 AND (
            ${inventoryMovements.pool} IS NULL
            OR ${inventoryMovements.pool} NOT IN ('regular', 'preorder', 'backorder')
            OR ${inventoryMovements.stockVersionBefore} IS NULL
            OR ${inventoryMovements.stockVersionAfter} <> ${inventoryMovements.stockVersionBefore} + 1
            OR ${inventoryMovements.stockDelta} IS NULL
            OR ${inventoryMovements.previousReservedStock} IS NULL
            OR ${inventoryMovements.newReservedStock} IS NULL
            OR ${inventoryMovements.reservedStockDelta} IS NULL
            OR ${inventoryMovements.previousPreorderStock} IS NULL
            OR ${inventoryMovements.newPreorderStock} IS NULL
            OR ${inventoryMovements.preorderStockDelta} IS NULL
            OR ${inventoryMovements.newStock} - ${inventoryMovements.previousStock} <> ${inventoryMovements.stockDelta}
            OR ${inventoryMovements.newReservedStock} - ${inventoryMovements.previousReservedStock} <> ${inventoryMovements.reservedStockDelta}
            OR ${inventoryMovements.newPreorderStock} - ${inventoryMovements.previousPreorderStock} <> ${inventoryMovements.preorderStockDelta}
        ) THEN 1 ELSE 0 END), 0)`,
    }).from(inventoryMovements).get();

    return result ?? { legacyRows: 0, v2Rows: 0, v2Variants: 0, invalidV2Rows: 0 };
}

export async function getInventoryLabelVariants(
    db: Database,
    requestedVariantIds: readonly string[],
) {
    const variantIds = Array.from(new Set(
        requestedVariantIds.map((id) => id.trim()).filter(Boolean),
    ));
    if (variantIds.length === 0) {
        throw new ValidationError("Select at least one SKU to print labels.");
    }
    if (variantIds.length > INVENTORY_LABEL_VARIANT_LIMIT) {
        throw new ValidationError(
            `A label batch can contain at most ${INVENTORY_LABEL_VARIANT_LIMIT} SKUs.`,
        );
    }
    if (variantIds.some((id) => id.length > 100)) {
        throw new ValidationError("A selected SKU identity is invalid.");
    }

    const variantIdSet = JSON.stringify(variantIds);
    const currencyRead = readStoreCurrency(db);
    const rows = await db
        .select({
            id: productVariants.id,
            productId: productVariants.productId,
            productName: products.name,
            sku: productVariants.sku,
            optionLabel: variantOptionLabelSql(productVariants.id),
            priceMinor: productVariants.priceMinor,
            variantDiscountType: productVariants.discountType,
            variantDiscountBps: productVariants.discountBps,
            variantDiscountAmountMinor: productVariants.discountAmountMinor,
            productDiscountType: products.discountType,
            productDiscountBps: products.discountBps,
            productDiscountAmountMinor: products.discountAmountMinor,
            stock: productVariants.stock,
            reservedStock: productVariants.reservedStock,
            available: availableStockSql,
            barcode: productVariants.barcode,
            barcodeType: productVariants.barcodeType,
            trackInventory: productVariants.trackInventory,
        })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(
            sql`${productVariants.id} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${variantIdSet})
            )`,
            isNull(productVariants.deletedAt),
            isNull(products.deletedAt),
            operationalSkuRowPredicate(),
        ))
        .all();

    const rowById = new Map(rows.map((row) => [row.id, row]));
    const { decimalPlaces, priceIncrementMinor } = await currencyRead;
    return {
        variants: variantIds.flatMap((id) => {
            const row = rowById.get(id);
            if (!row) return [];
            const {
                priceMinor,
                variantDiscountType: _variantDiscountType,
                variantDiscountBps: _variantDiscountBps,
                variantDiscountAmountMinor: _variantDiscountAmountMinor,
                productDiscountType: _productDiscountType,
                productDiscountBps: _productDiscountBps,
                productDiscountAmountMinor: _productDiscountAmountMinor,
                ...variant
            } = row;
            return [{
                ...variant,
                price: fromMinor(priceMinor, decimalPlaces),
                effectivePrice: fromMinor(calculateInventoryLabelEffectivePriceMinor(row, priceIncrementMinor), decimalPlaces),
            }];
        }),
        missingVariantIds: variantIds.filter((id) => !rowById.has(id)),
    };
}

export async function getInventoryOverview(db: Database, params: {
    section: string;
    search: string;
    status: string;
    page: number;
    limit: number;
    alertStatus?: string;
    movementType?: string;
    movementOrderId?: string;
    movementStartDate?: Date;
    movementEndDate?: Date;
    movementCursor?: string;
    movementHealthOnly?: boolean;
    sort?: string;
    order?: string;
    /** Variants section: also return each SKU's on-hand at this location. */
    locationId?: string;
    /** Movements section: only movements at this location. */
    movementLocationId?: string;
}) {
    const { section, search, status, page, limit, alertStatus, movementType, sort, order } = params;

    if (!ALLOWED_INVENTORY_SECTIONS.has(section)) {
        throw new ValidationError("Invalid section parameter");
    }
    if (!ALLOWED_INVENTORY_STATUSES.has(status)) {
        throw new ValidationError("Invalid inventory status parameter");
    }
    if (alertStatus && !ALLOWED_ALERT_STATUSES.has(alertStatus)) {
        throw new ValidationError("Invalid alert status parameter");
    }
    if (movementType && !ALLOWED_MOVEMENT_TYPES.has(movementType)) {
        throw new ValidationError("Invalid movement type parameter");
    }
    if (sort && !ALLOWED_INVENTORY_SORTS.has(sort)) {
        throw new ValidationError("Invalid inventory sort parameter");
    }
    if (order && !ALLOWED_SORT_ORDERS.has(order)) {
        throw new ValidationError("Invalid inventory sort order parameter");
    }
    if (!Number.isSafeInteger(page) || page < 1) {
        throw new ValidationError("Inventory page must be a positive safe integer");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
        throw new ValidationError("Inventory page size must be between 1 and 100");
    }
    if (search.length > 120) {
        throw new ValidationError("Inventory search must be at most 120 characters");
    }
    const offset = (page - 1) * limit;
    if (!Number.isSafeInteger(offset)) {
        throw new ValidationError("Inventory page offset exceeds the safe integer range");
    }

    if (section === "variants") {
        const locationId = params.locationId?.trim() || null;
        if (locationId) {
            const location = await db.select({ id: inventoryLocations.id })
                .from(inventoryLocations)
                .where(eq(inventoryLocations.id, locationId))
                .get();
            if (!location) throw new ValidationError("Unknown inventory location");
        }
        // The tracked SKUs the section covers; the stats summarize all of them.
        const baseConditions: SQL[] = [
            isNull(productVariants.deletedAt),
            isNull(products.deletedAt),
            eq(productVariants.trackInventory, true),
            operationalSkuRowPredicate(),
        ];
        const filters: SQL[] = [];

        if (status === "low") {
            filters.push(buildInventoryLowStockCondition());
        } else if (status === "out") {
            filters.push(sql`${availableStockSql} <= 0`);
        } else if (status === "reserved") {
            filters.push(sql`${productVariants.reservedStock} > 0`);
        }

        if (search) {
            filters.push(or(
                containsText(productVariants.sku, search),
                containsText(productVariants.barcode, search),
                containsText(products.name, search)
            )!);
        }

        const availableSql = availableStockSql;
        const sortDirection = order === "desc" ? "desc" : "asc";
        const byDirection = (column: SQLWrapper) => sortDirection === "desc" ? desc(column) : asc(column);
        // The id tie-break follows the sort, so the available sort walks
        // product_variants_available_idx (track_inventory, deleted_at, available, id) in order.
        const orderBy = [
            sort === "productName"
                ? byDirection(products.name)
                : sort === "sku"
                    ? byDirection(productVariants.sku)
                    : byDirection(availableSql),
            sortDirection === "desc" ? desc(productVariants.id) : asc(productVariants.id),
        ];

        // The page's ids first, sorted on the narrow row; the label, incoming
        // and location subqueries then run for those rows only (SQLite
        // computes a sorted select's columns for every row it sorts).
        const pageKeys = db
            .select({ id: productVariants.id })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(and(...baseConditions, ...filters))
            .orderBy(...orderBy)
            .limit(limit)
            .offset(offset);

        const variantsQuery = db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                productName: products.name,
                sku: productVariants.sku,
                barcode: productVariants.barcode,
                barcodeType: productVariants.barcodeType,
                optionLabel: variantOptionLabelSql(productVariants.id),
                priceMinor: productVariants.priceMinor,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
                available: availableSql,
                lowStockThreshold: productVariants.lowStockThreshold,
                version: productVariants.version,
                locationOnHand: locationId ? locationOnHandSql(locationId) : sql<number | null>`NULL`,
                // Open purchase order units and transfers in transit (at the location filter, if any).
                incoming: incomingUnitsSql(sql.raw('"product_variants"."id"'), locationId),
                costMinor: productVariants.costMinor,
                storeCurrencyCode: storeCurrencyCodeSql(),
            })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(inArray(productVariants.id, pageKeys))
            .orderBy(...orderBy);

        // One pass over the tracked SKUs answers the stats and the filtered
        // total together (the total is every SKU when nothing filters).
        // Aliased: D1 keys result columns by name, and two bare count(*)
        // columns would collapse into one.
        const matchingCount = (filters.length > 0
            ? sql<number>`COALESCE(SUM(CASE WHEN ${and(...filters)} THEN 1 ELSE 0 END), 0)`
            : sql<number>`count(*)`).as("inventory_matching_variants");
        const statsQuery = db
            .select({
                matching: matchingCount,
                totalVariants: sql<number>`count(*)`,
                totalOnHand: sql<number>`COALESCE(SUM(${productVariants.stock}), 0)`,
                totalReserved: sql<number>`COALESCE(SUM(${productVariants.reservedStock}), 0)`,
                totalAvailable: sql<number>`COALESCE(SUM(${availableStockSql}), 0)`,
                outOfStockCount: sql<number>`COALESCE(SUM(CASE WHEN ${availableStockSql} <= 0 THEN 1 ELSE 0 END), 0)`,
                lowStockCount: sql<number>`COALESCE(SUM(CASE WHEN ${buildInventoryLowStockCondition()} THEN 1 ELSE 0 END), 0)`,
                defaultLowStockThreshold: storeDefaultLowStockThresholdSql(),
            })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .where(and(...baseConditions));

        const [variantRows, statsRows] = await db.batch([
            variantsQuery,
            statsQuery,
        ]);
        const { defaultLowStockThreshold, matching, ...statsResult } = statsRows[0] ?? {
            matching: 0,
            totalVariants: 0,
            totalOnHand: 0,
            totalReserved: 0,
            totalAvailable: 0,
            outOfStockCount: 0,
            lowStockCount: 0,
            defaultLowStockThreshold: null,
        };

        return {
            variants: variantRows.map(({ priceMinor, costMinor, storeCurrencyCode, locationOnHand, incoming, ...variant }) => ({
                ...variant,
                price: fromMinor(priceMinor, storeDecimalPlacesFromCode(storeCurrencyCode)),
                cost: costMinor == null ? null : fromMinor(costMinor, storeDecimalPlacesFromCode(storeCurrencyCode)),
                incoming: Number(incoming ?? 0),
                // On-hand at the filtered location; null without a location filter.
                locationOnHand: locationId ? Number(locationOnHand ?? 0) : null,
            })),
            defaultLowStockThreshold: defaultLowStockThreshold ?? null,
            pagination: {
                page,
                limit,
                total: Number(matching ?? 0),
                totalPages: Math.ceil(Number(matching ?? 0) / limit),
            },
            stats: statsResult,
        };
    }

    if (section === "movements") {
        if (params.movementHealthOnly) {
            return { ledgerHealth: await getInventoryLedgerHealth(db) };
        }
        return listInventoryMovements(db, {
            search,
            movementType,
            orderId: params.movementOrderId,
            locationId: params.movementLocationId,
            startDate: params.movementStartDate,
            endDate: params.movementEndDate,
            cursor: params.movementCursor,
            limit,
        });
    }

    if (section === "alerts") {
        const aStatus = alertStatus ?? "active";
        const needs = buildNeedsRestockCondition();
        const acknowledged = sql`${productLowStockAlerts.alertStatus} = 'acknowledged'`;
        const alertConditions: SQL[] = [
            isNull(products.deletedAt),
            isNull(productVariants.deletedAt),
            eq(productVariants.trackInventory, true),
            operationalSkuRowPredicate(),
        ];
        if (aStatus === "active" || aStatus === "acknowledged") {
            // Seek the restock index before resolving each candidate's exact inherited threshold.
            const storeThreshold = storeDefaultLowStockThresholdSql();
            alertConditions.push(sql`(${productVariants.stock} - ${productVariants.reservedStock} - CASE WHEN ${productVariants.lowStockThreshold} IS NULL THEN 0 ELSE ${productVariants.lowStockThreshold} END)
                <= CASE WHEN ${storeThreshold} > 0 THEN ${storeThreshold} ELSE 0 END`);
        }
        // Live stock decides what needs review; a stored alert row only
        // remembers that the merchant marked it as seen (or that it was low).
        if (aStatus === "active") alertConditions.push(sql`(${needs} AND COALESCE(${acknowledged}, 0) = 0)`);
        else if (aStatus === "acknowledged") alertConditions.push(sql`(${needs} AND ${acknowledged})`);
        else if (aStatus === "resolved") alertConditions.push(sql`(NOT ${needs} AND ${productLowStockAlerts.id} IS NOT NULL)`);
        else alertConditions.push(sql`(${needs} OR ${productLowStockAlerts.id} IS NOT NULL)`);
        if (search.trim()) {
            alertConditions.push(or(
                containsText(productVariants.sku, search.trim()),
                containsText(products.name, search.trim()),
            )!);
        }
        const alertWhere = and(...alertConditions);
        const alertJoin = eq(productLowStockAlerts.variantId, productVariants.id);

        const alertOrder = [asc(availableStockSql), asc(products.name), asc(productVariants.id)];
        // The page's ids first, on the narrow row: the option label runs for the page only.
        const alertPageKeys = db
            .select({ id: productVariants.id })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .leftJoin(productLowStockAlerts, alertJoin)
            .where(alertWhere)
            .orderBy(...alertOrder)
            .limit(limit)
            .offset(offset);

        const countResult = await db
            .select({ count: sql<number>`count(*)`, defaultLowStockThreshold: storeDefaultLowStockThresholdSql() })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .leftJoin(productLowStockAlerts, alertJoin)
            .where(alertWhere)
            .get();
        const alerts = await db
            .select({
                id: sql<string>`COALESCE(${productLowStockAlerts.id}, ${productVariants.id})`,
                variantId: productVariants.id,
                productId: productVariants.productId,
                currentQty: availableStockSql,
                threshold: sql<number>`COALESCE(${effectiveLowStockThresholdSql()}, 0)`,
                alertStatus: sql<string>`CASE WHEN ${needs}
                    THEN CASE WHEN ${acknowledged} THEN 'acknowledged' ELSE 'active' END
                    ELSE 'resolved' END`,
                alertSentAt: sql<number | null>`${productLowStockAlerts.alertSentAt}`,
                acknowledgedAt: sql<number | null>`${productLowStockAlerts.acknowledgedAt}`,
                resolvedAt: sql<number | null>`${productLowStockAlerts.resolvedAt}`,
                createdAt: sql<number>`COALESCE(${productLowStockAlerts.createdAt}, ${productVariants.updatedAt})`,
                updatedAt: sql<number>`COALESCE(${productLowStockAlerts.updatedAt}, ${productVariants.updatedAt})`,
                productName: products.name,
                variantSku: productVariants.sku,
                variantLabel: variantOptionLabelSql(productVariants.id),
            })
            .from(productVariants)
            .innerJoin(products, eq(products.id, productVariants.productId))
            .leftJoin(productLowStockAlerts, alertJoin)
            .where(inArray(productVariants.id, alertPageKeys))
            .orderBy(...alertOrder)
            .all();

        return {
            alerts,
            defaultLowStockThreshold: countResult?.defaultLowStockThreshold ?? null,
            pagination: {
                page,
                limit,
                total: countResult?.count ?? 0,
                totalPages: Math.ceil((countResult?.count ?? 0) / limit),
            },
        };
    }
    throw new ValidationError("Invalid section parameter");
}

export async function adjustInventory(db: Database, variantId: string, payload: {
    operationKey: string;
    delta: number;
    reason: string;
    notes?: string;
    pool?: string;
    locationId?: string;
}, adminUserId?: string) {
    const parsedPayload = adjustInventorySchema.safeParse(payload);
    if (!parsedPayload.success) {
        throw new ValidationError(
            parsedPayload.error.issues[0]?.message ?? "Invalid stock adjustment",
        );
    }
    const { operationKey, pool, delta, reason, notes, locationId } = parsedPayload.data;
    return executeInventoryOperation(db, {
        operationKey,
        operationType: "manual_adjustment",
        variantId,
        pool,
        mode: "relative",
        delta,
        reason,
        ...(notes ? { notes } : {}),
        ...(locationId ? { locationId } : {}),
    }, adminUserId);
}
