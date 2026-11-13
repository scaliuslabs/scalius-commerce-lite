// The product list's bulk editor: the selected products and their SKUs in one
// read, with what the editor changes (status, price and compare-at price of a
// product without options, shipping profile, each shipped SKU's weight, on-hand
// at the default location) and the revisions its writes are checked against.
//
// Its save (`saveProductBulkEdits`) is one request for every row: one read
// batch checks every row's revision and SKUs, then each product commits in one
// batch of its own, so a row that fails (a stale revision, a refused value)
// fails alone and the others stay saved. The writes are the editor's own:
// the base section's plan (`planProductBaseSection`), the SKU weight, and the
// counted quantities as one stock command (ledger-v2 `adjusted` movements at
// the default location, stockVersion CAS) whose subject is the product: its
// revision guard opens the batch and its document writes are the product's
// writes and revision bump, so a repeat of a committed request finds the
// revision moved and applies nothing twice.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { inventoryLevels, inventoryLocations, products, productVariants } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { AppError, ConflictError, ValidationError } from "@scalius/core/errors";
import {
    digitalStockError,
    isDigitalKind,
    readStoreDecimalPlaces,
    rethrowDigitalStockRuleViolation,
    rethrowGiftCardProductRuleViolation,
    variantOptionLabelSql,
} from "../products";
import {
    executeStockCommand,
    StockCommandSubjectMovedError,
    type InventoryLocationRef,
    type StockCommandLine,
} from "../inventory";
import { qualifiedColumn } from "../../utils/qualified-column";
import { inJsonArray } from "../../utils/in-json-array";
import { mapWithBoundedConcurrency } from "../../utils/bounded-concurrency";
import { executeProductAggregateMutationBatch, productAggregateMutationTail, ProductRevisionConflictError } from "./aggregate-revision";
import { planProductBaseSection } from "./semantic-sections";

/** At most this many products open in the bulk editor at once. */
export const PRODUCT_BULK_EDIT_MAX = 50;

export interface ProductBulkEditSku {
    id: string;
    /** "Black / M"; null for a product without options. */
    label: string | null;
    sku: string;
    trackInventory: boolean;
    /** On hand at the default location (where editor quantities are booked); null when not tracked. */
    onHand: number | null;
    /** A physical SKU: it ships, so it has a weight. */
    ships: boolean;
    /** Grams; null: no weight (it weighs its profile's default weight, else the store's, else 0 g). */
    weightGrams: number | null;
}

export interface ProductBulkEditRow {
    id: string;
    name: string;
    isActive: boolean;
    aggregateRevision: number;
    /** The stored base price and product discount, in major units (the editor shows Price and Compare-at from them). */
    price: number;
    discountType: "percentage" | "flat";
    discountPercentage: number;
    discountAmount: number;
    /** Options make prices per variant (edited on the product page). */
    hasOptions: boolean;
    /** The product's shipping profile; null: the default (General). */
    shippingProfileId: string | null;
    skus: ProductBulkEditSku[];
}

export async function readProductsForBulkEdit(db: Database, ids: readonly string[]): Promise<ProductBulkEditRow[]> {
    const lookup = Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, PRODUCT_BULK_EDIT_MAX);
    if (lookup.length === 0) return [];
    const [rows, skus, decimalPlaces] = await Promise.all([
        db.select({
            id: products.id,
            name: products.name,
            isActive: products.isActive,
            aggregateRevision: products.aggregateRevision,
            priceMinor: products.priceMinor,
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
            shippingProfileId: products.shippingProfileId,
        }).from(products).where(and(inArray(products.id, lookup), isNull(products.deletedAt))),
        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            isDefault: productVariants.isDefault,
            sku: productVariants.sku,
            trackInventory: productVariants.trackInventory,
            label: variantOptionLabelSql(productVariants.id),
            onHand: sql<number | null>`(SELECT ${inventoryLevels.onHand} FROM ${inventoryLevels}
                JOIN ${inventoryLocations} ON ${inventoryLocations.id} = ${inventoryLevels.locationId}
                WHERE ${inventoryLevels.variantId} = ${qualifiedColumn(productVariants.id)} AND ${inventoryLocations.isDefault} = 1)`,
            stock: productVariants.stock,
            weight: productVariants.weight,
            fulfillmentKind: productVariants.fulfillmentKind,
        }).from(productVariants)
            .where(and(inArray(productVariants.productId, lookup), isNull(productVariants.deletedAt)))
            .orderBy(asc(productVariants.productId), asc(productVariants.createdAt), asc(productVariants.id)),
        readStoreDecimalPlaces(db),
    ]);
    const skusByProduct = new Map<string, ProductBulkEditSku[]>();
    const optioned = new Set<string>();
    for (const row of skus) {
        if (!row.isDefault) optioned.add(row.productId);
        const list = skusByProduct.get(row.productId) ?? [];
        list.push({
            id: row.id,
            label: row.isDefault ? null : row.label,
            sku: row.sku,
            trackInventory: row.trackInventory,
            // A store that never split stock by location keeps it on the SKU row.
            onHand: row.trackInventory ? row.onHand ?? row.stock : null,
            ships: row.fulfillmentKind === "physical",
            weightGrams: row.weight ?? null,
        });
        skusByProduct.set(row.productId, list);
    }
    const order = new Map(lookup.map((id, index) => [id, index]));
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        aggregateRevision: row.aggregateRevision,
        price: fromMinor(row.priceMinor, decimalPlaces),
        discountType: row.discountType === "flat" ? "flat" as const : "percentage" as const,
        discountPercentage: (row.discountBps ?? 0) / 100,
        discountAmount: fromMinor(row.discountAmountMinor ?? 0, decimalPlaces),
        hasOptions: optioned.has(row.id),
        shippingProfileId: row.shippingProfileId ?? null,
        skus: (skusByProduct.get(row.id) ?? []).filter((sku) => !optioned.has(row.id) || sku.label !== null),
    })).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** The base fields the bulk editor changes (major units, as the base section takes them). */
