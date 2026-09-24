// Dashboard product reads: list, picker lookups, detail and stats.
import {
    products,
    categories,
    productVariants,
    productMedia,
    productRichContent,
    productAttributeValues,
    inventoryMovements,
} from "@scalius/database/schema";
import { and, sql, desc, eq, asc, inArray, isNull, or } from "drizzle-orm";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "../../../search/fts5";
import { ValidationError } from "@scalius/core/errors";
import type { ProductWithDetails } from "../types";
import { safeBatch, type Database } from "@scalius/database/client";
import { presentCatalogPrice, readStoreDecimalPlaces } from "../money";
import { bpsToPercent, fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/timestamps";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";
import { loadProductOptions, loadProductVariantSelectedOptions } from "../option-model";
import { productVariantBarcodeIdentityEquals } from "../variant-identity";
import {
    loadProductMediaProjections,
    resolveProductMediaProjectionRows,
    resolveProductImageRepresentation,
    selectProductMediaProjectionRows,
} from "../media";
import type { ProductMediaProjection, ProductMediaProjectionRow } from "../media";
import {
    buildBuyerCatalogPricingProjection,
    buyerPriceRangeColumns,
    presentBuyerPriceRange,
    type BuyerPriceRange,
} from "../buyer-projection";

function requireProductTimestamp(
    value: Date | number | string | null | undefined,
    field: string,
): Date {
    const date = unixToDate(value);
    if (!date) {
        throw new ValidationError(`Product ${field} is invalid.`);
    }
    return date;
}

// ─────────────────────────────────────────
// Admin read queries
// ─────────────────────────────────────────

/**
 * Returns a paginated, searchable list of products for the admin dashboard.
 * Includes variant counts, image counts, and primary image URLs.
 */
export async function listProducts(db: Database, options: {
    search?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    /** "active" = sold on the storefront, "draft" = hidden. */
    status?: "active" | "draft";
    sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
    /** Agent summaries omit large text/media projections before they leave SQL. */
    agentSummary?: boolean;
    /** Compact dashboard lists can omit rich text while preserving the default API contract. */
    includeDescription?: boolean;
}) {
    const {
        search,
        categoryId,
        page = 1,
        limit = 10,
        showTrashed = false,
        status,
        sort = "updatedAt",
        order = "desc",
        agentSummary = false,
        includeDescription = true,
    } = options;
    const offset = (page - 1) * limit;

    const whereConditions = [];

    if (showTrashed) {
        whereConditions.push(sql`${products.deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${products.deletedAt} IS NULL`);
    }
    if (status) {
        whereConditions.push(eq(products.isActive, status === "active"));
    }

    let rankExpression = undefined;
    if (search) {
        const barcodeKey = getBarcodeIdentityKey(search);

        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            const productSearch = ftsMatch(
                db,
                "products_fts",
                "products",
                search,
            );
            const variantSearch = ftsMatch(
                db,
                "product_variants_fts",
                "product_variants",
                search,
            );
            const ftsCondition = or(
                productSearch,
                variantSearch
                    ? sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariants.deletedAt} IS NULL AND ${variantSearch})`
                    : undefined,
            );

            if (barcodeKey) {
                // Also match by exact barcode value
                const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL)`;
                whereConditions.push(ftsCondition
                    ? sql`(${ftsCondition} OR ${barcodeCondition})`
                    : barcodeCondition);
            } else if (ftsCondition) {
                whereConditions.push(ftsCondition);
            }
            if (isFts5SearchEnabled(db)) {
                rankExpression = sql`COALESCE((SELECT rank FROM products_fts WHERE rowid = products.rowid AND products_fts MATCH ${sanitized}), 0) ASC`;
            }
        } else if (barcodeKey) {
            // FTS sanitized to nothing but it's a barcode — search by barcode only
            const barcodeCondition = sql`EXISTS (SELECT 1 FROM ${productVariants} WHERE ${productVariants.productId} = ${products.id} AND ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL)`;
            whereConditions.push(barcodeCondition);
        }
    }

    if (categoryId) {
        whereConditions.push(eq(products.categoryId, categoryId));
    }

    const whereClause =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const countQuery = db
        .select({ count: sql<number>`count(distinct ${products.id})` })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause);

    const productResultsQuery = db
        .select({
            id: products.id,
            name: products.name,
            slug: products.slug,
            priceMinor: products.priceMinor,
            description: includeDescription
                ? products.description
                : sql<string | null>`NULL`,
            isActive: products.isActive,
            discountBps: products.discountBps,
            discountType: products.discountType,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            aggregateRevision: products.aggregateRevision,
            createdAt: sql<number>`CAST(${products.createdAt} AS INTEGER)`,
            updatedAt: sql<number>`CAST(${products.updatedAt} AS INTEGER)`,
            deletedAt: sql<number>`CAST(${products.deletedAt} AS INTEGER)`,
            categoryName: sql<string>`${categories.name}`.as("categoryName"),
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(whereClause)
        .limit(limit)
        .offset(offset)
        .orderBy(
            (() => {
                if (rankExpression) {
                    return rankExpression;
                }
                const sortField = (() => {
                    switch (sort) {
                        case "name":
                            return products.name;
                        case "price":
                            return products.priceMinor;
                        case "category":
                            return categories.name;
                        case "createdAt":
                            return products.createdAt;
                        case "updatedAt":
                        default:
                            return products.updatedAt;
                    }
                })();
                return order === "asc" ? asc(sortField) : desc(sortField);
            })(),
        );

    const [[countArr, productResults], decimalPlaces] = await Promise.all([db.batch([
        countQuery,
        productResultsQuery,
    ]), readStoreDecimalPlaces(db)]);
    const count = countArr[0]?.count ?? 0;

    if (productResults.length === 0) {
        return {
            products: [],
            pagination: {
                total: count,
                page,
                limit,
                totalPages: Math.ceil(count / limit),
            },
        };
    }

    const productIds: string[] = productResults.map((p) => p.id);
    const productIdSet = JSON.stringify(productIds);
    // Buyer pricing for this page only: joined into the page query, the
    // projection ranked every SKU in the store to price ten rows.
    const pagePricing = buildBuyerCatalogPricingProjection(db, {
        productScope: sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${productIdSet}))`,
    });

    const enrichmentResults = await safeBatch(db, [
        db
            .select({
                productId: productVariants.productId,
                count: sql<number>`count(${productVariants.id})`,
                trackedCount: sql<number>`sum(CASE WHEN ${productVariants.trackInventory} THEN 1 ELSE 0 END)`,
                onHand: sql<number>`sum(CASE WHEN ${productVariants.trackInventory} THEN ${productVariants.stock} ELSE 0 END)`,
                hasSkuDiscount: sql<number>`max(CASE WHEN ${productVariants.discountBps} > 0 OR ${productVariants.discountAmountMinor} > 0 THEN 1 ELSE 0 END)`,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                ) AND ${productVariants.deletedAt} IS NULL`,
            )
            .groupBy(productVariants.productId),
        // Trash only: SKUs with stock history keep a product from permanent delete.
        db
            .selectDistinct({ productId: productVariants.productId })
            .from(productVariants)
            .where(sql`${showTrashed ? sql`1` : sql`0`} = 1 AND ${productVariants.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            ) AND EXISTS (SELECT 1 FROM ${inventoryMovements} WHERE ${inventoryMovements.variantId} = ${productVariants.id})`),
        db
            .select({
                productId: productMedia.productId,
                count: sql<number>`count(${productMedia.id})`,
            })
            .from(productMedia)
            .where(sql`${productMedia.productId} IN (
                SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
            )`)
            .groupBy(productMedia.productId),
        db
            .select({
                productId: productVariants.productId,
                sku: productVariants.sku,
            })
            .from(productVariants)
            .where(
                sql`${productVariants.productId} IN (
                    SELECT CAST(value AS TEXT) FROM json_each(${productIdSet})
                ) AND ${productVariants.deletedAt} IS NULL`,
            )
            .orderBy(productVariants.productId, asc(productVariants.createdAt)),
        selectProductMediaProjectionRows(db, agentSummary ? [] : productIds),
        db.select({ productId: pagePricing.productId, ...buyerPriceRangeColumns(pagePricing) }).from(pagePricing),
    ]);
    type VariantSummaryRow = { productId: string; count: number; trackedCount: number; onHand: number; hasSkuDiscount: number };
    const variantCounts = enrichmentResults[0] as VariantSummaryRow[];
    const productsWithStockHistory = new Set((enrichmentResults[1] as { productId: string }[]).map((row) => row.productId));
    const mediaCounts = enrichmentResults[2] as { productId: string; count: number }[];
    const productSkus = enrichmentResults[3] as { productId: string; sku: string }[];
    const mediaProjectionRows = enrichmentResults[4] as ProductMediaProjectionRow[];
    type PageSkuPricing = { productId: string; buyerFromMinor: number | null; buyerToMinor: number | null; buyerBaseMinor: number | null };
    const pricingByProduct = new Map((enrichmentResults[5] as PageSkuPricing[]).map((row) => [row.productId, row]));
    const mediaByProduct = agentSummary
        ? new Map<string, ProductMediaProjection[]>()
        : resolveProductMediaProjectionRows(mediaProjectionRows);

    const variantSummaryMap = new Map(variantCounts.map((row) => [row.productId, row]));

    const mediaCountMap = new Map<string, number>(
        mediaCounts.map((ic: { productId: string; count: number }) => [ic.productId, ic.count]),
    );

    const primaryImageMap = new Map<string, string>(
        productIds.flatMap((productId) => {
            const representation = resolveProductImageRepresentation(mediaByProduct.get(productId) ?? []);
            return representation ? [[productId, representation.url] as const] : [];
        }),
    );

    const skuMap = new Map<string, string>();
    productSkus.forEach((item: { productId: string; sku: string }) => {
        if (!skuMap.has(item.productId)) {
            skuMap.set(item.productId, item.sku);
        }
    });

    const combinedProducts = productResults.map((product) => {
        const price = presentCatalogPrice(product, decimalPlaces);
        return {
        id: product.id,
        name: product.name,
        slug: product.slug,
        price: price.price,
        priceRange: presentBuyerPriceRange(
            pricingByProduct.get(product.id) ?? { buyerFromMinor: null, buyerToMinor: null, buyerBaseMinor: null },
            decimalPlaces,
        ),
        description: product.description,
        isActive: product.isActive,
        discountPercentage: price.discountPercentage,
        discountType: product.discountType || "percentage",
        discountAmount: price.discountAmount,
        freeDelivery: product.freeDelivery,
        aggregateRevision: product.aggregateRevision,
        createdAt: requireProductTimestamp(product.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(product.updatedAt, "updated timestamp"),
        category: {
            name: product.categoryName || "Uncategorized",
        },
        variantCount: Number(variantSummaryMap.get(product.id)?.count ?? 0),
        /** Tracked on-hand units across live SKUs; null when no SKU tracks quantity. */
        onHand: Number(variantSummaryMap.get(product.id)?.trackedCount ?? 0) > 0
            ? Number(variantSummaryMap.get(product.id)?.onHand ?? 0)
            : null,
        /** Some SKUs carry their own discount, so the product price isn't the whole story. */
        hasVariantDiscount: Number(variantSummaryMap.get(product.id)?.hasSkuDiscount ?? 0) > 0,
        /** Trash only: stock history keeps this product from permanent delete. */
        hasStockHistory: productsWithStockHistory.has(product.id),
        mediaCount: mediaCountMap.get(product.id) || 0,
        primaryImage: primaryImageMap.get(product.id) || null,
        sku: skuMap.get(product.id) || undefined,
        };
    });

    return {
        products: combinedProducts,
        pagination: {
            total: count,
            page,
            limit,
            totalPages: Math.ceil(count / limit),
        },
    };
}

