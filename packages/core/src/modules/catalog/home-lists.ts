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
    orderItems,
    orders,
    products,
} from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import type { safeBatch } from "@scalius/database/client";
import { and, asc, countDistinct, desc, eq, exists, gte, inArray, isNull, sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { HomeProductListRequest } from "@scalius/shared/storefront-theme";
import { buildBuyerCatalogPricingProjection } from "../products/buyer-projection";
import {
    resolveProductMediaProjectionRows,
    selectProductMediaProjectionRows,
    type ProductMediaProjectionRow,
} from "../products/media";
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
/** Popular: distinct buyers of a product in real orders of the last 30 days (as recommendations). */
const POPULAR_WINDOW_SECONDS = 30 * 86_400;
const MIN_POPULAR_BUYERS = 2;
/** Popular candidates read per card before the eligibility check. */
const POPULAR_CANDIDATES_PER_CARD = 3;
const REAL_ORDER_STATUSES = ["pending", "processing", "confirmed", "shipped", "delivered", "completed"] as const;

export interface HomeProductList {
    key: string;
    products: ResolvedProduct[];
    /** A category list's category (public categories only). */
    category: { id: string; name: string; slug: string; canonicalPath: string | null } | null;
}


function publicProduct(...extra: SQL[]): SQL[] {
    return [...extra, eq(products.isActive, true), isNull(products.deletedAt), publicProductHasBuyerResolvableSku()];
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
    const slots: Array<{ key: string; rows: number; media: number }> = [];
    const categoryIds: string[] = [];

    const add = (key: string, rows: BatchStatement, ids: SQLWrapper) => {
        const rowsSlot = statements.push(rows) - 1;
        const mediaSlot = statements.push(selectProductMediaProjectionRows(db, ids)) - 1;
        slots.push({ key, rows: rowsSlot, media: mediaSlot });
    };

    for (const list of lists) {
        const { source, limit } = list;
        if (source.kind === "newest" || source.kind === "category") {
            // The exact products, newest first: the public-newest (or
            // category-newest) index walk stops after `limit` eligible rows.
            const conditions = source.kind === "category"
                ? publicProduct(eq(products.categoryId, source.categoryId), publishedCategoryIdExists(products.categoryId))
                : publicProduct();
            if (source.kind === "category") categoryIds.push(source.categoryId);
            const ids = db.select({ id: products.id }).from(products).where(and(...conditions))
                .orderBy(...newestFirst()).limit(limit);
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: inArray(products.id, ids) });
            add(list.key, db.select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .where(inArray(products.id, ids))
                .orderBy(...newestFirst()), ids);
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
                .where(onSale).orderBy(...newestFirst()).limit(limit), ids);
        } else if (source.kind === "popular") {
            // Distinct buyers per product in the window, as the
            // recommendations' popularity signal; nothing is invented when
            // the store has no such orders yet (the list is empty).
            const buyers = countDistinct(orders.customerPhone);
            // The most-bought candidates (a bounded window, like on sale);
            // buyer eligibility is then checked on those few only, never on
            // every product anyone bought (345 of them at 30k products).
            const mostBought = () => db.select({ productId: orderItems.productId, buyers: buyers.as("home_popular_buyers") })
                .from(orderItems)
                .innerJoin(orders, eq(orders.id, orderItems.orderId))
                .where(and(
                    inArray(orders.status, REAL_ORDER_STATUSES),
                    isNull(orders.deletedAt),
                    gte(orders.createdAt, sql`unixepoch() - ${POPULAR_WINDOW_SECONDS}`),
                ))
                .groupBy(orderItems.productId)
                .having(gte(buyers, MIN_POPULAR_BUYERS))
                .orderBy(desc(buyers), asc(orderItems.productId))
                .limit(limit * POPULAR_CANDIDATES_PER_CARD);
            type Candidates = ReturnType<ReturnType<typeof mostBought>["as"]>;
            const shown = (top: Candidates) => db.select({ id: top.productId }).from(top)
                .where(exists(db.select({ one: sql`1` }).from(products)
                    .where(and(eq(products.id, top.productId), ...publicProduct()))))
                .orderBy(desc(top.buyers), asc(top.productId)).limit(limit);
            // The card statement aggregates the window once (a CTE its pricing
            // scope, id filter and order all read); the candidates are a
            // superset of the shown products, so they are a safe pricing scope.
            const top = db.$with("home_popular_top").as(mostBought());
            const pricing = buildBuyerCatalogPricingProjection(db, {
                productScope: inArray(products.id, db.select({ id: top.productId }).from(top)),
            });
            add(list.key, db.with(top).select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .innerJoin(top, eq(top.productId, products.id))
                .where(inArray(products.id, shown(top as unknown as Candidates)))
                .orderBy(desc(top.buyers), asc(products.id)), shown(mostBought().as("home_popular_top")));
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
            return slots.map(({ key, rows, media }) => {
                const productRows = results[offset + rows] as RawProduct[];
                const cards = resolveProductCards(
                    productRows,
                    resolveProductMediaProjectionRows(results[offset + media] as ProductMediaProjectionRow[]),
                );
                const source = lists.find((list) => list.key === key)!.source;
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
