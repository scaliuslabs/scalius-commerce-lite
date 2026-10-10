// Dashboard product reads: list, picker lookups, detail and stats.
import {
    products,
    categories,
    brands,
    productVariants,
    productMedia,
    productRichContent,
    productAttributeValues,
    inventoryMovements,
} from "@scalius/database/schema";
import { and, sql, eq, asc, inArray, isNull, or, type SQL, type SQLWrapper } from "drizzle-orm";
import type { CursorValueKind } from "@scalius/shared/pagination";
import {
    COUNT_PROBE_COLUMN,
    cappedCountQuery,
    cappedPagination,
    planKeysetPage,
} from "../../utils/keyset";
import { BULK_MATCHING_SLICE, matchingSliceCondition, nextMatchingCursor } from "../../utils/bulk-matching";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "../../search/fts5";
import { anySetIsSmall } from "../../utils/list-lead";
import { ValidationError } from "@scalius/core/errors";
import {
  buildBuyerCatalogPricingProjection,
  type BuyerPriceRange,
  buyerPriceRangeColumns,
  loadProductMediaProjections,
  loadProductOptions,
  loadProductVariantSelectedOptions,
  presentBuyerPriceRange,
  presentCatalogPrice,
  type ProductMediaProjection,
  type ProductMediaProjectionRow,
  productVariantBarcodeIdentityEquals,
  type ProductWithDetails,
  parsePublishedChannelIds,
  productPublishedToChannelSql,
  publishedChannelIdsSql,
  readStoredCustomization,
  readStoreDecimalPlaces,
  resolveProductImageRepresentation,
  resolveProductMediaProjectionRows,
  selectProductMediaProjectionRows,
} from "../products";
import { safeBatch, type Database } from "@scalius/database/client";
import { bpsToPercent, fromMinor } from "@scalius/shared/money";
import { unixToDate } from "@scalius/shared/timestamps";
import { getBarcodeIdentityKey } from "@scalius/shared/barcode-identity";

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

type ProductListSort = "name" | "price" | "category" | "createdAt" | "updatedAt";

/**
 * The sorts the list walks by keyset: the sort column as the ORDER BY
 * compares it, and its cursor value type. A product with no category sorts
 * as NULL (first ascending, last descending).
 */
const PRODUCT_KEYSET_SORTS = {
    name: { column: products.name, kind: "text", nullable: false },
    price: { column: products.priceMinor, kind: "number", nullable: false },
    category: { column: categories.name, kind: "text", nullable: true },
    createdAt: { column: products.createdAt, kind: "number", nullable: false },
    updatedAt: { column: products.updatedAt, kind: "number", nullable: false },
} as const satisfies Record<ProductListSort, { column: SQLWrapper; kind: CursorValueKind; nullable: boolean }>;

/** The filters of the dashboard's product list, shared by the list and its "all matching" bulk actions. */
export interface ProductListFilter {
    search?: string;
    categoryId?: string;
    showTrashed?: boolean;
    status?: "active" | "draft";
    salesChannelId?: string;
    salesChannelState?: "published" | "unpublished";
    /** An app column filter (plugins/list-columns.ts): an indexed match on the app's records. */
    appCondition?: SQL;
    /** Read the search's matches first (`productListLeads`). */
    leadWithMatches?: boolean;
}

/**
 * With SQLite (FTS5), the rowids of the products a search finds: a word of
 * the product, a word of one of its live SKUs, or a SKU's exact barcode.
 * Index lookups only, never a probe of every product's SKUs.
 */
