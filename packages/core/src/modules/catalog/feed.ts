// Product feed rows for the Google/Base and Meta catalogue feeds.
import { effectiveLowStockThresholdSql } from "../inventory/low-stock-policy";
import {
    products,
    categories,
    productVariants,
    productAttributeValues,
    productAttributes,
} from "@scalius/database/schema";
import { and, sql, desc, eq, isNull, inArray, or, lt, type SQL } from "drizzle-orm";
import { unixToDate } from "@scalius/shared/utils";
import { maskPublicBuyerAvailability } from "@scalius/shared/buyer-availability";
import type {
    StorefrontFeedProduct,
    StorefrontFeedProductAttribute,
    StorefrontFeedProductFilterInput,
    StorefrontFeedProductPage,
    StorefrontFeedProductVariant,
} from "../products/types";
import type { Database } from "@scalius/database/client";
import { ValidationError } from "@scalius/core/errors";
import {
    publicProductHasBuyerResolvableSku,
    publicProductHasPrimaryDiscoveryImage,
    normalizeDefaultSkuOptions,
} from "../products/public-eligibility";
import { buildBuyerCatalogPricingProjection } from "../products/buyer-projection";
import {
    catalogDiscountedPrice,
    presentCatalogPrice,
    storeCurrencyCodeSql,
    storeCurrencyFromCode,
    storeDecimalPlacesFromCode,
} from "../products/money";
import { loadProductOptions, loadVariantSelectedOptions } from "../products/option-model";
import { publicCategoryConditions } from "../categories/categories.publication";
import {
    loadProductMediaProjections,
    resolveSkuImageRepresentation,
    type ProductMediaProjection,
} from "../products/media";
import {
    STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
    buildStorefrontProductConditions,
    priceFilterBoundsMinor,
    productImageMapFromMedia,
} from "./shared";

type StorefrontFeedProductListRow = {
    id: string;
    name: string;
    description: string | null;
    priceMinor: number;
    slug: string;
    canonicalPath: string | null;
    discountType: string | null;
    discountBps: number;
    discountAmountMinor: number;
    freeDelivery: boolean;
    categoryId: string | null;
    excludeFromProductFeed: boolean;
    productCondition: "new" | "refurbished" | "used" | null;
    createdAt: number;
    updatedAt: number;
    hasCustomerOptions: number;
    availableForSale: number;
};

const STOREFRONT_FEED_CURSOR_PREFIX = "feed-v1.";

/**
 * Merchant catalogue feeds list physical goods only (Wave A §15 Q12):
 * services and gift cards are left out, and digital SKUs wait for a Wave B
 * feed policy. The UCP catalogue reads the same projection.
 */
export const FEED_FULFILLMENT_KIND = "physical" as const;

/**
 * `"products"."id"` spelled out. Drizzle renders a column inside a
 * single-table select list unqualified, and an unqualified `"id"` inside a
 * correlated subquery would bind to the subquery's own table.
 */
const PRODUCT_ID_REF = sql.raw(`"products"."id"`);

/** The product is not a gift card and has at least one live physical SKU. */
export function feedSellsPhysicalGoods(): SQL<boolean> {
    return sql<boolean>`(
        ${sql.raw(`"products"."is_gift_card"`)} = 0
        AND EXISTS (
            SELECT 1
            FROM "product_variants" AS feed_physical_sku
            WHERE feed_physical_sku.product_id = ${PRODUCT_ID_REF}
              AND feed_physical_sku.deleted_at IS NULL
              AND feed_physical_sku.fulfillment_kind = ${FEED_FULFILLMENT_KIND}
        )
    )`;
}

function encodeFeedCursor(position: { createdAt: number; id: string }): string {
    const bytes = new TextEncoder().encode(position.id);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    const encodedId = btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
    return `${STOREFRONT_FEED_CURSOR_PREFIX}${position.createdAt.toString(36)}.${encodedId}`;
}

