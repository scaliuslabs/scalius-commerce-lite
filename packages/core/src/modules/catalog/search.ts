// Storefront product search.
import {
  effectiveLowStockThresholdSql,
  loadProductMediaProjections,
  loadVariantSelectedOptions,
  normalizeDefaultSkuOptions,
  presentCatalogPrice,
  publicProductBaseConditions,
  type SelectedProductOption,
} from "../products";
import { products, productVariants } from "@scalius/database/schema";
import { and, sql, desc, isNull, inArray, type SQL } from "drizzle-orm";
import { ftsMatch } from "../../search/fts5";
import { maskPublicBuyerAvailability } from "@scalius/shared/buyer-availability";
import type { Database } from "@scalius/database/client";
import { storeCurrencyCodeSql, storeDecimalPlacesFromCode } from "../settings";
import { storeCurrencyFromSql, storePriceIncrementSql } from "../markets";
import {
    marketListPricesSql,
    marketPriceContextOf,
    priceProductSkus,
    type CatalogDiscountColumns,
    type MarketPricing,
} from "../price-lists";
import { productImageMapFromMedia, STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE } from "./shared";
import { declareProductCards, deps } from "./declare-deps";

async function readPrimaryProductImageMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, { mediaId: string; url: string; alt: string | null }>> {
    const mediaMap = await loadProductMediaProjections(db, productIds);
    declareProductCards(productIds, mediaMap);
    return productImageMapFromMedia(mediaMap);
}

// ─────────────────────────────────────────
// Storefront search (variant-aware)
// ─────────────────────────────────────────

type StorefrontSearchProductVariant = {
    id: string;
    productId: string;
    optionCombinationKey: string | null;
    imageId: string | null;
    selectedOptions: SelectedProductOption[];
    weight: number | null;
    sku: string;
    price: number;
    stock: number;
    reservedStock: number;
    lowStockThreshold: number | null;
    availabilityBand: "untracked" | "out_of_stock" | "low_stock" | "in_stock";
    isDefault: boolean;
    trackInventory: boolean;
    discountType: string | null;
    discountPercentage: number | null;
    discountAmount: number | null;
};

async function readStorefrontSearchVariantMap(
    db: Database,
    productIds: string[],
    decimalPlaces: number,
    market: { pricing: MarketPricing; products: ReadonlyMap<string, CatalogDiscountColumns>; incrementMinor: number } | null,
    productPrices: Map<string, CatalogDiscountColumns>,
): Promise<Map<string, StorefrontSearchProductVariant[]>> {
    const variantMap = new Map<string, StorefrontSearchProductVariant[]>();
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        const rows = await db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                optionCombinationKey: productVariants.optionCombinationKey,
                imageId: productVariants.imageId,
                weight: productVariants.weight,
                sku: productVariants.sku,
                priceMinor: productVariants.priceMinor,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
                lowStockThreshold: effectiveLowStockThresholdSql(),
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
                discountType: productVariants.discountType,
                discountBps: productVariants.discountBps,
                discountAmountMinor: productVariants.discountAmountMinor,
                // A presence's market list prices ride on the SKU rows (none at the root).
                ...(market ? { listPrices: marketListPricesSql(sql.raw('"product_variants"."id"'), { presence: market.pricing.presence }) } : {}),
            })
            .from(productVariants)
            .where(and(
                inArray(productVariants.productId, productIdChunk),
                isNull(productVariants.deletedAt),
            ))
            .orderBy(productVariants.productId, productVariants.createdAt, productVariants.id)
            .all();

        const [selectedOptionMap, context] = await Promise.all([
            loadVariantSelectedOptions(db, rows.map((row) => row.id)),
            marketPriceContextOf(market?.pricing),
        ]);
        const priced = priceProductSkus(context, market?.products ?? new Map(), rows, market?.incrementMinor ?? 1);
        for (const [productId, price] of priced.productPrices) productPrices.set(productId, price);
        for (const row of priced.skus) {
            const variants = variantMap.get(row.productId) ?? [];
            variants.push(maskPublicBuyerAvailability(normalizeDefaultSkuOptions({
                ...presentCatalogPrice(row, decimalPlaces),
                selectedOptions: selectedOptionMap.get(row.id) ?? [],
            })));
            variantMap.set(row.productId, variants);
        }
    }
    return variantMap;
}

/**
 * Lightweight variant-aware product search for cart/checkout use.
 * Returns products with their variants and primary image URL.
 */
export async function searchStorefrontProducts(
    db: Database,
    params: { search: string; page: number; limit: number },
    pricing: MarketPricing | null = null,
) {
    const { search, page, limit } = params;
    const offset = (page - 1) * limit;
    // Hits are ordered by products.updated_at, a column every write touches
    // but no dependency key tracks (it is registry noise): no key set can
    // prove a stored page current, so this legacy read is never cached.
    deps.uncacheable("order-by-untracked-column");
    deps.search();
    deps.listMembership("all");

    const conditions: SQL[] = publicProductBaseConditions();
    const searchCondition = search ? ftsMatch(db, "products_fts", "products", search) : null;
    if (search) {
        conditions.push(searchCondition ?? sql`0 = 1`);
    }

    const [results, countResults] = await Promise.all([
        db
            .select({
                id: products.id,
                name: products.name,
                priceMinor: products.priceMinor,
                slug: products.slug,
                discountType: products.discountType,
                discountBps: products.discountBps,
                discountAmountMinor: products.discountAmountMinor,
                freeDelivery: products.freeDelivery,
            })
            .from(products)
            .where(and(...conditions))
            .orderBy(desc(products.updatedAt))
            .limit(limit)
            .offset(offset)
            .all(),
        db
            .select({ count: sql<number>`count(*)`, storeCurrencyCode: storeCurrencyCodeSql(), storePriceIncrementMinor: storePriceIncrementSql() })
            .from(products)
            .where(and(...conditions)),
    ]);

    const productIds = results.map((p) => p.id);
    const count = Number(countResults[0]?.count ?? 0);
    const totalPages = Math.ceil(count / limit);

    const decimalPlaces = storeDecimalPlacesFromCode(countResults[0]?.storeCurrencyCode);
    // In a priced market each product's own price is its card's (its SKUs carry their own).
    const productPrices = new Map<string, CatalogDiscountColumns>();
    const [imageMap, variantMap] = await Promise.all([
        readPrimaryProductImageMap(db, productIds),
        readStorefrontSearchVariantMap(db, productIds, decimalPlaces, pricing
            ? {
                pricing,
                products: new Map(results.map((product) => [product.id, product])),
                incrementMinor: storeCurrencyFromSql(countResults[0]?.storeCurrencyCode, countResults[0]?.storePriceIncrementMinor).priceIncrementMinor,
            }
            : null, productPrices),
    ]);

    return {
        data: results.map((product) => {
            const imgData = imageMap.get(product.id);
            return {
                ...presentCatalogPrice({ ...product, ...productPrices.get(product.id) }, decimalPlaces),
                imageUrl: imgData?.url || null,
                imageMediaId: imgData?.mediaId ?? null,
                imageAlt: imgData?.alt || null,
                variants: variantMap.get(product.id) ?? [],
            };
        }),
        pagination: {
            page,
            limit,
            total: count,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
    };
}