function productSearchRowids(db: Database, search: string): SQL | undefined {
    if (!isFts5SearchEnabled(db)) return undefined;
    const sources: SQL[] = [];
    const words = sanitizeFtsQuery(search);
    if (words) {
        sources.push(sql`SELECT rowid FROM products_fts WHERE products_fts MATCH ${words}`);
        sources.push(sql`SELECT matched_product.rowid FROM product_variants_fts
            CROSS JOIN ${productVariants} ON ${productVariants}.rowid = product_variants_fts.rowid
            CROSS JOIN ${products} AS matched_product ON matched_product.id = ${productVariants.productId}
            WHERE product_variants_fts MATCH ${words} AND ${productVariants.deletedAt} IS NULL`);
    }
    const barcodeKey = getBarcodeIdentityKey(search);
    if (barcodeKey) {
        sources.push(sql`SELECT matched_product.rowid FROM ${productVariants}
            CROSS JOIN ${products} AS matched_product ON matched_product.id = ${productVariants.productId}
            WHERE ${productVariantBarcodeIdentityEquals(barcodeKey)} AND ${productVariants.deletedAt} IS NULL`);
    }
    return sources.length > 0 ? sql.join(sources, sql` UNION `) : undefined;
}

/** Whether the list should read the search's matches first: they are few (`utils/list-lead.ts`). */
export async function productListLeads(db: Database, filter: Pick<ProductListFilter, "search">): Promise<boolean> {
    const search = filter.search?.trim();
    const rowids = search ? productSearchRowids(db, search) : undefined;
    return rowids ? anySetIsSmall(db, [rowids]) : false;
}

/**
 * The list's WHERE conditions and, for a text search, its relevance order.
 * The same conditions pick the rows of an "all matching" bulk action, so it
 * acts on exactly what the list shows.
 */
/**
 * A text search's relevance: each product match's FTS5 rank, read once as a
 * derived table the list left-joins on rowid (`product_rank`). A correlated
 * `(SELECT rank ... WHERE rowid = products.rowid AND MATCH ...)` re-ran the
 * match for every candidate row: 2.8 s for a common word over 50,000
 * products. Products matched only through a SKU rank last (0).
 */
function productRankJoin(sanitized: string): { join: SQL; on: SQL; order: SQL } {
    return {
        // `LIMIT -1` keeps SQLite from flattening it back into a per-row MATCH (FTS5 is SQLite-only).
        join: sql`(SELECT rowid AS fts_rowid, rank AS fts_rank FROM products_fts WHERE products_fts MATCH ${sanitized} LIMIT -1) AS product_rank`,
        on: sql`product_rank.fts_rowid = ${products}.rowid`,
        order: sql`COALESCE(product_rank.fts_rank, 0) ASC`,
    };
}