function decodeFeedCursor(cursor: string): { createdAt: number; id: string } {
    const match = /^feed-v1\.([0-9a-z]+)\.([A-Za-z0-9_-]+)$/.exec(cursor);
    if (!match?.[1] || !match[2]) throw new ValidationError("Invalid product feed cursor.");
    const createdAt = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new ValidationError("Invalid product feed cursor.");
    }
    try {
        const padded = match[2].replace(/-/g, "+").replace(/_/g, "/")
            .padEnd(Math.ceil(match[2].length / 4) * 4, "=");
        const binary = atob(padded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const id = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes).trim();
        if (!id || id.length > 180) throw new Error("invalid id");
        return { createdAt, id };
    } catch {
        throw new ValidationError("Invalid product feed cursor.");
    }
}

type StorefrontFeedVariantRow = Omit<
    StorefrontFeedProductVariant,
    | "availabilityBand" | "deletedAt" | "selectedOptions" | "imageUrl" | "imageMediaId"
    | "price" | "discountPercentage" | "discountAmount"
> & {
    optionCombinationKey: string | null;
    priceMinor: number;
    discountBps: number;
    discountAmountMinor: number;
    deletedAt: number | null;
    fulfillmentKind: string;
};

interface StorefrontFeedVariantMap {
    /** Physical SKUs only, per product. */
    variants: Map<string, StorefrontFeedProductVariant[]>;
    /** Products that also have live service or digital SKUs, left out of the feed. */
    productsWithNonPhysicalSkus: Set<string>;
}

async function readStorefrontFeedAttributeMap(
    db: Database,
    productIds: string[],
): Promise<Map<string, StorefrontFeedProductAttribute[]>> {
    if (productIds.length === 0) {
        return new Map();
    }

    const rows: Array<{
        productId: string;
        name: string;
        slug: string;
        value: string;
    }> = [];
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        rows.push(...await db
            .select({
                productId: productAttributeValues.productId,
                name: productAttributes.name,
                slug: productAttributes.slug,
                value: productAttributeValues.value,
            })
            .from(productAttributeValues)
            .innerJoin(
                productAttributes,
                and(
                    eq(productAttributeValues.attributeId, productAttributes.id),
                    isNull(productAttributes.deletedAt),
                ),
            )
            .where(inArray(productAttributeValues.productId, productIdChunk))
            .orderBy(
                productAttributeValues.productId,
                productAttributes.id,
                productAttributeValues.id,
            )
            .all());
    }

    const attributeMap = new Map<string, StorefrontFeedProductAttribute[]>();
    for (const row of rows) {
        const attributes = attributeMap.get(row.productId) ?? [];
        attributes.push({ name: row.name, slug: row.slug, value: row.value });
        attributeMap.set(row.productId, attributes);
    }

    return attributeMap;
}

