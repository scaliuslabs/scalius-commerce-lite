// The product list's bulk editor: the selected products and their SKUs in one
// read, with what the editor changes (status, price and compare-at price of a
// product without options, on-hand at the default location) and the revisions
// its writes are checked against. Writes go through the existing guarded
// routes (the base section, inventory set-stock), never a second write path.
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { inventoryLevels, inventoryLocations, products, productVariants } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { fromMinor } from "@scalius/shared/money";
import { readStoreDecimalPlaces, variantOptionLabelSql } from "../products";

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
                WHERE ${inventoryLevels.variantId} = ${productVariants.id} AND ${inventoryLocations.isDefault} = 1)`,
            stock: productVariants.stock,
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
        skus: (skusByProduct.get(row.id) ?? []).filter((sku) => !optioned.has(row.id) || sku.label !== null),
    })).sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}