export function productListConditions(db: Database, filter: ProductListFilter): { conditions: SQL[]; rankExpression: SQL | undefined; rankJoin: { join: SQL; on: SQL } | undefined } {
    const {
        search,
        categoryId,
        showTrashed = false,
        status,
        salesChannelId,
        salesChannelState = "published",
    } = filter;
    const whereConditions: SQL[] = filter.appCondition ? [filter.appCondition] : [];

    // The list indexes start with `deleted_at`: the unary `+` keeps SQLite
    // off them when the list reads the search's matches first.
    const deletedAt = filter.leadWithMatches ? sql`+${products.deletedAt}` : sql`${products.deletedAt}`;
    if (showTrashed) {
        whereConditions.push(sql`${deletedAt} IS NOT NULL`);
    } else {
        whereConditions.push(sql`${deletedAt} IS NULL`);
    }
    if (status) {
        whereConditions.push(eq(products.isActive, status === "active"));
    }

    let rankExpression: SQL | undefined;
    let rankJoin: { join: SQL; on: SQL } | undefined;
    const searchRowids = search ? productSearchRowids(db, search) : undefined;
    if (search && searchRowids) {
        whereConditions.push(sql`products.rowid IN (${searchRowids})`);
        const sanitized = sanitizeFtsQuery(search);
        if (sanitized) {
            const rank = productRankJoin(sanitized);
            rankExpression = rank.order;
            rankJoin = rank;
        }
    } else if (search) {
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
                const rank = productRankJoin(sanitized);
                rankExpression = rank.order;
                rankJoin = rank;
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
    if (salesChannelId) {
        // One primary-key probe per row (MARKETS-DESIGN D6).
        const published = productPublishedToChannelSql(sql`${products.id}`, salesChannelId);
        whereConditions.push(salesChannelState === "published" ? published : sql`NOT ${published}`);
    }

    return { conditions: whereConditions, rankExpression, rankJoin };
}

/**
 * One slice of an "all matching" bulk action (`utils/bulk-matching.ts`): the
 * next `limit` products the list's filter matches after `cursor`, in id
 * order, with the revision each write claims.
 */
export async function listMatchingProductClaims(
    db: Database,
    filter: ProductListFilter,
    cursor: string | undefined,
    limit: number = BULK_MATCHING_SLICE,
): Promise<{ claims: Array<{ id: string; expectedAggregateRevision: number }>; next: string | null }> {
    const { conditions } = productListConditions(db, { ...filter, leadWithMatches: await productListLeads(db, filter) });
    const after = matchingSliceCondition(products.id, cursor);
    const rows = await db
        .select({ id: products.id, aggregateRevision: products.aggregateRevision })
        .from(products)
        .where(and(...conditions, ...(after ? [after] : [])))
        .orderBy(asc(products.id))
        .limit(limit);
    return {
        claims: rows.map((row) => ({ id: row.id, expectedAggregateRevision: row.aggregateRevision })),
        next: nextMatchingCursor(rows, limit),
    };
}

/**
 * Returns a paginated, searchable list of products for the admin dashboard.
 * Includes variant counts, image counts, and primary image URLs.
 */
export async function listProducts(db: Database, options: {
    search?: string;
    categoryId?: string;
    page?: number;
    limit?: number;
    /** Rows after this cursor (`pageInfo.endCursor`); excludes `before` and `page` beyond 1. */
    after?: string;
    /** Rows before this cursor (`pageInfo.startCursor`). */
    before?: string;
    showTrashed?: boolean;
    /** "active" = sold on the storefront, "draft" = hidden. */
    status?: "active" | "draft";
    sort?: ProductListSort;
    order?: "asc" | "desc";
    /** Agent summaries omit large text/media projections before they leave SQL. */
    agentSummary?: boolean;
    /** Compact dashboard lists can omit rich text while preserving the default API contract. */
    includeDescription?: boolean;
    /** Only products published (`published`, the default) or not published (`unpublished`) to this sales channel. */
    salesChannelId?: string;
    salesChannelState?: "published" | "unpublished";
    /** An app column filter (plugins/list-columns.ts): an indexed match on the app's records. */
    appCondition?: SQL;
}) {
    const {
        search,
        categoryId,
        page = 1,
        limit = 10,
        after,
        before,
        showTrashed = false,
        status,
        sort = "updatedAt",
        order = "desc",
        agentSummary = false,
        includeDescription = true,
        salesChannelId,
        salesChannelState = "published",
    } = options;

    const { conditions: whereConditions, rankExpression, rankJoin } = productListConditions(db, {
        search,
        categoryId,
        showTrashed,
        status,
        salesChannelId,
        salesChannelState,
        appCondition: options.appCondition,
        leadWithMatches: await productListLeads(db, { search }),
    });
    const whereClause =
        whereConditions.length > 0 ? and(...whereConditions) : undefined;

    // A text search is ordered by relevance (computed per row), so it pages by
    // position inside the first matches; every other sort walks by keyset.
    const keysetSpec = PRODUCT_KEYSET_SORTS[sort] ?? PRODUCT_KEYSET_SORTS.updatedAt;
    const plan = planKeysetPage({ page, limit, after, before }, {
        sort: rankExpression ? "relevance" : sort,
        order: { column: keysetSpec.column, id: products.id, direction: order, nullable: keysetSpec.nullable },
        kind: keysetSpec.kind,
        ranked: rankExpression ? [rankExpression, sql`${products.id} asc`] : undefined,
    });

    // The page's ids first, from the sort index; the wide row and its
    // channels are then read for those ids only.
    const pageKeysBase = db
        .select({ id: products.id })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .$dynamic();
    const pageKeys = (rankJoin ? pageKeysBase.leftJoin(rankJoin.join, rankJoin.on) : pageKeysBase)
        .where(plan.pageWhere(whereClause))
        .orderBy(...plan.orderBy)
        .limit(plan.fetchLimit)
        .offset(plan.offset);

    const productResultsBase = db
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
            salesChannelIds: publishedChannelIdsSql(sql`${products.id}`).as("sales_channel_ids"),
            // The sort column as stored: a cursor compares what the ORDER BY compared.
            keysetValue: sql<number | string | null>`${keysetSpec.column}`.as("keyset_value"),
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .$dynamic();
    const productResultsQuery = (rankJoin ? productResultsBase.leftJoin(rankJoin.join, rankJoin.on) : productResultsBase)
        .where(inArray(products.id, pageKeys))
        .orderBy(...plan.orderBy);

    // The total reads at most `countCap` + 1 rows; a cursor page also
    // counts the rows leading up to it (same cap) for its "51-100 of 1,000+".
    const positionWhere = plan.positionWhere(whereClause);
    const statements: unknown[] = [
        cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(products).where(whereClause).$dynamic()),
        productResultsQuery,
    ];
    if (positionWhere) {
        // A `category` position compares the joined category name.
        statements.push(cappedCountQuery(db, db.select(COUNT_PROBE_COLUMN).from(products)
            .leftJoin(categories, eq(categories.id, products.categoryId)).where(positionWhere).$dynamic()));
    }
    const [batchResult, decimalPlaces] = await Promise.all([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Drizzle D1 batch typing limitation
        db.batch(statements as any) as Promise<any>,
        readStoreDecimalPlaces(db),
    ]);
    const { rows: productResults, pageInfo, pageStart } = plan.finish(
        batchResult[1] as Awaited<typeof productResultsQuery>,
        batchResult[2]?.[0]?.count,
    );
    const pagination = cappedPagination((batchResult[0] as { count: number }[])[0]?.count ?? 0, pageStart, limit);

    if (productResults.length === 0) {
        return { products: [], pagination, pageInfo };
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
        salesChannelIds: parsePublishedChannelIds(product.salesChannelIds),
        };
    });

    return {
        products: combinedProducts,
        pagination,
        pageInfo,
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
    after?: string;
    before?: string;
    showTrashed?: boolean;
    sort?: ProductListSort;
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
        pageInfo: result.pageInfo,
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
            brandId: products.brandId,
            slug: products.slug,
            metaTitle: products.metaTitle,
            metaDescription: products.metaDescription,
            canonicalPath: products.canonicalPath,
            noIndex: products.noIndex,
            excludeFromSitemap: products.excludeFromSitemap,
            salesChannelIds: publishedChannelIdsSql(sql`${products.id}`),
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
            isGiftCard: products.isGiftCard,
            warrantyPolicyId: products.warrantyPolicyId,
            customizationSchema: products.customizationSchema,
            category: {
                name: categories.name,
            },
            /** The brand picker's label (a trashed brand keeps its name until changed). */
            brandName: brands.name,
        })
        .from(products)
        .leftJoin(categories, eq(categories.id, products.categoryId))
        .leftJoin(brands, eq(brands.id, products.brandId))
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
    const customization = readStoredCustomization(result.customizationSchema, decimalPlaces);
    return {
        ...presentCatalogPrice(result, decimalPlaces),
        salesChannelIds: parsePublishedChannelIds(result.salesChannelIds),
        customizationSchema: customization.customization,
        customizationSchemaInvalid: customization.invalid,
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
