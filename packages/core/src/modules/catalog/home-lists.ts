// Homepage section product lists (newest, on sale, popular, a category),
// planned as statements for the homepage's second D1 batch beside the
// collection reads (storefront/storefront.service.ts): each product
// statement is scoped to the products it returns (the buyer pricing
// projection never ranks the whole catalogue) and carries a media statement
// for exactly the same rows, so cards need no third round trip. The lists
// come from `homeSectionRequests` (@scalius/shared/storefront-theme).
import {
    ON_SALE_DISCOUNT_SQL,
    ON_SALE_SKU_ROW_SQL,
    categories,
    productBuyerState,
    productSalesStats,
    products,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, asc, desc, eq, gte, inArray, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { HomeProductListRequest } from "@scalius/shared/storefront-theme";
import { buildBuyerCatalogPricingProjection } from "../products/buyer-projection";
import {
    resolveProductMediaProjectionRows,
    selectProductMediaProjectionRows,
    type ProductMediaProjection,
    type ProductMediaProjectionRow,
} from "../products/media";
import { categoryScope, declareProductCards, deps } from "./declare-deps";
import { publicProductHasBuyerResolvableSku } from "../products/public-eligibility";
import { publicCategoryConditions, publishedCategoryIdExists } from "../categories/categories.publication";
import {
    buildCollectionProductSelect,
    resolveProductCards,
    type RawProduct,
    type ResolvedProduct,
} from "./cards";

type BatchStatement = Parameters<typeof safeBatch>[1][number];

/**
 * On-sale candidates read per card: the discount marker on the product or a
 * SKU is a superset of "a buyer pays less now" (a discount only on sold-out
 * SKUs does not count), so a few extra newest candidates fill the list.
 */
const ON_SALE_CANDIDATES_PER_CARD = 3;
/** Discounted SKUs read per candidate: an optioned product often has several on sale. */
const ON_SALE_SKUS_PER_CANDIDATE = 4;
/** Popular: at least this many units sold in the last 30 days (product_sales_stats). */
const MIN_POPULAR_UNITS = 2;

export interface HomeProductList {
    key: string;
    products: ResolvedProduct[];
    /** A category list's category (public categories only). */
    category: { id: string; name: string; slug: string; canonicalPath: string | null } | null;
}


/**
 * What one home list depends on: every product its selection read (`p:`,
 * shown or not: a member the cards drop today, or a candidate the list
 * filters out, is shown tomorrow by a change to that product alone), the
 * images of the cards shown, and the set and order the selection walks.
 *
 * - Newest and category lists take their members from the buyer-state
 *   projection's public newest (or category newest) order: `lm:all` or
 *   `lm:cat:<id>`.
 * - Popular is ordered by sales stats, which are soft (read from
 *   `product_sales_stats`, bounded automatically), over public members.
 * - On sale reads a candidate window: which rows are in it (`lo:sale:all`,
 *   advanced by every write to a discount-marked product or live SKU, the
 *   only way a row enters, leaves or moves in it) and each candidate's facts.
 */
function declareHomeProductList(
    source: HomeProductListRequest["source"],
    productIds: readonly string[],
    mediaByProduct: ReadonlyMap<string, ProductMediaProjection[]>,
    memberIds: readonly string[],
): void {
    if (!deps.active()) return;
    declareProductCards(productIds, mediaByProduct);
    deps.products(memberIds);
    if (source.kind === "category") {
        deps.listMembership(categoryScope(source.categoryId));
        deps.category(source.categoryId);
        return;
    }
    if (source.kind === "on-sale") {
        deps.listOrder("sale", "all");
        return;
    }
    deps.listMembership("all");
}

const newestFirst = () => [desc(products.createdAt), asc(products.id)] as const;

/**
 * The newest discounted products, from the two partial indexes that hold
 * only discounted rows (migration 0083): products with their own discount,
 * and products with a discounted SKU. Each side reads at most its window
 * however large the catalogue and however rare the sale; the predicates are
 * the indexes' own text, so SQLite proves the indexes apply. Every
 * candidate is public (active, not deleted); SKU-side products are reached
 * by id, with the public test written so it cannot drive a walk over every
 * active product. A superset of the list: buyer eligibility and "pays less
 * now" are checked after.
 */
function onSaleCandidates(window: number): SQL {
    return sql`SELECT on_sale.id FROM (
        SELECT sale_product.id AS id, sale_product.created_at AS created_at FROM (
            SELECT id, created_at FROM products
            WHERE is_active = 1 AND deleted_at IS NULL AND ${sql.raw(ON_SALE_DISCOUNT_SQL)}
            ORDER BY created_at DESC, id ASC LIMIT ${window}
        ) AS sale_product
        UNION
        SELECT sale_sku_product.id AS id, sale_sku_product.created_at AS created_at
        FROM products AS sale_sku_product
        WHERE sale_sku_product.id IN (
            SELECT sale_sku.product_id FROM (
                SELECT product_id FROM product_variants WHERE ${sql.raw(ON_SALE_SKU_ROW_SQL)}
                ORDER BY created_at DESC LIMIT ${window * ON_SALE_SKUS_PER_CANDIDATE}
            ) AS sale_sku
        )
          -- Public, written so no index on these columns can drive the walk.
          AND sale_sku_product.is_active <> 0 AND coalesce(sale_sku_product.deleted_at, 0) = 0
    ) AS on_sale ORDER BY on_sale.created_at DESC, on_sale.id ASC LIMIT ${window}`;
}

/**
 * Statements for the product lists (not collections: those go through the
 * collection plan) and how to read them from the batch results.
 */
export function planHomeProductLists(db: Database, lists: readonly HomeProductListRequest[]): {
    statements: BatchStatement[];
    resolve(results: readonly unknown[], offset: number): HomeProductList[];
} {
    const statements: BatchStatement[] = [];
    const slots: Array<{ key: string; rows: number; media: number; members: number }> = [];
    const categoryIds: string[] = [];

    /**
     * One list: its cards, their media, and the ids its selection read (the
     * members, or the on-sale candidate window), which it depends on.
     */
    const add = (key: string, rows: BatchStatement, ids: SQLWrapper, members: BatchStatement) => {
        const rowsSlot = statements.push(rows) - 1;
        const mediaSlot = statements.push(selectProductMediaProjectionRows(db, ids)) - 1;
        const membersSlot = statements.push(members) - 1;
        slots.push({ key, rows: rowsSlot, media: mediaSlot, members: membersSlot });
    };

    for (const list of lists) {
        const { source, limit } = list;
        if (source.kind === "newest" || source.kind === "category") {
            // The exact products, newest first, from the buyer-state
            // projection (the rows the listing keys advance with): the
            // public-newest (or category-newest) index walk stops after
            // `limit` rows.
            const conditions = source.kind === "category"
                ? [
                    sql`${productBuyerState.isPublic} = 1`,
                    eq(productBuyerState.categoryId, source.categoryId),
                    publishedCategoryIdExists(productBuyerState.categoryId),
                ]
                : [sql`${productBuyerState.isPublic} = 1`];
            if (source.kind === "category") categoryIds.push(source.categoryId);
            const ids = db.select({ id: productBuyerState.productId }).from(productBuyerState).where(and(...conditions))
                .orderBy(desc(productBuyerState.productCreatedAt), asc(productBuyerState.productId)).limit(limit);
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: inArray(products.id, ids) });
            add(list.key, db.select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .where(inArray(products.id, ids))
                .orderBy(...newestFirst()), ids, ids);
        } else if (source.kind === "on-sale") {
            const candidates = sql`${products.id} IN (${onSaleCandidates(limit * ON_SALE_CANDIDATES_PER_CARD)})`;
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: candidates });
            // Candidates are public already; repeating is_active / deleted_at
            // here would let SQLite walk the public-newest index instead of
            // reading the few candidates by id.
            const onSale = and(candidates, publicProductHasBuyerResolvableSku(), eq(pricing.hasDiscount, 1));
            const ids = db.select({ id: products.id }).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .where(onSale).orderBy(...newestFirst()).limit(limit);
            add(list.key, db.select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .where(onSale).orderBy(...newestFirst()).limit(limit), ids,
            // The candidate window itself, shown or not: what the list depends on.
            db.select({ id: products.id }).from(products).where(candidates));
        } else if (source.kind === "popular") {
            // Units sold in the last 30 days from real order lines
            // (product_sales_stats, refreshed nightly): the popularity index
            // walk stops after `limit` public products; nothing is invented
            // when the store has no such sales yet (the list is empty).
            const ids = db.select({ id: productSalesStats.productId })
                .from(productSalesStats)
                .innerJoin(productBuyerState, eq(productBuyerState.productId, productSalesStats.productId))
                .where(and(
                    gte(productSalesStats.sold30d, MIN_POPULAR_UNITS),
                    // A filter, not an index: the popularity index drives (no D1 statistics).
                    sql`+${productBuyerState.isPublic} = 1`,
                ))
                .orderBy(desc(productSalesStats.sold30d), asc(productSalesStats.productId))
                .limit(limit);
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: inArray(products.id, ids) });
            add(list.key, db.select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .innerJoin(productSalesStats, eq(productSalesStats.productId, products.id))
                .where(inArray(products.id, ids))
                .orderBy(desc(productSalesStats.sold30d), asc(products.id)), ids, ids);
        }
    }

    const categorySlot = categoryIds.length > 0
        ? statements.push(db.select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
            canonicalPath: categories.canonicalPath,
        }).from(categories).where(and(
            sql`${categories.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(categoryIds)}))`,
            ...publicCategoryConditions(),
        ))) - 1
        : null;

    return {
        statements,
        resolve(results, offset) {
            const categoryRows = categorySlot === null
                ? []
                : results[offset + categorySlot] as NonNullable<HomeProductList["category"]>[];
            const categoryById = new Map(categoryRows.map((row) => [row.id, row]));
            return slots.map(({ key, rows, media, members }) => {
                const productRows = results[offset + rows] as RawProduct[];
                const mediaByProduct = resolveProductMediaProjectionRows(results[offset + media] as ProductMediaProjectionRow[]);
                const cards = resolveProductCards(productRows, mediaByProduct);
                const source = lists.find((list) => list.key === key)!.source;
                const memberIds = (results[offset + members] as Array<{ id: string }>).map((row) => row.id);
                declareHomeProductList(source, productRows.map((row) => row.id), mediaByProduct, memberIds);
                const category = source.kind === "category" ? categoryById.get(source.categoryId) ?? null : null;
                return {
                    key,
                    // A category that is no longer public shows nothing.
                    products: source.kind === "category" && !category
                        ? []
                        : productRows.flatMap((row) => cards.get(row.id) ?? []),
                    category,
                };
            });
        },
    };
}
