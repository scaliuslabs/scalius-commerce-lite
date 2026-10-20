// Products whose stored recommendations a buyer read found missing, queued
// for the off-request refresh (recommendation-refresh.ts), so a request never
// runs the live ranking.
//
// - During a render, `requestRecommendationRefresh` (utils/recommendation-requests.ts)
//   notes the products in the request's async context.
// - After the response the API calls `enqueueRecommendationRefresh`: one
//   statement that adds a `system_kv` row per public product not yet queued,
//   while the queue holds fewer than RECOMMENDATION_QUEUE_LIMIT rows (a crawl
//   of a fresh import writes at most that many rows).
// - The rotation (`apps/api/src/background/catalog.ts`) refreshes queued
//   products first and removes their rows.
import type { Database } from "@scalius/database/client";
import { productBuyerState, systemKv } from "@scalius/database/schema";
import { asc, inArray, sql } from "drizzle-orm";
import { RECOMMENDATION_REQUEST_LIMIT } from "../../utils/recommendation-requests";

export { collectRecommendationRefreshRequests, requestRecommendationRefresh } from "../../utils/recommendation-requests";

export const RECOMMENDATION_QUEUE_PREFIX = "catalog:recommendations:queue:";
/** Most products queued at once; the rotation reaches the rest in id order. */
export const RECOMMENDATION_QUEUE_LIMIT = 200;

const prefixLength = [...RECOMMENDATION_QUEUE_PREFIX].length;
const queued = sql`substr(${systemKv.key}, 1, ${sql.raw(String(prefixLength))}) = ${RECOMMENDATION_QUEUE_PREFIX}`;

/**
 * Queues the public products among `productIds` (one statement; nothing is
 * written for a product already queued, a non-public id or a full queue).
 */
export async function enqueueRecommendationRefresh(db: Database, productIds: readonly string[]): Promise<void> {
    const ids = [...new Set(productIds)].slice(0, RECOMMENDATION_REQUEST_LIMIT);
    if (ids.length === 0) return;
    await db.insert(systemKv).select(sql`
        SELECT ${RECOMMENDATION_QUEUE_PREFIX} || queued_state.product_id, CAST(unixepoch() AS TEXT), NULL
        FROM ${productBuyerState} AS queued_state
        WHERE queued_state.product_id IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(ids)}))
          AND queued_state.is_public = 1
          AND (SELECT COUNT(*) FROM (
              SELECT 1 FROM ${systemKv} WHERE ${queued} LIMIT ${sql.raw(String(RECOMMENDATION_QUEUE_LIMIT))}
          ) AS queue_size) < ${sql.raw(String(RECOMMENDATION_QUEUE_LIMIT))}
    `).onConflictDoNothing({ target: systemKv.key });
}

/**
 * One read for a rotation run: the `system_kv` value of `cursorKey` (null when
 * absent or expired) and the first `limit` queued products in key order.
 */
export async function readRecommendationRotation(
    db: Database,
    cursorKey: string,
    limit: number,
): Promise<{ cursor: string | null; queued: string[] }> {
    const count = Math.max(0, Math.trunc(limit));
    const rows = await db.all<{ key: string; value: string }>(sql`
        SELECT rotation.key AS "key", rotation.value AS "value" FROM ${systemKv} AS rotation
        WHERE rotation.key = ${cursorKey} AND (rotation.expires_at IS NULL OR rotation.expires_at > unixepoch())
        UNION ALL
        SELECT queue.key, queue.value FROM (
            SELECT ${systemKv.key} AS key, ${systemKv.value} AS value FROM ${systemKv}
            WHERE ${queued} ORDER BY ${systemKv.key} LIMIT ${sql.raw(String(count))}
        ) AS queue
    `);
    return {
        cursor: rows.find((row) => row.key === cursorKey)?.value ?? null,
        queued: rows.filter((row) => row.key.startsWith(RECOMMENDATION_QUEUE_PREFIX))
            .map((row) => row.key.slice(RECOMMENDATION_QUEUE_PREFIX.length)),
    };
}

/** The oldest-keyed queued products, at most `limit`. */
export async function queuedRecommendationRefresh(db: Database, limit: number): Promise<string[]> {
    const count = Math.max(0, Math.trunc(limit));
    if (count === 0) return [];
    const rows = await db.select({ key: systemKv.key }).from(systemKv)
        .where(queued).orderBy(asc(systemKv.key)).limit(count).all();
    return rows.map((row) => row.key.slice(RECOMMENDATION_QUEUE_PREFIX.length));
}

/** Removes refreshed products from the queue. */
export async function dequeueRecommendationRefresh(db: Database, productIds: readonly string[]): Promise<void> {
    const keys = [...new Set(productIds)].slice(0, 90).map((id) => `${RECOMMENDATION_QUEUE_PREFIX}${id}`);
    if (keys.length === 0) return;
    await db.delete(systemKv).where(inArray(systemKv.key, keys));
}