export interface ProductBulkEditBase {
    isActive?: boolean;
    price?: number;
    discountType?: "percentage" | "flat";
    discountPercentage?: number | null;
    discountAmount?: number | null;
    /** Null: the default profile (General). */
    shippingProfileId?: string | null;
}

/** One row of a bulk editor save: only what changed. */
export interface ProductBulkEditSaveRow {
    id: string;
    /** The product's aggregateRevision the editor read. */
    expectedAggregateRevision: number;
    base?: ProductBulkEditBase;
    skus?: Array<{
        id: string;
        /** Grams; null: no weight. A shipped SKU only. */
        weightGrams?: number | null;
        /** The counted quantity at the default location. A tracked, physical SKU only. */
        onHand?: number;
    }>;
}

export type ProductBulkEditOutcome =
    | { id: string; status: "saved"; aggregateRevision: number }
    | { id: string; status: "failed"; code: string; message: string; field?: string };

/** Products one save handles at once (each its own batch); several at once bound the wait. */
const ROW_CONCURRENCY = 4;
/** The ledger note of a counted quantity set in the bulk editor. */
export const PRODUCT_BULK_EDIT_STOCK_REASON = "Bulk edit";

type SkuState = {
    id: string;
    productId: string;
    fulfillmentKind: string;
    trackInventory: boolean;
};

const STALE = (expected: number, current: number | null): ProductBulkEditOutcome & { status: "failed" } => {
    const error = new ProductRevisionConflictError(expected, current);
    return { id: "", status: "failed", code: error.code, message: error.message };
};

function failure(id: string, error: unknown): ProductBulkEditOutcome {
    if (error instanceof StockCommandSubjectMovedError) {
        return { ...STALE(0, null), id };
    }
    if (error instanceof AppError) {
        const field = (error.details as { field?: unknown } | undefined)?.field;
        return { id, status: "failed", code: error.code, message: error.message, ...(typeof field === "string" ? { field } : {}) };
    }
    console.error(`[product-admin] bulk edit row failed: ${error instanceof Error ? error.name : "error"}`);
    return { id, status: "failed", code: "save_failed", message: "This product could not be saved. Try again." };
}

/** On hand at `location` for these SKUs (no row: none there), in one read whatever their count. */
async function readOnHandAt(db: Database, location: InventoryLocationRef, variantIds: readonly string[]): Promise<Map<string, number>> {
    if (variantIds.length === 0) return new Map();
    const rows = await db.select({ variantId: inventoryLevels.variantId, onHand: inventoryLevels.onHand })
        .from(inventoryLevels)
        .where(and(eq(inventoryLevels.locationId, location.id), inJsonArray(inventoryLevels.variantId, variantIds)));
    return new Map(rows.map((row) => [row.variantId, row.onHand]));
}

/**
 * Saves the bulk editor's changed rows in one call (see the file comment).
 * `rowsPerRequest` bounds the rows this call commits (the plan's queries per
 * request); the rest come back as `remaining`, untouched, for the next call.
 * `operationKey` is the request's retry key: each product's stock movements
 * derive their ids from it and the product.
 */