async function readStorefrontFeedVariantMap(
    db: Database,
    productIds: string[],
    decimalPlaces: number,
    mediaMapPromise: Promise<Map<string, ProductMediaProjection[]>> =
        loadProductMediaProjections(db, productIds),
): Promise<StorefrontFeedVariantMap> {
    if (productIds.length === 0) {
        return { variants: new Map(), productsWithNonPhysicalSkus: new Set() };
    }

    const rows: StorefrontFeedVariantRow[] = [];
    for (
        let offset = 0;
        offset < productIds.length;
        offset += STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE
    ) {
        const productIdChunk = productIds.slice(
            offset,
            offset + STOREFRONT_ENRICHMENT_ID_CHUNK_SIZE,
        );
        rows.push(...await db
            .select({
                id: productVariants.id,
                productId: productVariants.productId,
                optionCombinationKey: productVariants.optionCombinationKey,
                imageId: productVariants.imageId,
                weight: productVariants.weight,
                sku: productVariants.sku,
                barcode: productVariants.barcode,
                barcodeType: productVariants.barcodeType,
                priceMinor: productVariants.priceMinor,
                stock: productVariants.stock,
                reservedStock: productVariants.reservedStock,
                lowStockThreshold: effectiveLowStockThresholdSql(),
                isDefault: productVariants.isDefault,
                trackInventory: productVariants.trackInventory,
                discountType: productVariants.discountType,
                discountBps: productVariants.discountBps,
                discountAmountMinor: productVariants.discountAmountMinor,
                deletedAt: sql<number | null>`CAST(${productVariants.deletedAt} AS INTEGER)`,
                fulfillmentKind: productVariants.fulfillmentKind,
            })
            .from(productVariants)
            .where(and(
                inArray(productVariants.productId, productIdChunk),
                isNull(productVariants.deletedAt),
            ))
            .orderBy(productVariants.productId, productVariants.createdAt, productVariants.id)
            .all() as StorefrontFeedVariantRow[]);
    }

    const productsWithNonPhysicalSkus = new Set<string>();
    const physicalRows = rows.filter((row) => {
        if (row.fulfillmentKind === FEED_FULFILLMENT_KIND) return true;
        productsWithNonPhysicalSkus.add(row.productId);
        return false;
    });
    const [selectedOptionMap, mediaMap] = await Promise.all([
        loadVariantSelectedOptions(db, physicalRows.map((row) => row.id)),
        mediaMapPromise,
    ]);
    const variantMap = new Map<string, StorefrontFeedProductVariant[]>();
    for (const { fulfillmentKind: _fulfillmentKind, ...row } of physicalRows) {
        const resolvedImage = resolveSkuImageRepresentation(
            mediaMap.get(row.productId) ?? [],
            row.imageId,
        );
        const variant = maskPublicBuyerAvailability(normalizeDefaultSkuOptions({
            ...presentCatalogPrice(row, decimalPlaces),
            imageMediaId: resolvedImage?.mediaId ?? null,
            imageUrl: resolvedImage?.url ?? null,
            selectedOptions: selectedOptionMap.get(row.id) ?? [],
            deletedAt: row.deletedAt ? unixToDate(row.deletedAt)?.toISOString() ?? null : null,
        }));
        const variants = variantMap.get(row.productId) ?? [];
        variants.push(variant);
        variantMap.set(row.productId, variants);
    }

    return { variants: variantMap, productsWithNonPhysicalSkus };
}

/**
 * Returns a paginated feed projection for catalog exporters.
 * This keeps normal storefront listings card-light while letting feed callers
 * read attributes and SKU data in page-wide bulk queries.
 */
