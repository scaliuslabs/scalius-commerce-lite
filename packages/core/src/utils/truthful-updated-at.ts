import { getTableColumns, is, SQL, sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";

/** Keys that are bookkeeping, never a buyer-visible change. */
const BOOKKEEPING = new Set(["revision", "version", "aggregateRevision", "updatedAt"]);

/**
 * A row's `updated_at` is a sitemap `<lastmod>` (and the feed's `updatedAt`)
 * and advances the `lm:seo` cache key (migration 0100). A write that sets a
 * row to the values it already has must leave it alone, so the lastmod stays
 * truthful and no discovery cache is invalidated for nothing.
 *
 * Wraps an update's `.set()` values: `updatedAt` becomes
 * `CASE WHEN <any other set column changes> THEN unixepoch() ELSE updated_at END`.
 * The comparisons read the row before the update (SQL `SET` semantics) and are
 * null-safe (`IS NOT`; `IS DISTINCT FROM` on PostgreSQL). Revisions still move,
 * so optimistic-concurrency claims are unchanged. A set with no other column
 * (a deliberate touch) is returned as is.
 */
export function truthfulUpdatedAt<V extends Record<string, unknown>>(table: SQLiteTable, values: V): V {
    if (!("updatedAt" in values)) return values;
    const columns = getTableColumns(table) as Record<string, SQLiteColumn>;
    const updatedAt = columns.updatedAt;
    if (!updatedAt) return values;
    const differs: SQL[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (BOOKKEEPING.has(key) || value === undefined) continue;
        const column = columns[key];
        if (!column) continue;
        differs.push(is(value, SQL)
            ? sql`${column} IS NOT (${value})`
            : sql`${column} IS NOT ${sql.param(value, column)}`);
    }
    if (differs.length === 0) return values;
    return {
        ...values,
        updatedAt: sql`CASE WHEN ${sql.join(differs, sql` OR `)} THEN unixepoch() ELSE ${updatedAt} END`,
    };
}
