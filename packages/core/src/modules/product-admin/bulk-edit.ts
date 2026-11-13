// The product list's bulk editor: the selected products and their SKUs in one
// read, with what the editor changes (status, price and compare-at price of a
// product without options, shipping profile, each shipped SKU's weight, on-hand
// at the default location) and the revisions its writes are checked against.
//
// Its save (`saveProductBulkEdits`) is one request for every row and a
// constant number of D1 calls whatever the row count: one read batch checks
// every row's revision and SKUs and plans its writes by the product editor's
// rules (the base section's discount, shipping profile and default-SKU price;
// the SKU weight; counted quantities as ledger-v2 `adjusted` movements at the
// default location), then ONE commit batch writes all rows with one statement
// per kind of change over a JSON row set, each row's checks inside it
// (`commitPlans`). A row another write moved between the read and the commit
// (its revision, or a counted SKU's stock version) is left whole and reported
// on its own; the others commit. A row that fails its checks at the read
// fails alone before any write. Each count names the stock version it was
// made against: a sale (or any stock move) since refuses that row
// (`stock_changed`) instead of booking it back. A repeat of a committed
// request finds the revisions moved and applies nothing twice (and each
// movement's id derives from the request's key, the product and the SKU).
//
// A request commits the rows whose counted SKUs' low-stock refresh fits the
// plan's D1 budget (`lists.bulkEditQueries`, `productBulkEditRequestCost`):
// on Free a screen of 50 products with up to about 1,000 counted SKUs; the
// rest come back as `remaining`. Low-stock alerts refresh once for the
// whole request, in one batched pass.
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import {
    DEFAULT_SHIPPING_PROFILE_ID,
    inventoryLevels,
    inventoryLocations,
    inventoryMovements,
    products,
    productVariants,
    shippingProfiles,
} from "@scalius/database/schema";
import { D1_ID_CHUNK_SIZE, safeBatch, type Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { AppError, ValidationError } from "@scalius/core/errors";
import {
    catalogPriceColumns,
    catalogProjectionRefreshStatements,
    digitalStockError,
    GIFT_CARD_PRODUCT_RULES_MESSAGE,
    isDigitalKind,
    readStoreDecimalPlaces,
    rethrowDigitalStockRuleViolation,
    rethrowGiftCardProductRuleViolation,
    variantOptionLabelSql,
} from "../products";
import {
    inventoryLocationErrorFrom,
    isInventoryLevelShortfallError,
    isInventoryLocationRequiredError,
    movementIdFor,
    normalizeInventoryOperationKey,
    refreshLowStockAlerts,
    type InventoryLocationRef,
} from "../inventory";
import { readStoreCurrency } from "../markets";
import { qualifiedColumn } from "../../utils/qualified-column";
import { inJsonArray } from "../../utils/in-json-array";
import { ProductRevisionConflictError } from "./aggregate-revision";

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
    /** The SKU's stock version: a count saved against it is refused once any stock moved since. */
    stockVersion: number;
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
            stockVersion: productVariants.stockVersion,
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
            stockVersion: row.stockVersion,
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

/** One row of a bulk editor save: only the cells the merchant changed. */
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
        /** With `onHand`: the SKU's stockVersion the count was made against. */
        expectedStockVersion?: number;
    }>;
}

export type ProductBulkEditOutcome =
    | { id: string; status: "saved"; aggregateRevision: number }
    | { id: string; status: "failed"; code: string; message: string; field?: string };

/** The ledger note of a counted quantity set in the bulk editor. */
export const PRODUCT_BULK_EDIT_STOCK_REASON = "Bulk edit";

/**
 * D1 calls one save spends, whatever its rows: the read batch (with the
 * store's currency), the commit batch, the read that names a row the commit
 * refused, and the low-stock refresh of the counted SKUs (two per 90). Rows
 * cost nothing more: every kind of change is one statement over all of them.
 */
export function productBulkEditRequestCost(countedSkus: number): number {
    return 4 + 2 * Math.ceil(countedSkus / D1_ID_CHUNK_SIZE);
}

