// Small store-internal key/value rows (`system_kv`, migration 0147) in the
// selected relational provider, so a store needs no Workers KV namespace.
// An expired row reads as absent; `purgeExpiredSystemKv` deletes them.
// Prefix lists use `substr()`, not LIKE or a range, so every provider and
// collation matches the same keys.

import type { Database } from "@scalius/database/client";
import { systemKv } from "@scalius/database/schema";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";

export const SYSTEM_KV_LIST_LIMIT = 1000;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const live = (now: number) => or(isNull(systemKv.expiresAt), gt(systemKv.expiresAt, now));

const hasPrefix = (prefix: string) =>
  prefix ? sql`substr(${systemKv.key}, 1, ${sql.raw(String([...prefix].length))}) = ${prefix}` : undefined;

export async function getSystemKv(db: Database, key: string): Promise<string | null> {
  const row = await db.select({ value: systemKv.value }).from(systemKv)
    .where(and(eq(systemKv.key, key), live(nowSeconds())))
    .get();
  return row?.value ?? null;
}

/** Live rows for up to 90 keys in one read (D1 binds at most 100 values); a missing key is absent. */
export async function getSystemKvMany(db: Database, keys: readonly string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return new Map();
  if (wanted.length > 90) throw new Error("getSystemKvMany reads at most 90 keys at a time.");
  const rows = await db.select({ key: systemKv.key, value: systemKv.value }).from(systemKv)
    .where(and(inArray(systemKv.key, wanted), live(nowSeconds())))
    .all();
  return new Map(rows.map((row) => [row.key, row.value]));
}

/** Writes the row; `expiresAt` is unix seconds (null: never). */
export async function putSystemKv(
  db: Database,
  key: string,
  value: string,
  expiresAt: number | null = null,
): Promise<void> {
  await db.insert(systemKv).values({ key, value, expiresAt })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
    });
}

/**
 * Sets the row to `value` unless a live row already holds it. True when this
 * call changed it: a compare-and-set claim that two callers cannot both win.
 */
export async function claimSystemKv(db: Database, key: string, value: string): Promise<boolean> {
  const rows = await db.insert(systemKv).values({ key, value, expiresAt: null })
    .onConflictDoUpdate({
      target: systemKv.key,
      set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
      setWhere: sql`${systemKv.value} <> excluded.value OR ${systemKv.expiresAt} <= ${nowSeconds()}`,
    })
    .returning({ key: systemKv.key });
  return rows.length > 0;
}

export async function deleteSystemKv(db: Database, key: string): Promise<void> {
  await db.delete(systemKv).where(eq(systemKv.key, key));
}

/** Live keys with the prefix in key order, after `cursor` (the last key of the previous page). */
export async function listSystemKv(
  db: Database,
  prefix: string,
  options: { limit?: number; cursor?: string } = {},
): Promise<{ keys: string[]; cursor: string | null }> {
  const limit = Math.max(1, Math.min(options.limit ?? SYSTEM_KV_LIST_LIMIT, SYSTEM_KV_LIST_LIMIT));
  const rows = await db.select({ key: systemKv.key }).from(systemKv)
    .where(and(
      live(nowSeconds()),
      hasPrefix(prefix),
      options.cursor ? gt(systemKv.key, options.cursor) : undefined,
    ))
    .orderBy(asc(systemKv.key))
    .limit(limit + 1)
    .all();
  const keys = rows.slice(0, limit).map((row) => row.key);
  return { keys, cursor: rows.length > limit ? keys.at(-1) ?? null : null };
}

/** Deletes up to `limit` expired rows; returns how many. */
export async function purgeExpiredSystemKv(db: Database, limit = 500): Promise<number> {
  const deleted = await db.delete(systemKv)
    .where(inArray(systemKv.key, db.select({ key: systemKv.key }).from(systemKv)
      .where(lte(systemKv.expiresAt, nowSeconds()))
      .limit(limit)))
    .returning({ key: systemKv.key });
  return deleted.length;
}
