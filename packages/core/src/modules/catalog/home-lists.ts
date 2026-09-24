// Homepage section product lists (newest, on sale, popular, a category),
// planned as statements for the homepage's second D1 batch beside the
// collection reads (storefront/storefront.service.ts): each product
// statement is scoped to the products it returns (the buyer pricing
// projection never ranks the whole catalogue) and carries a media statement
// for exactly the same rows, so cards need no third round trip. The lists
// come from `homeSectionRequests` (@scalius/shared/storefront-theme).
import { categories, orderItems, orders, products } from "@scalius/database/schema";
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
/** Popular: distinct buyers of a product in real orders of the last 30 days (as recommendations). */
const POPULAR_WINDOW_SECONDS = 30 * 86_400;
const MIN_POPULAR_BUYERS = 2;
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

function hasDiscountMarker(): SQL {
    const discounted = (alias: string) => sql.raw(`(
        (${alias}.discount_type = 'flat' AND ${alias}.discount_amount_minor > 0)
        OR (${alias}.discount_type = 'percentage' AND ${alias}.discount_bps > 0)
    )`);
    return sql`(
        ${discounted('"products"')}
        OR EXISTS (
            SELECT 1 FROM "product_variants" AS home_sale_sku
            WHERE home_sale_sku.product_id = ${products.id}
              AND home_sale_sku.deleted_at IS NULL
              AND ${discounted("home_sale_sku")}
        )
    )`;
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
            const candidates = db.select({ id: products.id }).from(products)
                .where(and(...publicProduct(hasDiscountMarker())))
                .orderBy(...newestFirst()).limit(limit * ON_SALE_CANDIDATES_PER_CARD);
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: inArray(products.id, candidates) });
            const onSale = and(inArray(products.id, candidates), eq(pricing.hasDiscount, 1));
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
            const popular = db.select({ productId: orderItems.productId, buyers: buyers.as("home_popular_buyers") })
                .from(orderItems)
                .innerJoin(orders, eq(orders.id, orderItems.orderId))
                .where(and(
                    inArray(orders.status, REAL_ORDER_STATUSES),
                    isNull(orders.deletedAt),
                    gte(orders.createdAt, sql`unixepoch() - ${POPULAR_WINDOW_SECONDS}`),
                ))
                .groupBy(orderItems.productId)
                .having(gte(buyers, MIN_POPULAR_BUYERS))
                .as("home_popular");
            // Driven from the popular set (never a walk over every product):
            // each popular product is checked for buyer eligibility on its own.
            const ids = db.select({ id: popular.productId }).from(popular)
                .where(exists(db.select({ one: sql`1` }).from(products)
                    .where(and(eq(products.id, popular.productId), ...publicProduct()))))
                .orderBy(desc(popular.buyers), asc(popular.productId)).limit(limit);
            const ranked = [desc(popular.buyers), asc(products.id)] as const;
            const pricing = buildBuyerCatalogPricingProjection(db, { productScope: inArray(products.id, ids) });
            add(list.key, db.select(buildCollectionProductSelect(pricing)).from(products)
                .innerJoin(pricing, eq(products.id, pricing.productId))
                .innerJoin(popular, eq(popular.productId, products.id))
                .where(inArray(products.id, ids)).orderBy(...ranked), ids);
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