function hasBase(row: ProductBulkEditSaveRow): boolean {
    return Boolean(row.base && Object.values(row.base).some((value) => value !== undefined));
}

function countsOf(row: ProductBulkEditSaveRow) {
    return (row.skus ?? []).filter((sku): sku is typeof sku & { onHand: number } => sku.onHand !== undefined);
}

type SkuState = {
    id: string;
    productId: string;
    fulfillmentKind: string;
    trackInventory: boolean;
    stockVersion: number;
};

type ProductState = {
    id: string;
    aggregateRevision: number;
    deletedAt: Date | null;
    isActive: boolean;
    priceMinor: number;
    discountType: string | null;
    discountBps: number | null;
    discountAmountMinor: number | null;
    isGiftCard: boolean;
};

type Topology = { total: number; defaults: number; invalid: number };

type Failure = Omit<Extract<ProductBulkEditOutcome, { status: "failed" }>, "id">;

function stale(expected: number, current: number | null): Failure {
    const error = new ProductRevisionConflictError(expected, current);
    return { status: "failed", code: error.code, message: error.message };
}

function stockChanged(field: string): Failure {
    return { status: "failed", code: "stock_changed", message: "This SKU's stock changed since you opened it (a sale or another count). Its on hand was reloaded; count it again.", field };
}

function invalid(message: string, field?: string): Failure {
    return { status: "failed", code: "validation_error", message, ...(field ? { field } : {}) };
}

/** The base columns a row writes, as the base section would (`planProductBaseSection`). */
interface BaseWrite {
    id: string;
    a: boolean;
    pm: number;
    dt: "percentage" | "flat";
    db: number;
    da: number;
    /** 1: the shipping profile changes to `sp` (null: General) with `fd`. */
    s: 0 | 1;
    sp: string | null;
    fd: boolean;
    /** The single default SKU's new price, when the price or status changed. */
    dp: number | null;
}

/** One counted SKU: its product, the version and on hand it was counted against, the change and its movement. */
interface CountWrite { p: string; v: string; ver: number; b: number; d: number; m: string; n: string }

/** A row's writes, planned from the one read; the commit's statements carry every row's. */
interface RowPlan {
    row: ProductBulkEditSaveRow;
    base: BaseWrite | null;
    weights: Array<{ p: string; v: string; g: number | null }>;
    counts: CountWrite[];
}

/**
 * Saves the bulk editor's changed rows (see the file comment) in a constant
 * number of D1 calls. `queryBudget` bounds the request's D1 calls: the rows
 * whose counted SKUs it can refresh alerts for are saved, in order (always at
 * least one); the rest come back as `remaining`, untouched, for the next call.
 * `operationKey` is the request's retry key: each counted SKU's movement
 * derives its id from it, the product and the SKU.
 */
