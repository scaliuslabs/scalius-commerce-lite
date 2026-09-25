// Quantity bundles ("2 for 10% off", "3 for ৳900") of one product: the
// `bundles` editor section under the product aggregate revision, and the
// reads the product page and checkout price them from. Checkout prices them
// with `bundleGroupPricing` (@scalius/shared/product-bundles), so the product
// page, a landing pack picker and the order total always agree.
//
// Every write fences in-flight checkouts: 0090's triggers bump
// `checkout_authority` on each insert, price-relevant update and delete.
import type { BatchItem } from "drizzle-orm/batch";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { Database } from "@scalius/database/client";
import { productBundles, products } from "@scalius/database/schema";
import { ValidationError } from "@scalius/core/errors";
import { bpsToPercent, fromMinor, percentToBps } from "@scalius/shared/money";
import {
    PRODUCT_BUNDLE_MAX_QUANTITY,
    PRODUCT_BUNDLE_MIN_QUANTITY,
    PRODUCT_BUNDLES_MAX,
    productBundleTierListSchema,
    productBundleTierSchema,
    type ProductBundleTier,
} from "@scalius/shared/product-bundles";
import { readStoreCurrency, toStoreMinor } from "../settings/store-money";
import { MAX_PRODUCT_PRICE } from "./types";

export const PRODUCT_BUNDLE_ID_PREFIX = "pbd_";

type SQLiteBatchItem = BatchItem<"sqlite">;

/** A stored tier row (active or not). */
export interface ProductBundleRow {
    id: string;
    productId: string;
    quantity: number;
    discountType: "percentage" | "fixed_price";
    discountBps: number;
    priceMinor: number | null;
    label: string | null;
    position: number;
    isActive: boolean;
}

const bundleColumns = {
    id: productBundles.id,
    productId: productBundles.productId,
    quantity: productBundles.quantity,
    discountType: productBundles.discountType,
    discountBps: productBundles.discountBps,
    priceMinor: productBundles.priceMinor,
    label: productBundles.label,
    position: productBundles.position,
    isActive: productBundles.isActive,
};

/** A stored row as a pricing tier; a row the CHECKs should have refused is null. */
export function productBundleTierFromRow(row: ProductBundleRow): ProductBundleTier | null {
    const tier = row.discountType === "percentage"
        ? { quantity: row.quantity, discountType: "percentage" as const, discountBps: row.discountBps, label: row.label, isActive: row.isActive }
        : { quantity: row.quantity, discountType: "fixed_price" as const, priceMinor: row.priceMinor ?? 0, label: row.label, isActive: row.isActive };
    const parsed = productBundleTierSchema.safeParse(tier);
    return parsed.success ? parsed.data : null;
}

/** Tiers per product from stored rows, in position order. */
export function productBundleTiersByProduct(rows: readonly ProductBundleRow[]): Map<string, ProductBundleTier[]> {
    const byProduct = new Map<string, ProductBundleTier[]>();
    for (const row of [...rows].sort((a, b) => a.position - b.position || a.quantity - b.quantity)) {
        const tier = productBundleTierFromRow(row);
        if (!tier) continue;
        const tiers = byProduct.get(row.productId) ?? [];
        tiers.push(tier);
        byProduct.set(row.productId, tiers);
    }
    return byProduct;
}

/**
 * The active tiers of a set of products (one `json_each` parameter), for the
 * product page and checkout; at most PRODUCT_BUNDLES_MAX rows per product.
 * Unordered: `productBundleTiersByProduct` puts them in position order.
 */
export function selectActiveProductBundleRows(db: Database, productIds: readonly string[]) {
    return db.select(bundleColumns).from(productBundles).where(and(
        sql`${productBundles.productId} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify([...new Set(productIds)])}))`,
        eq(productBundles.isActive, true),
    ));
}

/** A tier in the decimal HTTP contract (the editor and the product page). */
export function presentProductBundleTier(tier: ProductBundleTier, decimalPlaces: number) {
    return tier.discountType === "percentage"
        ? {
            quantity: tier.quantity,
            discountType: "percentage" as const,
            discountPercentage: bpsToPercent(tier.discountBps),
            price: null,
            label: tier.label,
            isActive: tier.isActive,
        }
        : {
            quantity: tier.quantity,
            discountType: "fixed_price" as const,
            discountPercentage: null,
            price: fromMinor(tier.priceMinor, decimalPlaces),
            label: tier.label,
            isActive: tier.isActive,
        };
}

// ─────────────────────────────────────────
// Editor section
// ─────────────────────────────────────────

const bundleLabelSchema = z.string().trim().max(60).nullable()
    .transform((value) => value || null);

/** One tier as the editor sends it: a percentage off each unit, or a price for the set. */
export const productBundleTierInputSchema = z.discriminatedUnion("discountType", [
    z.object({
        quantity: z.number().int().min(PRODUCT_BUNDLE_MIN_QUANTITY).max(PRODUCT_BUNDLE_MAX_QUANTITY),
        discountType: z.literal("percentage"),
        discountPercentage: z.number().min(0.01).max(99.99),
        label: bundleLabelSchema,
        isActive: z.boolean(),
    }).strict(),
    z.object({
        quantity: z.number().int().min(PRODUCT_BUNDLE_MIN_QUANTITY).max(PRODUCT_BUNDLE_MAX_QUANTITY),
        discountType: z.literal("fixed_price"),
        /** The price of the whole set of `quantity` units. */
        price: z.number().positive().max(MAX_PRODUCT_PRICE),
        label: bundleLabelSchema,
        isActive: z.boolean(),
    }).strict(),
]);
export type ProductBundleTierInput = z.infer<typeof productBundleTierInputSchema>;

