// Precomputed recommendations (Design B) and the sales stats they and the
// home page's "popular" list read, refreshed off the request path.
//
// - `refreshProductRecommendations` runs the live ranking statement
//   (recommendations.ts) once per product and stores its top 24 in
//   `product_recommendations`. The queue message
//   `catalog.recommendations.refresh` carries at most
//   RECOMMENDATION_REFRESH_PRODUCTS_PER_MESSAGE products.
// - `recommendationRefreshTargets` is who to refresh after a catalogue
//   write: the products, the products currently recommending them, and a
//   bounded set of newest public peers in their categories.
// - `nightlyRecommendationRefreshCandidates`: products sold in the last day
//   (new co-purchases) and the longest-unrefreshed public products, so
//   popularity and the "new arrivals" tail roll over within days.
// - `refreshProductSalesStats`: units sold in the last 30 days from real
//   order lines, reconciled in one batch without churning unchanged rows.
import {
    orderItems,
    orders,
    productBuyerState,
    productRecommendations,
    productSalesStats,
    products,
} from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import {
    rankRecommendationRows,
    recommendationRowReason,
    STORED_RECOMMENDATION_LIMIT,
} from "./recommendations";

export const RECOMMENDATION_REFRESH_PRODUCTS_PER_MESSAGE = 20;
/** Newest public category peers refreshed after a product write. */
const RECOMMENDATION_CATEGORY_PEERS = 11;
/** Products currently recommending a written product, refreshed with it. */
const RECOMMENDATION_REVERSE_PEERS = 12;
const SALES_WINDOW_SECONDS = 30 * 86_400;
const REAL_ORDER_STATUSES = ["pending", "processing", "confirmed", "shipped", "delivered", "completed"] as const;

function uniqueIds(ids: readonly string[]): string[] {
    return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 180))];
}

function idSet(ids: readonly string[]) {
    return sql`(SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))`;
}

/**
 * Recomputes and stores the recommendations of up to 20 products, one
 * ranking statement and one two-statement batch each. Products that are not
 * public lose their stored rows (their page is not shown).
 */
export async function refreshProductRecommendations(
    db: Database,
    productIds: readonly string[],
): Promise<{ refreshed: number; cleared: number }> {
    const ids = uniqueIds(productIds).slice(0, RECOMMENDATION_REFRESH_PRODUCTS_PER_MESSAGE);
    if (ids.length === 0) return { refreshed: 0, cleared: 0 };
    const publicRows = await db
        .select({ id: productBuyerState.productId })
        .from(productBuyerState)
        .where(and(
            sql`${productBuyerState.productId} IN ${idSet(ids)}`,
            sql`${productBuyerState.isPublic} = 1`,
        ))
        .all();
    const publicIds = new Set(publicRows.map((row) => row.id));
    const hidden = ids.filter((id) => !publicIds.has(id));
    if (hidden.length > 0) {
        await db.delete(productRecommendations)
            .where(sql`${productRecommendations.productId} IN ${idSet(hidden)}`)
            .run();
    }
    let refreshed = 0;
    for (const productId of ids.filter((id) => publicIds.has(id))) {
        const rows = await rankRecommendationRows(db, [productId], STORED_RECOMMENDATION_LIMIT);
        const entries = JSON.stringify(rows.map((row) => ({ id: row.id, reason: recommendationRowReason(row) })));
        await safeBatch(db, [
            // Remove only changed slots first: the pair-unique constraint must
            // permit two recommendations swapping positions in the same batch.
            db.delete(productRecommendations).where(and(
                eq(productRecommendations.productId, productId),
                sql`NOT EXISTS (
                    SELECT 1 FROM json_each(${entries}) AS entry
                    WHERE CAST(entry.key AS INTEGER) = ${productRecommendations.position}
                      AND CAST(json_extract(entry.value, '$.id') AS TEXT) = ${productRecommendations.recommendedProductId}
                      AND CAST(json_extract(entry.value, '$.reason') AS TEXT) = ${productRecommendations.reason}
                )`,
            )),
            db.insert(productRecommendations).select(sql`
                SELECT ${productId}, CAST(entry.key AS INTEGER),
                       CAST(json_extract(entry.value, '$.id') AS TEXT),
                       CAST(json_extract(entry.value, '$.reason') AS TEXT),
                       unixepoch()
                FROM json_each(${entries}) AS entry
                WHERE EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = ${productId})
                  AND EXISTS (
                      SELECT 1 FROM ${products} AS rec_target
                      WHERE rec_target.id = CAST(json_extract(entry.value, '$.id') AS TEXT)
                  )
            `).onConflictDoUpdate({
                target: [productRecommendations.productId, productRecommendations.position],
                set: { computedAt: sql`unixepoch()` },
            }),
        ] as never);
        refreshed += 1;
    }
    return { refreshed, cleared: hidden.length };
}

/**
 * Who to refresh after the given products change: themselves, the products
 * whose stored lists name them, and the newest public products of their
 * published categories. Bounded to about 24 products per written product.
 */