export async function saveProductBulkEdits(
    db: Database,
    rows: readonly ProductBulkEditSaveRow[],
    options: { operationKey: string; actorId?: string | null; queryBudget: number },
): Promise<{ results: ProductBulkEditOutcome[]; remaining: string[] }> {
    if (rows.length === 0) throw new ValidationError("Send at least one product to save.");
    if (rows.length > PRODUCT_BULK_EDIT_MAX) throw new ValidationError(`Save at most ${PRODUCT_BULK_EDIT_MAX} products at once.`);
    const ids = rows.map((row) => row.id);
    if (new Set(ids).size !== ids.length) throw new ValidationError("Each product may appear only once in a bulk edit.");
    for (const row of rows) {
        for (const sku of row.skus ?? []) {
            if (sku.onHand !== undefined && sku.expectedStockVersion === undefined) {
                throw new ValidationError("A counted quantity names the stock version it was counted against.", { field: `skus.${sku.id}.expectedStockVersion` });
            }
        }
    }
    // The rows this call can afford: only counted SKUs cost (their alerts' refresh).
    const now: ProductBulkEditSaveRow[] = [];
    let counted = 0;
    for (const row of rows) {
        const rowCounts = countsOf(row).length;
        if (now.length > 0 && productBulkEditRequestCost(counted + rowCounts) > options.queryBudget) break;
        now.push(row);
        counted += rowCounts;
    }
    const remaining = rows.slice(now.length).map((row) => row.id);
    const productIds = now.map((row) => row.id);
    const skuIds = [...new Set(now.flatMap((row) => (row.skus ?? []).map((sku) => sku.id)))];
    const profileIds = [...new Set(now.flatMap((row) => {
        const id = row.base?.shippingProfileId?.trim();
        return id && id !== DEFAULT_SHIPPING_PROFILE_ID ? [id] : [];
    }))];
    const money = now.some((row) => row.base && (row.base.price !== undefined || row.base.discountPercentage !== undefined || row.base.discountAmount !== undefined));

    // One read for every row: revisions and base fields, the SKUs named, the default location with their on hand there,
    // each product's SKU topology and the shipping profiles named.
    const [[productRows, skuRows, locationRows, levelRows, topologyRows, profileRows], currency] = await Promise.all([
        safeBatch(db, [
            db.select({
                id: products.id,
                aggregateRevision: products.aggregateRevision,
                deletedAt: products.deletedAt,
                isActive: products.isActive,
                priceMinor: products.priceMinor,
                discountType: products.discountType,
                discountBps: products.discountBps,
                discountAmountMinor: products.discountAmountMinor,
                isGiftCard: products.isGiftCard,
            }).from(products).where(inJsonArray(products.id, productIds)),
            db.select({
                id: productVariants.id,
                productId: productVariants.productId,
                fulfillmentKind: productVariants.fulfillmentKind,
                trackInventory: productVariants.trackInventory,
                stockVersion: productVariants.stockVersion,
                // `+deleted_at` below: the id list leads the plan, never the live-row index.
            }).from(productVariants).where(and(inJsonArray(productVariants.id, skuIds.length > 0 ? skuIds : [""]), sql`+${productVariants.deletedAt} IS NULL`)),
            db.select({ id: inventoryLocations.id, name: inventoryLocations.name }).from(inventoryLocations)
                .where(and(eq(inventoryLocations.isDefault, true), eq(inventoryLocations.status, "active"))).limit(1),
            db.select({ variantId: inventoryLevels.variantId, onHand: inventoryLevels.onHand })
                .from(inventoryLevels)
                .innerJoin(inventoryLocations, eq(inventoryLocations.id, inventoryLevels.locationId))
                .where(and(
                    eq(inventoryLocations.isDefault, true),
                    inJsonArray(inventoryLevels.variantId, counted > 0 && skuIds.length > 0 ? skuIds : [""]),
                )),
            db.select({
                productId: productVariants.productId,
                total: sql<number>`count(*)`,
                defaults: sql<number>`sum(CASE WHEN ${productVariants.isDefault} = 1 THEN 1 ELSE 0 END)`,
                invalid: sql<number>`sum(CASE WHEN ${productVariants.isDefault} = 0 AND trim(coalesce(${productVariants.optionCombinationKey}, '')) = '' THEN 1 ELSE 0 END)`,
            }).from(productVariants)
                // `+deleted_at`: the id list leads the plan.
                .where(and(inJsonArray(productVariants.productId, productIds), sql`+${productVariants.deletedAt} IS NULL`))
                .groupBy(productVariants.productId),
            db.select({ id: shippingProfiles.id, freeDelivery: shippingProfiles.freeDelivery }).from(shippingProfiles)
                .where(inJsonArray(shippingProfiles.id, profileIds.length > 0 ? profileIds : [""])),
        ] as never) as Promise<[
            ProductState[],
            SkuState[],
            Array<{ id: string; name: string }>,
            Array<{ variantId: string; onHand: number }>,
            Array<{ productId: string; total: number; defaults: number; invalid: number }>,
            Array<{ id: string; freeDelivery: boolean }>,
        ]>,
        money ? readStoreCurrency(db) : Promise.resolve(null),
    ]);
    const productsById = new Map(productRows.map((row) => [row.id, row]));
    const skus = new Map(skuRows.map((row) => [row.id, row]));
    const location: InventoryLocationRef | null = locationRows[0] ?? null;
    const onHand = new Map(levelRows.map((row) => [row.variantId, row.onHand]));
    const topology = new Map(topologyRows.map((row) => [row.productId, { total: Number(row.total), defaults: Number(row.defaults ?? 0), invalid: Number(row.invalid ?? 0) }]));
    const profiles = new Map(profileRows.map((row) => [row.id, row]));

    const results = new Map<string, ProductBulkEditOutcome>();
    const plans: RowPlan[] = [];
    for (const row of now) {
        const product = productsById.get(row.id);
        const problem = checkRow(row, product, skus, location);
        if (problem) {
            results.set(row.id, { ...problem, id: row.id });
            continue;
        }
        const base = hasBase(row) ? planBase(row, product!, topology.get(row.id) ?? { total: 0, defaults: 0, invalid: 0 }, profiles, currency) : null;
        if (base && "status" in base) {
            results.set(row.id, { ...base, id: row.id });
            continue;
        }
        const productKey = normalizeInventoryOperationKey(`${options.operationKey}:${row.id}`);
        const counts = await Promise.all(countsOf(row).map(async (sku) => ({
            p: row.id,
            v: sku.id,
            ver: sku.expectedStockVersion!,
            b: onHand.get(sku.id) ?? 0,
            d: sku.onHand - (onHand.get(sku.id) ?? 0),
            m: await movementIdFor(productKey, sku.id),
            n: `${PRODUCT_BULK_EDIT_STOCK_REASON}: ${location?.name ?? ""} counted ${sku.onHand}`,
        })));
        const weights = (row.skus ?? []).filter((sku) => sku.weightGrams !== undefined)
            .map((sku) => ({ p: row.id, v: sku.id, g: sku.weightGrams ?? null }));
        // Nothing to write (counts that already match): saved as it is.
        if (!base && weights.length === 0 && counts.every((count) => count.d === 0)) {
            results.set(row.id, { id: row.id, status: "saved", aggregateRevision: row.expectedAggregateRevision });
            continue;
        }
        plans.push({ row, base, weights, counts });
    }

    const moved: string[] = [];
    if (plans.length > 0) {
        try {
            const committed = await commitPlans(db, plans, location, options.actorId ?? null);
            const refused = plans.filter((plan) => !committed.has(plan.row.id));
            for (const plan of plans) {
                const revision = committed.get(plan.row.id);
                if (revision === undefined) continue;
                results.set(plan.row.id, { id: plan.row.id, status: "saved", aggregateRevision: revision });
                moved.push(...plan.counts.filter((count) => count.d !== 0).map((count) => count.v));
            }
            // A row another write moved between the read and the commit: say which, from one read.
            if (refused.length > 0) {
                for (const [id, failure] of await explainRefused(db, refused)) results.set(id, { ...failure, id });
            }
        } catch (error) {
            for (const plan of plans) results.set(plan.row.id, failure(plan.row.id, error));
        }
    }
    // The rows committed: their alerts refresh in one pass, and a failure here never undoes a saved row's answer.
    if (moved.length > 0) {
        try {
            await refreshLowStockAlerts(db, moved);
        } catch (error) {
            console.warn(`[product-admin] bulk edit low-stock refresh failed: ${error instanceof Error ? error.name : "error"}`);
        }
    }
    return { results: now.map((row) => results.get(row.id)!), remaining };
}