export const productBundleTierInputListSchema = z.array(productBundleTierInputSchema)
    .max(PRODUCT_BUNDLES_MAX)
    .refine((tiers) => new Set(tiers.map((tier) => tier.quantity)).size === tiers.length, {
        message: "Each quantity can have one bundle.",
    });

export async function readProductBundleSection(db: Database, productId: string) {
    const [product, rows, currency] = await Promise.all([
        db.select({ aggregateRevision: products.aggregateRevision }).from(products)
            .where(eq(products.id, productId)).get(),
        db.select(bundleColumns).from(productBundles).where(eq(productBundles.productId, productId))
            .orderBy(asc(productBundles.position), asc(productBundles.quantity)).all(),
        readStoreCurrency(db),
    ]);
    if (!product) return null;
    const items = rows.flatMap((row) => {
        const tier = productBundleTierFromRow(row as ProductBundleRow);
        return tier ? [{ id: row.id, ...presentProductBundleTier(tier, currency.decimalPlaces) }] : [];
    });
    return { section: "bundles" as const, aggregateRevision: product.aggregateRevision, items };
}

/**
 * Replaces the product's tiers (in the given order) in the product's guarded
 * aggregate batch. Unchanged tiers keep their rows, so saving the same list
 * twice leaves checkout undisturbed; any price change fences checkouts that
 * read the old tiers.
 */
export async function buildProductBundleReplaceStatements(
    db: Database,
    productId: string,
    input: readonly ProductBundleTierInput[],
): Promise<SQLiteBatchItem[] | null> {
    const [product, existing, currency] = await Promise.all([
        db.select({ id: products.id, isGiftCard: products.isGiftCard }).from(products)
            .where(eq(products.id, productId)).get(),
        db.select(bundleColumns).from(productBundles).where(eq(productBundles.productId, productId)).all(),
        readStoreCurrency(db),
    ]);
    if (!product) return null;
    if (product.isGiftCard && input.length > 0) {
        throw new ValidationError("Gift cards are sold at their value, so they can't have quantity bundles.", { field: "bundles" });
    }
    const tiers: ProductBundleTier[] = input.map((tier) => tier.discountType === "percentage"
        ? {
            quantity: tier.quantity,
            discountType: "percentage",
            discountBps: percentToBps(tier.discountPercentage),
            label: tier.label,
            isActive: tier.isActive,
        }
        : {
            quantity: tier.quantity,
            discountType: "fixed_price",
            // Whole taka in BDT ("Taka amounts are whole numbers.").
            priceMinor: toStoreMinor(tier.price, currency),
            label: tier.label,
            isActive: tier.isActive,
        });
    const parsed = productBundleTierListSchema.safeParse(tiers);
    if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "Bundles are invalid.", { field: "bundles" });
    }

    const byQuantity = new Map(existing.map((row) => [row.quantity, row]));
    const keep = new Set<string>();
    const statements: SQLiteBatchItem[] = [];
    // Quantities are unique per product, so a quantity keeps its row.
    parsed.data.forEach((tier, position) => {
        const values = {
            discountType: tier.discountType,
            discountBps: tier.discountType === "percentage" ? tier.discountBps : 0,
            priceMinor: tier.discountType === "fixed_price" ? tier.priceMinor : null,
            label: tier.label,
            position,
            isActive: tier.isActive,
        };
        const row = byQuantity.get(tier.quantity);
        if (row) {
            keep.add(row.id);
            const unchanged = row.discountType === values.discountType
                && row.discountBps === values.discountBps
                && row.priceMinor === values.priceMinor
                && row.label === values.label
                && row.position === values.position
                && row.isActive === values.isActive;
            if (!unchanged) {
                statements.push(db.update(productBundles).set({ ...values, updatedAt: sql`unixepoch()` })
                    .where(and(eq(productBundles.id, row.id), eq(productBundles.productId, productId))));
            }
            return;
        }
        statements.push(db.insert(productBundles).values({
            id: `${PRODUCT_BUNDLE_ID_PREFIX}${nanoid()}`,
            productId,
            quantity: tier.quantity,
            ...values,
        }));
    });
    const removed = existing.filter((row) => !keep.has(row.id)).map((row) => row.id);
    if (removed.length > 0) {
        statements.unshift(db.delete(productBundles).where(and(
            eq(productBundles.productId, productId),
            inArray(productBundles.id, removed),
        )));
    }
    return statements;
}

/** Inserts giving `targetId` a copy of `sourceId`'s tiers (active or not), for duplicating a product. */
export async function buildProductBundleCopyStatements(
    db: Database,
    sourceId: string,
    targetId: string,
): Promise<SQLiteBatchItem[]> {
    const rows = await db.select(bundleColumns).from(productBundles)
        .where(eq(productBundles.productId, sourceId)).limit(PRODUCT_BUNDLES_MAX).all();
    return rows.map(({ id: _id, productId: _productId, ...row }) => db.insert(productBundles).values({
        ...row,
        id: `${PRODUCT_BUNDLE_ID_PREFIX}${nanoid()}`,
        productId: targetId,
    }));
}
