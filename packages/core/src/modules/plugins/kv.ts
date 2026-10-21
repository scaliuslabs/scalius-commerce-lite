// A plugin's small key/value store (`ctx.kv`), in the relational database so
// it is consistent with the plugin's other state on every provider. Expired
// entries read as absent and are pruned a few at a time on writes. Every
// write advances the entry's revision; `compareAndSet` writes only while the
// live entry is still at the revision read (null: absent).

import type { Database } from "@scalius/database/client";
import { buildBatchGuard, isBatchGuardError, safeBatch } from "@scalius/database/client";
import { pluginKv } from "@scalius/database/schema";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { PluginError } from "./errors";

export const PLUGIN_KV_KEY_MAX_LENGTH = 256;
export const PLUGIN_KV_VALUE_MAX_BYTES = 64 * 1024;
export const PLUGIN_KV_MAX_TTL_SECONDS = 365 * 24 * 60 * 60;
export const PLUGIN_KV_LIST_LIMIT = 1000;
const PRUNE_PER_WRITE = 20;

export function requireKvKey(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > PLUGIN_KV_KEY_MAX_LENGTH || /\p{Cc}/u.test(key)) {
    throw new PluginError("kv_invalid_key", `KV keys are 1 to ${PLUGIN_KV_KEY_MAX_LENGTH} printable characters.`);
  }
  return key;
}

const live = () => or(isNull(pluginKv.expiresAt), gt(pluginKv.expiresAt, sql`unixepoch()`));

export async function getPluginKvVersion(
  db: Database,
  pluginId: string,
  key: string,
): Promise<{ value: unknown; revision: number } | null> {
  const row = await db.select({ valueJson: pluginKv.valueJson, revision: pluginKv.revision }).from(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, requireKvKey(key)), live()))
    .get();
  return row ? { value: JSON.parse(row.valueJson) as unknown, revision: row.revision } : null;
}

export async function getPluginKv(db: Database, pluginId: string, key: string): Promise<unknown> {
  return (await getPluginKvVersion(db, pluginId, key))?.value ?? null;
}

const CONFLICT_MARKER = "plugin_kv_conflict";

export async function setPluginKv(
  db: Database,
  pluginId: string,
  key: string,
  value: unknown,
  options: { ttlSeconds?: number } = {},
): Promise<{ revision: number }> {
  return writePluginKv(db, pluginId, key, value, options, undefined);
}

/**
 * Sets the entry only while it is still at `expectedRevision` (null: no live
 * entry); otherwise nothing changes and it fails `kv_conflict`.
 */
export async function compareAndSetPluginKv(
  db: Database,
  pluginId: string,
  key: string,
  expectedRevision: unknown,
  value: unknown,
  options: { ttlSeconds?: number } = {},
): Promise<{ revision: number }> {
  if (expectedRevision !== null && !(typeof expectedRevision === "number" && Number.isSafeInteger(expectedRevision) && expectedRevision >= 1)) {
    throw new PluginError("kv_invalid_revision", "expectedRevision is a revision you read (a whole number from 1), or null for an absent entry.");
  }
  return writePluginKv(db, pluginId, key, value, options, expectedRevision);
}

async function writePluginKv(
  db: Database,
  pluginId: string,
  key: string,
  value: unknown,
  options: { ttlSeconds?: number },
  expectedRevision: number | null | undefined,
): Promise<{ revision: number }> {
  const kvKey = requireKvKey(key);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new PluginError("kv_value_too_large", "KV values must be JSON-serializable.");
  if (new TextEncoder().encode(json).byteLength > PLUGIN_KV_VALUE_MAX_BYTES) {
    throw new PluginError("kv_value_too_large", `KV values are at most ${PLUGIN_KV_VALUE_MAX_BYTES} bytes of JSON.`);
  }
  const ttl = options.ttlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1 || ttl > PLUGIN_KV_MAX_TTL_SECONDS)) {
    throw new PluginError("kv_invalid_ttl", `ttlSeconds is a whole number from 1 to ${PLUGIN_KV_MAX_TTL_SECONDS}.`);
  }
  const expiresAt = ttl === undefined ? null : sql`unixepoch() + ${ttl}`;
  const entry = and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, kvKey));
  const guards = expectedRevision === undefined ? [] : [buildBatchGuard(
    db,
    expectedRevision === null
      ? sql`NOT EXISTS (SELECT 1 FROM ${pluginKv} WHERE ${entry} AND ${live()})`
      : sql`EXISTS (SELECT 1 FROM ${pluginKv} WHERE ${entry} AND ${live()} AND ${pluginKv.revision} = ${expectedRevision})`,
    CONFLICT_MARKER,
  )];
  let results: unknown[];
  try {
    results = await safeBatch(db, [
      ...guards,
      db.insert(pluginKv).values({ pluginId, key: kvKey, valueJson: json, revision: 1, expiresAt, updatedAt: sql`unixepoch()` })
        .onConflictDoUpdate({
          target: [pluginKv.pluginId, pluginKv.key],
          set: {
            valueJson: sql`excluded.value_json`,
            revision: sql`${pluginKv.revision} + 1`,
            expiresAt: sql`excluded.expires_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        })
        .returning({ revision: pluginKv.revision }),
      db.delete(pluginKv).where(and(
        eq(pluginKv.pluginId, pluginId),
        inArray(pluginKv.key, db.select({ key: pluginKv.key }).from(pluginKv)
          .where(and(eq(pluginKv.pluginId, pluginId), lte(pluginKv.expiresAt, sql`unixepoch()`)))
          .limit(PRUNE_PER_WRITE)),
      )),
    ] as never) as unknown[];
  } catch (error) {
    if (guards.length > 0 && isBatchGuardError(error, CONFLICT_MARKER)) {
      throw new PluginError("kv_conflict", `${kvKey} changed since it was read: read it again and retry.`);
    }
    throw error;
  }
  const rows = results[guards.length];
  const revision = Array.isArray(rows) ? (rows[0] as { revision?: unknown } | undefined)?.revision : undefined;
  return { revision: typeof revision === "number" ? revision : 1 };
}

export async function deletePluginKv(db: Database, pluginId: string, key: string): Promise<void> {
  await db.delete(pluginKv).where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, requireKvKey(key))));
}

/** Live keys with the prefix (all keys without one), in key order, at most 1000. */
export async function listPluginKv(db: Database, pluginId: string, prefix = ""): Promise<string[]> {
  if (typeof prefix !== "string" || prefix.length > PLUGIN_KV_KEY_MAX_LENGTH) {
    throw new PluginError("kv_invalid_key", "The prefix is at most 256 characters.");
  }
  const rows = await db.select({ key: pluginKv.key }).from(pluginKv)
    .where(and(
      eq(pluginKv.pluginId, pluginId),
      live(),
      prefix ? sql`substr(${pluginKv.key}, 1, ${sql.raw(String([...prefix].length))}) = ${prefix}` : undefined,
    ))
    .orderBy(asc(pluginKv.key))
    .limit(PLUGIN_KV_LIST_LIMIT)
    .all();
  return rows.map((row) => row.key);
}