export async function getStorefrontFeedProducts(
    db: Database,
    params: StorefrontFeedProductFilterInput,
): Promise<StorefrontFeedProductPage> {
    const {
        page = 1,
        limit = 100,
        sort = "newest",
        cursor,
    } = params;
    if (page !== 1) {
        throw new ValidationError("Product feed page pagination is retired. Use the cursor returned by the previous response.");
    }
    if (sort !== "newest") {
        throw new ValidationError("Product feed pagination supports newest order only.");
    }
    const feedCreatedAt = sql<number>`CAST(${products.createdAt} AS INTEGER)`;
    const conditions: SQL[] = [];
    if (cursor) {
        // The keyset compares the stored column, never a CAST, so the page
        // seeks products_public_newest_idx instead of sorting the catalogue.
        // `<=` is the index range; the OR only breaks created_at ties.
        const position = decodeFeedCursor(cursor);
        conditions.push(
            sql`${products.createdAt} <= ${position.createdAt}`,
            or(
                sql`${products.createdAt} < ${position.createdAt}`,
                lt(products.id, position.id),
            )!,
        );
    }
    // The projection passed here only selects SKU-level price-range filters;
    // the page query itself never joins it (see below).
    conditions.push(...buildStorefrontProductConditions(db, {
        ...params,
        ...priceFilterBoundsMinor(params),
    }, {
        includeLookupHandles: true,
        includeVariantLookups: true,
    }, buildBuyerCatalogPricingProjection(db)));
    conditions.push(eq(products.excludeFromProductFeed, false));
    conditions.push(feedSellsPhysicalGoods());
    conditions.push(publicProductHasPrimaryDiscoveryImage());

    const query = db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
            slug: products.slug,
            canonicalPath: products.canonicalPath,
            productCondition: products.productCondition,
            discountType: products.discountType,
            discountBps: products.discountBps,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            categoryId: products.categoryId,
            excludeFromProductFeed: products.excludeFromProductFeed,
            createdAt: feedCreatedAt.as("createdAt"),
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`.as("updatedAt"),
            storeCurrencyCode: storeCurrencyCodeSql(),
        })
        .from(products)
        .where(and(...conditions));

    // The public eligibility conditions already guarantee a buyer SKU, so the
    // page needs no pricing join; the page's own availability is read with
    // the enrichment below from a projection scoped to these ids.
    const scannedProducts = await query
        .orderBy(desc(products.createdAt), desc(products.id))
        .limit(limit + 1)
        .all();
    const hasNextPage = scannedProducts.length > limit;
    const productsList = scannedProducts.slice(0, limit);
    const decimalPlaces = storeDecimalPlacesFromCode(productsList[0]?.storeCurrencyCode);
    const productIds = productsList.map((product) => product.id);
    const categoryIds = [...new Set(productsList.map((product) => product.categoryId).filter(Boolean))] as string[];
    const mediaMapPromise = loadProductMediaProjections(db, productIds);
    const pagePricing = buildBuyerCatalogPricingProjection(db, {
        productScope: sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(productIds)}))`,
    });

    const [mediaMap, categoriesData, attributeMap, feedVariants, optionMap, pricingRows] = await Promise.all([
        mediaMapPromise,
        categoryIds.length > 0
            ? db
                .select({ id: categories.id, name: categories.name, slug: categories.slug })
                .from(categories)
                .where(and(
                    // One JSON parameter: a 100-card page can name 100 categories,
                    // and 100 ids plus the status bind exceed D1's 100 limit.
                    sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)}))`,
                    ...publicCategoryConditions(),
                ))
                .all() as Promise<Array<{ id: string; name: string; slug: string }>>
            : Promise.resolve([] as Array<{ id: string; name: string; slug: string }>),
        readStorefrontFeedAttributeMap(db, productIds),
        readStorefrontFeedVariantMap(db, productIds, decimalPlaces, mediaMapPromise),
        loadProductOptions(db, productIds),
        productIds.length > 0
            ? db.select({
                productId: pagePricing.productId,
                hasCustomerOptions: pagePricing.hasCustomerOptions,
                availableForSale: pagePricing.availableForSale,
            }).from(pagePricing).all()
            : Promise.resolve([]),
    ]);
    const imageMap = productImageMapFromMedia(mediaMap);
    const categoryMap = new Map(categoriesData.map((cat) => [cat.id, cat]));
    const pricingByProduct = new Map(pricingRows.map((row) => [row.productId, row]));

    const variantMap = feedVariants.variants;

    const feedProducts: StorefrontFeedProduct[] = productsList.map(({ storeCurrencyCode, ...productRow }) => {
        const pricing = pricingByProduct.get(productRow.id);
        // The buyer projection counts every SKU. When a product also sells a
        // service, its feed availability comes from its physical SKUs only.
        const availableForSale = Boolean(pricing?.availableForSale) && (
            !feedVariants.productsWithNonPhysicalSkus.has(productRow.id)
            || (variantMap.get(productRow.id) ?? []).some((variant) => variant.availabilityBand !== "out_of_stock")
        );
        const product = {
            ...productRow,
            hasCustomerOptions: pricing?.hasCustomerOptions ?? 0,
            availableForSale: availableForSale ? 1 : 0,
        };
        const imgData = imageMap.get(product.id);
        const category = product.categoryId ? categoryMap.get(product.categoryId) ?? null : null;
        const price = presentCatalogPrice(product, decimalPlaces);
        return {
            id: product.id,
            name: product.name,
            slug: product.slug,
            canonicalPath: product.canonicalPath,
            options: (optionMap.get(product.id) ?? []).map(({ values: _values, ...option }) => option),
            description: product.description,
            price: price.price,
            discountType: product.discountType,
            discountPercentage: price.discountPercentage,
            discountAmount: price.discountAmount,
            discountedPrice: catalogDiscountedPrice(product, storeCurrencyFromCode(storeCurrencyCode)),
            freeDelivery: product.freeDelivery,
            categoryId: category?.id ?? null,
            excludeFromProductFeed: Boolean(product.excludeFromProductFeed),
            productCondition: product.productCondition,
            hasVariants: Boolean(product.hasCustomerOptions),
            availableForSale: Boolean(product.availableForSale),
            imageUrl: imgData?.url || null,
            imageMediaId: imgData?.mediaId ?? null,
            imageAlt: imgData?.alt || null,
            category,
            attributes: attributeMap.get(product.id) ?? [],
            variants: variantMap.get(product.id) ?? [],
            updatedAt: unixToDate(product.updatedAt)?.toISOString() || null,
        };
    });

    return {
        products: feedProducts,
        pagination: {
            limit,
            hasNextPage,
            ...(hasNextPage && productsList.length > 0
                ? { cursor: encodeFeedCursor(productsList[productsList.length - 1]!) }
                : {}),
        },
    };
}

/**
 * Reads one exact product ID through the normal public feed eligibility gate.
 * The exact-ID contract deliberately does not accept slugs, variant IDs, or SKUs.
 */
export async function getEligibleStorefrontFeedProductById(
    db: Database,
    productId: string,
): Promise<StorefrontFeedProduct | null> {
    const result = await getStorefrontFeedProducts(db, {
        ids: productId,
        limit: 10,
    });
    return (
        result.products.find((product) => product.id === productId) ?? null
    );
}

export interface ProductFeedProjectionDiagnostic {
    productId: string;
    isActive: boolean;
    isDeleted: boolean;
    excludeFromProductFeed: boolean;
    /** False for gift cards and products with only service or digital SKUs. */
    sellsPhysicalGoods: boolean;
    hasBuyerResolvableSku: boolean;
    hasPrimaryDiscoveryImage: boolean;
    matchingSkuCount: number;
}

/**
 * Diagnostic fallback for an exact product ID that public feed eligibility
 * rejected. It returns evidence only; callers must never use this fallback as
 * an alternate row source because the public feed intentionally prefilters
 * buyer SKU topology and the product primary image before projection.
 */
export async function getFeedProjectionDiagnosticById(
    db: Database,
    productId: string,
    normalizedSku = "",
): Promise<ProductFeedProjectionDiagnostic | null> {
    const product = await db
        .select({
            productId: products.id,
            isActive: products.isActive,
            excludeFromProductFeed: products.excludeFromProductFeed,
            isDeleted: sql<boolean>`${products.deletedAt} IS NOT NULL`,
            sellsPhysicalGoods: feedSellsPhysicalGoods(),
            hasBuyerResolvableSku: publicProductHasBuyerResolvableSku(PRODUCT_ID_REF),
            hasPrimaryDiscoveryImage: publicProductHasPrimaryDiscoveryImage(PRODUCT_ID_REF),
            matchingSkuCount: sql<number>`(
                SELECT count(*)
                FROM "product_variants" AS preview_sku
                WHERE preview_sku.product_id = ${PRODUCT_ID_REF}
                  AND preview_sku.deleted_at IS NULL
                  AND lower(trim(preview_sku.sku)) = ${normalizedSku}
            )`,
        })
        .from(products)
        .where(eq(products.id, productId))
        .get();

    return product
        ? {
            productId: product.productId,
            isActive: Boolean(product.isActive),
            isDeleted: Boolean(product.isDeleted),
            excludeFromProductFeed: Boolean(product.excludeFromProductFeed),
            sellsPhysicalGoods: Boolean(product.sellsPhysicalGoods),
            hasBuyerResolvableSku: Boolean(product.hasBuyerResolvableSku),
            hasPrimaryDiscoveryImage: Boolean(product.hasPrimaryDiscoveryImage),
            matchingSkuCount: Number(product.matchingSkuCount) || 0,
        }
        : null;
}