export async function recommendationRefreshTargets(
    db: Database,
    productIds: readonly string[],
): Promise<string[]> {
    const ids = uniqueIds(productIds).slice(0, 90);
    if (ids.length === 0) return [];
    const [reverse, peers] = await Promise.all([
        db.select({ id: productRecommendations.productId })
            .from(productRecommendations)
            .where(sql`${productRecommendations.recommendedProductId} IN ${idSet(ids)}`)
            .limit(RECOMMENDATION_REVERSE_PEERS * ids.length)
            .all(),
        db.select({ id: productBuyerState.productId })
            .from(productBuyerState)
            .where(and(
                sql`${productBuyerState.isPublic} = 1`,
                sql`${productBuyerState.categoryId} IN (
                    SELECT written.category_id FROM ${products} AS written
                    WHERE written.id IN ${idSet(ids)} AND written.category_id IS NOT NULL
                )`,
            ))
            .orderBy(desc(productBuyerState.productCreatedAt), asc(productBuyerState.productId))
            .limit(RECOMMENDATION_CATEGORY_PEERS * ids.length)
            .all(),
    ]);
    return uniqueIds([...ids, ...reverse.map((row) => row.id), ...peers.map((row) => row.id)]);
}

/**
 * The nightly refresh set: public products sold since `soldSince` (their
 * co-purchases changed), then the public products whose stored lists are
 * oldest or missing, up to `limit` in all.
 */
export async function nightlyRecommendationRefreshCandidates(
    db: Database,
    input: { soldSince: number; limit: number },
): Promise<string[]> {
    const limit = Math.max(0, Math.trunc(input.limit));
    if (limit === 0) return [];
    const sold = await db
        .selectDistinct({ id: orderItems.productId })
        .from(orders)
        .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
        .innerJoin(productBuyerState, eq(productBuyerState.productId, orderItems.productId))
        .where(and(
            inArray(orders.status, REAL_ORDER_STATUSES),
            isNull(orders.deletedAt),
            gte(orders.createdAt, sql`${input.soldSince}`),
            sql`${productBuyerState.isPublic} = 1`,
        ))
        .limit(limit)
        .all();
    const soldIds = uniqueIds(sold.map((row) => row.id ?? ""));
    const remaining = limit - soldIds.length;
    if (remaining <= 0) return soldIds;
    const lastComputed = sql<number>`COALESCE((
        SELECT MIN(${productRecommendations.computedAt}) FROM ${productRecommendations}
        WHERE ${productRecommendations.productId} = ${productBuyerState.productId}
    ), 0)`;
    const stale = await db
        .select({ id: productBuyerState.productId })
        .from(productBuyerState)
        .where(sql`${productBuyerState.isPublic} = 1`)
        .orderBy(asc(lastComputed), asc(productBuyerState.productId))
        .limit(remaining + soldIds.length)
        .all();
    const staleIds = stale.map((row) => row.id).filter((id) => !soldIds.includes(id));
    return uniqueIds([...soldIds, ...staleIds]).slice(0, limit);
}

/**
 * Units sold per product in the last 30 days, from real orders (placed and
 * kept: not cancelled, refunded, returned or unfinished), reconciling the
 * table in one batch. Unchanged projections only refresh their timestamp.
 */
export async function refreshProductSalesStats(db: Database): Promise<{ products: number }> {
    // Both reconciliation statements use the same database time, including
    // when an order reaches the 30-day boundary between their executions.
    const [clock] = await db.select({ now: sql<number>`unixepoch()` })
        .from(sql`(SELECT 1) AS refresh_clock`).all();
    const refreshAt = Number(clock!.now);
    const statuses = sql.join(REAL_ORDER_STATUSES.map((status) => sql`${status}`), sql`, `);
    const results = await safeBatch(db, [
        db.delete(productSalesStats).where(sql`NOT EXISTS (
            SELECT 1 FROM ${orders} AS sales_order
            INNER JOIN ${orderItems} AS sales_line ON sales_line.order_id = sales_order.id
            WHERE sales_line.product_id = ${productSalesStats.productId}
              AND sales_order.status IN (${statuses})
              AND sales_order.deleted_at IS NULL
              AND sales_order.created_at >= ${refreshAt - SALES_WINDOW_SECONDS}
              AND sales_line.quantity > 0
        )`),
        db.insert(productSalesStats).select(sql`
            SELECT sales_line.product_id, SUM(sales_line.quantity), ${refreshAt}
            FROM ${orders} AS sales_order
            INNER JOIN ${orderItems} AS sales_line ON sales_line.order_id = sales_order.id
            WHERE sales_order.status IN (${statuses})
              AND sales_order.deleted_at IS NULL
              AND sales_order.created_at >= ${refreshAt - SALES_WINDOW_SECONDS}
              AND sales_line.quantity > 0
              AND EXISTS (SELECT 1 FROM ${products} WHERE ${products.id} = sales_line.product_id)
            GROUP BY sales_line.product_id
        `).onConflictDoUpdate({
            target: productSalesStats.productId,
            set: { sold30d: sql`excluded.sold_30d`, computedAt: sql`${refreshAt}` },
        }),
        db.select({ count: sql<number>`count(*)` }).from(productSalesStats),
    ] as never) as unknown[];
    const [countRow] = (results[2] as Array<{ count: number }> | undefined) ?? [];
    return { products: Number(countRow?.count ?? 0) };
}
