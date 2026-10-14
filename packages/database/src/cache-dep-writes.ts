/**
 * Writes of the dependency-validated cache's change clock that no table
 * trigger makes: advancing named keys (the merchant's "Refresh store", a
 * projection repair) and, on PostgreSQL, compacting the change log.
 *
 * - D1 and Turso keep one `cache_dep` row per key and raise `cache_clock` from
 *   a trigger on it (one writer: seq order is commit order).
 * - PostgreSQL keeps an insert-only change log: each transaction takes one
 *   seq from a sequence under a transaction advisory lock, so seqs commit in
 *   order and concurrent writers never update a shared row (no serialization
 *   failures). `cache_dep_compact()` removes the rows a newer row of the same
 *   key supersedes; readers take each key's largest seq, so it changes no
 *   answer.
 */
import { sql, type SQL } from "drizzle-orm";
import { registeredDatabaseProvider } from "./provider";
import { cacheDep } from "./schema";
import type { Database } from "./types";

/**
 * One statement (a batch item) that advances `keys` in the caller's
 * transaction; with `guard`, only when `guard.when` holds (`guard.with`: its
 * common table expressions).
 */
export function advanceCacheDeps(db: Database, keys: readonly string[], guard: { with?: SQL; when?: SQL } = {}) {
  const postgres = registeredDatabaseProvider(db) === "postgres";
  const seq = postgres
    ? sql`scalius_compat."cache_dep_next_seq"()`
    : sql`(SELECT "seq" FROM "cache_clock" WHERE "id" = 1) + 1`;
  const insert = db.insert(cacheDep).select(sql`${guard.with ? sql`WITH ${guard.with} ` : sql``}SELECT DISTINCT CAST(value AS TEXT), ${seq}
    FROM json_each(${JSON.stringify(keys)}) WHERE ${guard.when ?? sql`1 = 1`}`);
  return postgres ? insert : insert.onConflictDoUpdate({ target: cacheDep.dep, set: { seq: sql`excluded.seq` } });
}

/** PostgreSQL: remove superseded change rows; the rows removed (0 on D1 and Turso, which keep one row per key). */
export async function compactCacheDeps(db: Database): Promise<number> {
  if (registeredDatabaseProvider(db) !== "postgres") return 0;
  const rows = await db.all<{ removed: number } | [number]>(sql`SELECT scalius_compat."cache_dep_compact"() AS removed`);
  const row = rows[0];
  return Number(Array.isArray(row) ? row[0] : row?.removed ?? 0);
}