function failure(id: string, error: unknown): ProductBulkEditOutcome {
    if (isInventoryLevelShortfallError(error) || isInventoryLocationRequiredError(error)) {
        const located = inventoryLocationErrorFrom(error, "The default location");
        if (located instanceof AppError) return { id, status: "failed", code: located.code, message: located.message };
    }
    if (error instanceof AppError) return { id, status: "failed", code: error.code, message: error.message };
    console.error(`[product-admin] bulk edit failed: ${error instanceof Error ? error.name : "error"}`);
    return { id, status: "failed", code: "save_failed", message: "This product could not be saved. Try again." };
}

/** What makes a row fail before any write: a stale or missing product, a SKU that is not its or moved, or not one the field applies to. */
function checkRow(
    row: ProductBulkEditSaveRow,
    product: ProductState | undefined,
    skus: ReadonlyMap<string, SkuState>,
    location: InventoryLocationRef | null,
): Failure | null {
    if (!product || product.deletedAt) return { status: "failed", code: "not_found", message: "This product was deleted or moved to trash." };
    if (product.aggregateRevision !== row.expectedAggregateRevision) return stale(row.expectedAggregateRevision, product.aggregateRevision);
    for (const change of row.skus ?? []) {
        const sku = skus.get(change.id);
        if (!sku || sku.productId !== row.id) return { status: "failed", code: "not_found", message: "A SKU of this product was removed. Reload to see its SKUs.", field: `skus.${change.id}` };
        if (change.weightGrams !== undefined && sku.fulfillmentKind !== "physical") {
            return invalid("Only a SKU that ships has a weight.", `skus.${change.id}.weightGrams`);
        }
        if (change.onHand !== undefined) {
            if (isDigitalKind(sku.fulfillmentKind)) {
                const error = digitalStockError({ variantId: sku.id });
                return { status: "failed", code: error.code, message: error.message, field: `skus.${change.id}.onHand` };
            }
            if (sku.fulfillmentKind !== "physical" || !sku.trackInventory) return invalid("This SKU does not track stock.", `skus.${change.id}.onHand`);
            if (!location) return { status: "failed", code: "conflict", message: "No default inventory location is set. Set one in Settings → Locations." };
            if (sku.stockVersion !== change.expectedStockVersion) return stockChanged(`skus.${change.id}.onHand`);
        }
    }
    return null;
}