/**
 * Bounded operation projection for MCP/CLI product discovery. Rich text and
 * media URLs stay behind the section/detail operations, so a page cannot echo
 * merchant-authored 100k fields into a 64 KiB structured result.
 */
export async function listProductAgentSummaries(db: Database, options: {
    search?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    showTrashed?: boolean;
    sort?: "name" | "price" | "category" | "createdAt" | "updatedAt";
    order?: "asc" | "desc";
}) {
    const result = await listProducts(db, { ...options, agentSummary: true });
    return {
        products: result.products.map((product) => ({
            id: product.id,
            name: product.name.slice(0, 100),
            slug: product.slug.slice(0, 100),
            price: product.price,
            isActive: product.isActive,
            aggregateRevision: product.aggregateRevision,
            category: { name: product.category.name.slice(0, 100) },
            variantCount: product.variantCount,
            sku: product.sku?.slice(0, 100),
        })),
        pagination: result.pagination,
    };
}

export interface ProductPickerSummary {
    id: string;
    name: string;
    price: number;
    /** What buyers pay; null when the product has no live SKU. */
    priceRange: BuyerPriceRange | null;
    categoryId: string | null;
    primaryImage: string | null;
    discountPercentage: number | null;
}

function normalizeLookupIds(ids: string[]): string[] {
    return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).slice(0, 90);
}