export async function saveProductBulkEdits(
    db: Database,
    rows: readonly ProductBulkEditSaveRow[],
    options: { operationKey: string; actorId?: string | null; rowsPerRequest: number },
): Promise<{ results: ProductBulkEditOutcome[]; remaining: string[] }> {
    if (rows.length === 0) throw new ValidationError("Send at least one product to save.");
    if (rows.length > PRODUCT_BULK_EDIT_MAX) throw new ValidationError(`Save at most ${PRODUCT_BULK_EDIT_MAX} products at once.`);
    const ids = rows.map((row) => row.id);
    if (new Set(ids).size !== ids.length) throw new ValidationError("Each product may appear only once in a bulk edit.");
    const now = rows.slice(0, Math.max(1, options.rowsPerRequest));
    const remaining = rows.slice(now.length).map((row) => row.id);
    const skuIds = [...new Set(now.flatMap((row) => (row.skus ?? []).map((sku) => sku.id)))];
    const counted = now.some((row) => row.skus?.some((sku) => sku.onHand !== undefined));

    // One read for every row: revisions, the SKUs named, and the default location with their on-hand there.
    const [productRows, skuRows, locationRows, levelRows] = await safeBatch(db, [
        db.select({ id: products.id, aggregateRevision: products.aggregateRevision, deletedAt: products.deletedAt })
            .from(products).where(inJsonArray(products.id, now.map((row) => row.id))),
        db.select({
            id: productVariants.id,
            productId: productVariants.productId,
            fulfillmentKind: productVariants.fulfillmentKind,
            trackInventory: productVariants.trackInventory,
            // `+deleted_at` below: the id list leads the plan, never the live-row index.
        }).from(productVariants).where(and(inJsonArray(productVariants.id, skuIds.length > 0 ? skuIds : [""]), sql`+${productVariants.deletedAt} IS NULL`)),
        db.select({ id: inventoryLocations.id, name: inventoryLocations.name }).from(inventoryLocations)
            .where(and(eq(inventoryLocations.isDefault, true), eq(inventoryLocations.status, "active"))).limit(1),
        db.select({ variantId: inventoryLevels.variantId, onHand: inventoryLevels.onHand })
            .from(inventoryLevels)
            .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryLevels.locationId))
            .where(and(
                eq(inventoryLocations.isDefault, true),
                inJsonArray(inventoryLevels.variantId, counted && skuIds.length > 0 ? skuIds : [""]),
            )),
    ] as never) as [
        Array<{ id: string; aggregateRevision: number; deletedAt: Date | null }>,
        SkuState[],
        Array<{ id: string; name: string }>,
        Array<{ variantId: string; onHand: number }>,
    ];
    const productsById = new Map(productRows.map((row) => [row.id, row]));
    const skus = new Map(skuRows.map((row) => [row.id, row]));
    const location: InventoryLocationRef | null = locationRows[0] ?? null;
    const firstOnHand = new Map(levelRows.map((row) => [row.variantId, row.onHand]));

    const results = new Map<string, ProductBulkEditOutcome>();
    const ready: ProductBulkEditSaveRow[] = [];
    for (const row of now) {
        const problem = checkRow(row, productsById.get(row.id), skus, location);
        if (problem) results.set(row.id, { ...problem, id: row.id });
        else ready.push(row);
    }
    await mapWithBoundedConcurrency(ready, ROW_CONCURRENCY, async (row) => {
        try {
            results.set(row.id, await saveRow(db, row, { ...options, location, firstOnHand }));
        } catch (error) {
            results.set(row.id, failure(row.id, error));
        }
    });
    return { results: now.map((row) => results.get(row.id)!), remaining };
}

/** What makes a row fail before any write: a stale or missing product, a SKU that is not its, or not one the field applies to. */
function checkRow(
    row: ProductBulkEditSaveRow,
    product: { aggregateRevision: number; deletedAt: Date | null } | undefined,
    skus: ReadonlyMap<string, SkuState>,
    location: InventoryLocationRef | null,
): Omit<Extract<ProductBulkEditOutcome, { status: "failed" }>, "id"> | null {
    if (!product || product.deletedAt) return { status: "failed", code: "not_found", message: "This product was deleted or moved to trash." };
    if (product.aggregateRevision !== row.expectedAggregateRevision) {
        const { id: _id, ...stale } = STALE(row.expectedAggregateRevision, product.aggregateRevision);
        return stale;
    }
    for (const change of row.skus ?? []) {
        const sku = skus.get(change.id);
        if (!sku || sku.productId !== row.id) return { status: "failed", code: "not_found", message: "A SKU of this product was removed. Reload to see its SKUs.", field: `skus.${change.id}` };
        if (change.weightGrams !== undefined && sku.fulfillmentKind !== "physical") {
            return { status: "failed", code: "validation_error", message: "Only a SKU that ships has a weight.", field: `skus.${change.id}.weightGrams` };
        }
        if (change.onHand !== undefined) {
            if (isDigitalKind(sku.fulfillmentKind)) {
                const error = digitalStockError({ variantId: sku.id });
                return { status: "failed", code: error.code, message: error.message, field: `skus.${change.id}.onHand` };
            }
            if (sku.fulfillmentKind !== "physical" || !sku.trackInventory) {
                return { status: "failed", code: "validation_error", message: "This SKU does not track stock.", field: `skus.${change.id}.onHand` };
            }
            if (!location) return { status: "failed", code: "conflict", message: "No default inventory location is set. Set one in Settings → Locations." };
        }
    }
    return null;
}