/**
 * The base columns a row writes, by the product editor's base-section rules
 * (`planProductBaseSection`): one discount kind at a time, none on a product
 * with options or a gift card, the shipping profile and its free-delivery
 * mirror together, and the price on the single default SKU.
 */
function planBase(
    row: ProductBulkEditSaveRow,
    product: ProductState,
    skus: Topology,
    profiles: ReadonlyMap<string, { id: string; freeDelivery: boolean }>,
    currency: Awaited<ReturnType<typeof readStoreCurrency>> | null,
): BaseWrite | Failure {
    const patch = row.base!;
    const priced = currency ? catalogPriceColumns({ price: patch.price, discountPercentage: patch.discountPercentage, discountAmount: patch.discountAmount }, currency) : {};
    const type = patch.discountType ?? (product.discountType === "flat" ? "flat" : "percentage");
    const bps = type === "percentage" ? priced.discountBps ?? product.discountBps ?? 0 : 0;
    const amount = type === "flat" ? priced.discountAmountMinor ?? product.discountAmountMinor ?? 0 : 0;
    const isActive = patch.isActive ?? product.isActive;
    const priceMinor = priced.priceMinor ?? product.priceMinor;
    const options = skus.total - skus.defaults;
    if (((patch.discountPercentage ?? 0) > 0 || (patch.discountAmount ?? 0) > 0) && options > 0) {
        return invalid("A product with options has no product discount. Give each variant its own compare-at price instead.", "discountAmount");
    }
    if (product.isGiftCard && (bps > 0 || amount > 0)) return invalid(GIFT_CARD_PRODUCT_RULES_MESSAGE, "isGiftCard");
    let shipping: Pick<BaseWrite, "s" | "sp" | "fd"> = { s: 0, sp: null, fd: false };
    if (patch.shippingProfileId !== undefined) {
        const id = patch.shippingProfileId?.trim() || null;
        if (id === null || id === DEFAULT_SHIPPING_PROFILE_ID) shipping = { s: 1, sp: null, fd: false };
        else {
            const profile = profiles.get(id);
            if (!profile) return invalid("Choose a shipping profile from the list.", "shippingProfileId");
            shipping = { s: 1, sp: profile.id, fd: profile.freeDelivery };
        }
    }
    let defaultPrice: number | null = null;
    if (patch.price !== undefined || patch.isActive !== undefined) {
        if ((skus.defaults > 0 && !(skus.total === 1 && skus.defaults === 1 && skus.invalid === 0)) || skus.invalid > 0) {
            return invalid("Product SKU data is invalid: only one default SKU is allowed, and every non-default SKU must include at least one customer option.");
        }
        if (isActive && skus.total === 0) return invalid("This product has no SKU yet. Open it to add one before making it active.", "isActive");
        if (skus.total === 1 && skus.defaults === 1) defaultPrice = priceMinor;
    }
    return { id: row.id, a: isActive, pm: priceMinor, dt: type, db: bps, da: amount, ...shipping, dp: defaultPrice };
}