/** Returns lightweight product metadata for already-known product IDs. */
export async function getProductsByIds(
    db: Database,
    ids: string[],
): Promise<ProductPickerSummary[]> {
    const lookupIds = normalizeLookupIds(ids);
    if (lookupIds.length === 0) return [];

    const orderById = new Map(lookupIds.map((id, index) => [id, index]));
    // One bound JSON parameter: the outer read already binds up to 90 ids.
    const buyerPricing = buildBuyerCatalogPricingProjection(db, {
        productScope: sql`${products.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(lookupIds)}))`,
    });
    const [rows, decimalPlaces] = await Promise.all([db
        .select({
            id: products.id,
            name: products.name,
            priceMinor: products.priceMinor,
            ...buyerPriceRangeColumns(buyerPricing),
            categoryId: products.categoryId,
            discountBps: products.discountBps,
        })
        .from(products)
        .leftJoin(buyerPricing, eq(buyerPricing.productId, products.id))
        .where(and(inArray(products.id, lookupIds), isNull(products.deletedAt))), readStoreDecimalPlaces(db)]);

    const mediaByProduct = await loadProductMediaProjections(db, rows.map((row) => row.id));
    return rows.map(({ priceMinor, discountBps, buyerFromMinor, buyerToMinor, buyerBaseMinor, ...row }) => ({
        ...row,
        price: fromMinor(priceMinor, decimalPlaces),
        priceRange: presentBuyerPriceRange({ buyerFromMinor, buyerToMinor, buyerBaseMinor }, decimalPlaces),
        discountPercentage: bpsToPercent(discountBps),
        primaryImage: resolveProductImageRepresentation(mediaByProduct.get(row.id) ?? [])?.url ?? null,
    })).sort((a, b) => (orderById.get(a.id) ?? 0) - (orderById.get(b.id) ?? 0));
}

