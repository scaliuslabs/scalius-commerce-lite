import type { Database } from "@scalius/database/client";
import { and, or, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn, AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { inJsonArray } from "./in-json-array";

/**
 * Bounded maintenance; a renewal between selection and deletion must survive.
 *
 * `expired` is one predicate, or a list of branches whose union is the stale
 * set. A table whose stale set is an OR across different indexes passes each
 * branch on its own, so every selection is one index range (an OR across
 * indexes plans a full SCAN), each bounded by the work limit; the deletion
 * re-checks the whole union by primary key.
 */
export async function sweepExpiredRows(
  db: Database,
  table: AnySQLiteTable,
  key: AnySQLiteColumn<{ data: string; notNull: true }>,
  expired: SQL | undefined | readonly SQL[],
  limit: number,
): Promise<{ scanned: number; deleted: number; limit: number; hasMore: boolean }> {
  const branches = Array.isArray(expired) ? (expired as readonly SQL[]) : expired ? [expired as SQL] : [];
  if (branches.length === 0) throw new Error("An expiry sweep requires a stale-row predicate.");
  const staleRow = branches.length === 1 ? branches[0]! : or(...branches)!;
  const found = new Set<string>();
  for (const branch of branches) {
    const rows = await db.select({ id: key }).from(table).where(branch).limit(limit + 1);
    for (const row of rows) found.add(row.id);
    if (found.size > limit) break;
  }
  const ids = [...found].slice(0, limit);
  const deleted = ids.length === 0 ? [] : await db.delete(table)
    .where(and(staleRow, inJsonArray(key, ids)))
    .returning({ id: key });
  return {
    scanned: ids.length,
    deleted: deleted.length,
    limit,
    hasMore: found.size > limit,
  };
}