const field = (alias: string, key: string) => sql.raw(`json_extract(${alias}.value, '$.${key}')`);

/**
 * Commits every planned row in one batch, one statement per kind of change
 * over all rows (a JSON row set each), each row's own checks inside them:
 *   1. the counted SKUs' ledger-v2 movements, for a product only while its
 *      revision and every counted SKU (its version, its on hand at the default
 *      location, what orders hold of it) are as the editor read them;
 *   2. those SKUs' counters, where their movement landed;
 *   3. SKU weights, 4. base fields, 5. the default SKU's price, then
 *   6. one revision bump, which names the rows saved; and the catalogue
 *      projections of the rows.
 * Steps 2 to 6 write a product only while it is live: its revision unmoved
 * and each counted SKU either moved by its own movement or still at its
 * version. A row a concurrent write moved is left whole and reported; the
 * others commit. Returns the saved rows' new revisions.
 */
async function commitPlans(
    db: Database,
    plans: readonly RowPlan[],
    location: InventoryLocationRef | null,
    actorId: string | null,
): Promise<Map<string, number>> {
    const rowsJson = JSON.stringify(plans.map((plan) => ({ id: plan.row.id, rev: plan.row.expectedAggregateRevision })));
    const countsJson = JSON.stringify(plans.flatMap((plan) => plan.counts));
    const weightsJson = JSON.stringify(plans.flatMap((plan) => plan.weights));
    const basesJson = JSON.stringify(plans.flatMap((plan) => (plan.base ? [plan.base] : [])));
    const ids = plans.map((plan) => plan.row.id);
    const locationId = location?.id ?? "";

    const revisionHolds = (productId: SQL) => sql`EXISTS (SELECT 1 FROM json_each(${rowsJson}) AS lr
        JOIN ${products} AS lp ON lp.id = ${field("lr", "id")}
        WHERE lp.id = ${productId} AND lp.aggregate_revision = ${field("lr", "rev")} AND lp.deleted_at IS NULL)`;
    // Before any write: every counted SKU of the product is as the editor read it.
    const countable = (productId: SQL) => sql`${revisionHolds(productId)} AND NOT EXISTS (SELECT 1 FROM json_each(${countsJson}) AS lc
        LEFT JOIN ${productVariants} AS lv ON lv.id = ${field("lc", "v")}
        LEFT JOIN ${inventoryLevels} AS ll ON ll.variant_id = lv.id AND ll.location_id = ${locationId}
        WHERE ${field("lc", "p")} = ${productId} AND NOT (
            lv.id IS NOT NULL AND lv.deleted_at IS NULL AND lv.stock_version = ${field("lc", "ver")}
            AND lv.fulfillment_kind = 'physical' AND lv.track_inventory = 1
            AND (${field("lc", "d")} >= 0 OR lv.reserved_stock <= lv.stock + ${field("lc", "d")})
            AND coalesce(ll.on_hand, 0) = ${field("lc", "b")}
            AND NOT EXISTS (SELECT 1 FROM ${inventoryMovements} AS lm WHERE lm.id = ${field("lc", "m")})))`;
    // After step 1: the product's counts all landed (or needed none).
    const live = (productId: SQL) => sql`${revisionHolds(productId)} AND NOT EXISTS (SELECT 1 FROM json_each(${countsJson}) AS lc
        LEFT JOIN ${productVariants} AS lv ON lv.id = ${field("lc", "v")}
        WHERE ${field("lc", "p")} = ${productId} AND NOT (
            (${field("lc", "d")} <> 0 AND EXISTS (SELECT 1 FROM ${inventoryMovements} AS lm WHERE lm.id = ${field("lc", "m")}))
            OR (${field("lc", "d")} = 0 AND lv.stock_version = ${field("lc", "ver")})))`;
    const baseValue = (key: string) => sql`(SELECT ${field("b", key)} FROM json_each(${basesJson}) AS b WHERE ${field("b", "id")} = ${products.id})`;
    const statements: BatchItem<"sqlite">[] = [];
    const counting = plans.some((plan) => plan.counts.some((count) => count.d !== 0));
    if (counting) {
        statements.push(db.insert(inventoryMovements).select(sql`
            SELECT ${field("c", "m")}, v.id, NULL, 'adjusted', ${field("c", "d")}, v.stock, v.stock + ${field("c", "d")},
                ${field("c", "n")}, ${actorId}, 2, 'regular', NULL, v.stock_version, v.stock_version + 1, ${field("c", "d")},
                v.reserved_stock, v.reserved_stock, 0, v.preorder_stock, v.preorder_stock, 0, unixepoch(), ${locationId}
            FROM json_each(${countsJson}) AS c
            JOIN ${productVariants} AS v ON v.id = ${field("c", "v")}
            WHERE ${field("c", "d")} <> 0 AND v.product_id = ${field("c", "p")} AND ${countable(sql.raw(`json_extract(c.value, '$.p')`))}
        `) as unknown as BatchItem<"sqlite">);
        statements.push(db.update(productVariants).set({
            stock: sql`${productVariants.stock} + (SELECT ${field("c", "d")} FROM json_each(${countsJson}) AS c WHERE ${field("c", "v")} = ${productVariants.id})`,
            stockVersion: sql`${productVariants.stockVersion} + 1`,
            updatedAt: sql`unixepoch()`,
        }).where(sql`${productVariants.id} IN (SELECT ${field("c", "v")} FROM json_each(${countsJson}) AS c
            WHERE ${field("c", "d")} <> 0 AND ${field("c", "ver")} = ${productVariants.stockVersion}
              AND EXISTS (SELECT 1 FROM ${inventoryMovements} AS m WHERE m.id = ${field("c", "m")}))`) as BatchItem<"sqlite">);
    }
    if (plans.some((plan) => plan.weights.length > 0)) {
        statements.push(db.update(productVariants).set({
            weight: sql`(SELECT ${field("w", "g")} FROM json_each(${weightsJson}) AS w WHERE ${field("w", "v")} = ${productVariants.id})`,
            updatedAt: sql`unixepoch()`,
        }).where(sql`${productVariants.id} IN (SELECT ${field("w", "v")} FROM json_each(${weightsJson}) AS w WHERE ${field("w", "p")} = ${productVariants.productId})
            AND +${productVariants.deletedAt} IS NULL AND ${live(sql`${productVariants.productId}`)}`) as BatchItem<"sqlite">);
    }
    if (plans.some((plan) => plan.base)) {
        statements.push(db.update(products).set({
            isActive: baseValue("a"),
            priceMinor: baseValue("pm"),
            discountType: baseValue("dt"),
            discountBps: baseValue("db"),
            discountAmountMinor: baseValue("da"),
            // The profile and its free-delivery mirror move together (a trigger refuses a row that disagrees).
            shippingProfileId: sql`CASE WHEN ${baseValue("s")} = 1 THEN ${baseValue("sp")} ELSE ${products.shippingProfileId} END`,
            freeDelivery: sql`CASE WHEN ${baseValue("s")} = 1 THEN ${baseValue("fd")} ELSE ${products.freeDelivery} END`,
            updatedAt: sql`unixepoch()`,
        }).where(sql`${products.id} IN (SELECT ${field("b", "id")} FROM json_each(${basesJson}) AS b) AND ${live(sql`${products.id}`)}`) as BatchItem<"sqlite">);
        statements.push(db.update(productVariants).set({
            priceMinor: sql`(SELECT ${field("b", "dp")} FROM json_each(${basesJson}) AS b WHERE ${field("b", "id")} = ${productVariants.productId})`,
            discountType: "percentage",
            discountBps: 0,
            discountAmountMinor: 0,
            updatedAt: sql`unixepoch()`,
        }).where(sql`${productVariants.isDefault} = 1 AND +${productVariants.deletedAt} IS NULL
            AND ${productVariants.productId} IN (SELECT ${field("b", "id")} FROM json_each(${basesJson}) AS b WHERE ${field("b", "dp")} IS NOT NULL)
            AND ${live(sql`${productVariants.productId}`)}`) as BatchItem<"sqlite">);
    }
    statements.push(db.update(products).set({
        aggregateRevision: sql`${products.aggregateRevision} + 1`,
        // An optioned product's price follows its cheapest SKU (as the single-product bump does).
        priceMinor: sql`COALESCE((SELECT MIN(pv.price_minor) FROM ${productVariants} AS pv WHERE pv.product_id = ${products.id}
            AND pv.deleted_at IS NULL AND pv.is_default = 0 AND trim(coalesce(pv.option_combination_key, '')) <> ''), ${products.priceMinor})`,
        updatedAt: sql`unixepoch()`,
    }).where(sql`${inJsonArray(products.id, ids)} AND ${live(sql`${products.id}`)}`)
        .returning({ id: products.id, aggregateRevision: products.aggregateRevision }) as BatchItem<"sqlite">);
    const bump = statements.length - 1;
    statements.push(...(catalogProjectionRefreshStatements(db, ids) as BatchItem<"sqlite">[]));
    try {
        const results = await safeBatch(db, statements as never) as unknown[];
        const saved = results[bump] as Array<{ id: string; aggregateRevision: number }>;
        return new Map(saved.map((row) => [row.id, row.aggregateRevision]));
    } catch (error) {
        rethrowGiftCardProductRuleViolation(error);
        rethrowDigitalStockRuleViolation(error);
        throw error;
    }
}