/**
 * Returns full product details including variants and ordered media.
 * Returns null if the product does not exist.
 */
export async function getProductDetails(
    db: Database,
    id: string,
): Promise<ProductWithDetails | null> {
    // Every read is keyed by the product id: one wave, not three.
    const productRead = db
        .select({
            id: products.id,
            name: products.name,
            description: products.description,
            priceMinor: products.priceMinor,
            categoryId: products.categoryId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            noIndex: products.noIndex,
            excludeFromSitemap: products.excludeFromSitemap,
            excludeFromProductFeed: products.excludeFromProductFeed,
            productCondition: products.productCondition,
            aggregateRevision: products.aggregateRevision,
            createdAt: products.createdAt,
            updatedAt: products.updatedAt,
            deletedAt: products.deletedAt,
            isActive: products.isActive,
            discountBps: products.discountBps,
            discountType: products.discountType,
            discountAmountMinor: products.discountAmountMinor,
            freeDelivery: products.freeDelivery,
            taxClassId: products.taxClassId,
            taxClassificationVersion: products.taxClassificationVersion,
            category: {
                name: categories.name,
            },
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .where(eq(products.id, id));

    const [[result], variants, mediaByProduct, richContent, attributeValues, decimalPlaces, optionsByProduct, selectedOptionsByVariant] = await Promise.all([
        productRead,
        db
            .select()
            .from(productVariants)
            .where(and(eq(productVariants.productId, id), isNull(productVariants.deletedAt))),
        loadProductMediaProjections(db, [id]),
        db
            .select()
            .from(productRichContent)
            .where(eq(productRichContent.productId, id))
            .orderBy(asc(productRichContent.sortOrder)),
        db
            .select({
                id: productAttributeValues.id,
                attributeId: productAttributeValues.attributeId,
                value: productAttributeValues.value,
            })
            .from(productAttributeValues)
            .where(eq(productAttributeValues.productId, id)),
        readStoreDecimalPlaces(db),
        loadProductOptions(db, [id]),
        loadProductVariantSelectedOptions(db, id),
    ]);
    if (!result) return null;
    return {
        ...presentCatalogPrice(result, decimalPlaces),
        createdAt: requireProductTimestamp(result.createdAt, "created timestamp"),
        updatedAt: requireProductTimestamp(result.updatedAt, "updated timestamp"),
        deletedAt: result.deletedAt
            ? requireProductTimestamp(result.deletedAt, "deleted timestamp")
            : null,
        variants: variants.map((variant) => ({
            ...presentCatalogPrice(variant, decimalPlaces),
            selectedOptions: selectedOptionsByVariant.get(variant.id) ?? [],
        })),
        options: optionsByProduct.get(id) ?? [],
        media: mediaByProduct.get(id) ?? [],
        additionalInfo: richContent.map((item) => ({
            id: item.id,
            title: item.title,
            content: item.content,
            sortOrder: item.sortOrder,
        })),
        attributes: attributeValues.map((attr) => ({
            attributeId: attr.attributeId,
            value: attr.value,
        })),
    } as ProductWithDetails;
}

/** Returns aggregate product and category counts for the products dashboard. */
export async function getProductStats(db: Database) {
    const [totalProductsArr, activeProductsArr, productsWithImagesArr, categoriesCountArr] = await db.batch([
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL AND ${products.isActive} = 1`),
        db
            .select({
                count: sql<number>`count(DISTINCT ${products.id})`,
            })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL AND EXISTS (
                SELECT 1
                FROM product_media AS admin_product_media
                JOIN media AS admin_media ON admin_media.id = admin_product_media.media_id
                LEFT JOIN media AS admin_poster ON admin_poster.id = admin_media.poster_media_id
                WHERE admin_product_media.product_id = ${products.id}
                  AND admin_media.status IN ('ready', 'trashed')
                  AND (
                    admin_media.kind = 'image'
                    OR (
                      admin_media.kind = 'video'
                      AND admin_poster.kind = 'image'
                      AND admin_poster.status IN ('ready', 'trashed')
                    )
                  )
            )`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(sql`${categories.deletedAt} IS NULL`),
    ]);

    return {
        totalProducts: totalProductsArr[0]?.count ?? 0,
        activeProducts: activeProductsArr[0]?.count ?? 0,
        productsWithImages: productsWithImagesArr[0]?.count ?? 0,
        categoriesCount: categoriesCountArr[0]?.count ?? 0,
    };
}

/** Returns category-level stats for the categories admin page. */
export async function getCategoryStats(db: Database) {
    const [totalCategoriesArr, categoriesWithImagesArr, totalProductsArr] = await db.batch([
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(sql`${categories.deletedAt} IS NULL`),
        db
            .select({ count: sql<number>`count(*)` })
            .from(categories)
            .where(
                sql`${categories.deletedAt} IS NULL AND ${categories.imageUrl} IS NOT NULL`,
            ),
        db
            .select({ count: sql<number>`count(*)` })
            .from(products)
            .where(sql`${products.deletedAt} IS NULL`),
    ]);

    return {
        totalCategories: totalCategoriesArr[0]?.count ?? 0,
        categoriesWithImages: categoriesWithImagesArr[0]?.count ?? 0,
        totalProducts: totalProductsArr[0]?.count ?? 0,
    };
}