/** One product's changes in one batch (see the file comment). */
async function saveRow(
    db: Database,
    row: ProductBulkEditSaveRow,
    context: { operationKey: string; actorId?: string | null; location: InventoryLocationRef | null; firstOnHand: ReadonlyMap<string, number> },
): Promise<ProductBulkEditOutcome> {
    const productId = row.id;
    const expected = row.expectedAggregateRevision;
    const base = row.base && Object.values(row.base).some((value) => value !== undefined) ? row.base : null;
    const planWrites = async (): Promise<BatchItem<"sqlite">[]> => {
        const statements: BatchItem<"sqlite">[] = [];
        if (base) {
            const planned = await planProductBaseSection(db, productId, base);
            if (!planned) throw new ConflictError("This product was deleted or moved to trash.");
            statements.push(...(planned as BatchItem<"sqlite">[]));
        }
        for (const sku of row.skus ?? []) {
            if (sku.weightGrams === undefined) continue;
            statements.push(db.update(productVariants)
                .set({ weight: sku.weightGrams, updatedAt: sql`unixepoch()` })
                .where(and(eq(productVariants.id, sku.id), eq(productVariants.productId, productId), isNull(productVariants.deletedAt))) as BatchItem<"sqlite">);
        }
        return statements;
    };
    const counts = (row.skus ?? []).filter((sku): sku is typeof sku & { onHand: number } => sku.onHand !== undefined);
    const location = context.location;
    const linesFrom = (onHand: ReadonlyMap<string, number>): StockCommandLine[] => counts
        .map((sku) => ({ sku, delta: sku.onHand - (onHand.get(sku.id) ?? 0) }))
        .filter(({ delta }) => delta !== 0)
        .map(({ sku, delta }) => ({
            variantId: sku.id,
            location: location!,
            type: "adjusted" as const,
            quantity: delta,
            notes: `${PRODUCT_BULK_EDIT_STOCK_REASON}: ${location!.name} counted ${sku.onHand}`,
        }));
    const firstLines = location ? linesFrom(context.firstOnHand) : [];
    try {
        if (firstLines.length === 0) {
            const writes = await planWrites();
            if (writes.length === 0) return { id: productId, status: "saved", aggregateRevision: expected };
            const { aggregateRevision } = await executeProductAggregateMutationBatch(db, productId, expected, writes);
            return { id: productId, status: "saved", aggregateRevision };
        }
        // The first attempt uses the read above; a lost stock race re-reads this product's counts.
        let reuse = true;
        return await executeStockCommand(db, {
            operationKey: `${context.operationKey}:${productId}`,
            replay: "subject",
            commandType: "bulk_set_quantities",
            subjectId: productId,
            request: { locationId: location!.id, counts: counts.map((sku) => [sku.id, sku.onHand]) },
            createdBy: context.actorId ?? null,
            plan: async () => {
                const lines = reuse ? firstLines : linesFrom(await readOnHandAt(db, location!, counts.map((sku) => sku.id)));
                reuse = false;
                const writes = await planWrites();
                // Counts that now match need no movement; the rest of the row still saves.
                if (lines.length === 0) throw new StockMatchedError();
                return {
                    lines,
                    subjectGuard: sql`EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = ${productId}
                        AND ${products.aggregateRevision} = ${expected} AND ${products.deletedAt} IS NULL)`,
                    subjectRevisionAfter: expected + 1,
                    documentStatements: () => [...writes, ...productAggregateMutationTail(db, productId)],
                    result: () => ({ id: productId, status: "saved" as const, aggregateRevision: expected + 1 }),
                };
            },
        });
    } catch (error) {
        if (error instanceof StockMatchedError) {
            const writes = await planWrites();
            const { aggregateRevision } = await executeProductAggregateMutationBatch(db, productId, expected, writes);
            return { id: productId, status: "saved", aggregateRevision };
        }
        rethrowGiftCardProductRuleViolation(error);
        rethrowDigitalStockRuleViolation(error);
        throw error;
    }
}

/** A re-planned stock command found every count already true. */
class StockMatchedError extends Error {}