/** Why rows the commit left alone were refused: the product moved, or a counted SKU did. */
async function explainRefused(db: Database, plans: readonly RowPlan[]): Promise<Map<string, Failure>> {
    const skuIds = plans.flatMap((plan) => plan.counts.map((count) => count.v));
    const [productRows, skuRows] = await safeBatch(db, [
        db.select({ id: products.id, aggregateRevision: products.aggregateRevision, deletedAt: products.deletedAt })
            .from(products).where(inJsonArray(products.id, plans.map((plan) => plan.row.id))),
        db.select({ id: productVariants.id, stockVersion: productVariants.stockVersion })
            .from(productVariants).where(inJsonArray(productVariants.id, skuIds.length > 0 ? skuIds : [""])),
    ] as never) as [Array<{ id: string; aggregateRevision: number; deletedAt: Date | null }>, Array<{ id: string; stockVersion: number }>];
    const revisions = new Map(productRows.map((row) => [row.id, row]));
    const versions = new Map(skuRows.map((row) => [row.id, row.stockVersion]));
    return new Map(plans.map((plan) => {
        const product = revisions.get(plan.row.id);
        if (!product || product.deletedAt) return [plan.row.id, { status: "failed", code: "not_found", message: "This product was deleted or moved to trash." } satisfies Failure];
        if (product.aggregateRevision !== plan.row.expectedAggregateRevision) return [plan.row.id, stale(plan.row.expectedAggregateRevision, product.aggregateRevision)];
        const moved = plan.counts.find((count) => versions.get(count.v) !== count.ver);
        if (moved) return [plan.row.id, stockChanged(`skus.${moved.v}.onHand`)];
        return [plan.row.id, { status: "failed", code: "stock_committed", message: "A counted SKU has fewer units free than the count removes: some are committed to orders. Reload and count again." } satisfies Failure];
    }));
}
