// A plugin's small key/value store (`ctx.kv`), in the relational database so
// it is consistent with the plugin's other state on every provider. Expired
// entries read as absent and are pruned a few at a time on writes.

import type { Database } from "@scalius/database/client";
import { safeBatch } from "@scalius/database/client";
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
    throw new PluginError("kv.invalid_key", `KV keys are 1 to ${PLUGIN_KV_KEY_MAX_LENGTH} printable characters.`);
  }
  return key;
}

const live = () => or(isNull(pluginKv.expiresAt), gt(pluginKv.expiresAt, sql`unixepoch()`));

export async function getPluginKv(db: Database, pluginId: string, key: string): Promise<unknown> {
  const row = await db.select({ valueJson: pluginKv.valueJson }).from(pluginKv)
    .where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, requireKvKey(key)), live()))
    .get();
  return row ? JSON.parse(row.valueJson) as unknown : null;
}

export async function setPluginKv(
  db: Database,
  pluginId: string,
  key: string,
  value: unknown,
  options: { ttlSeconds?: number } = {},
): Promise<void> {
  const kvKey = requireKvKey(key);
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) throw new PluginError("kv.value_too_large", "KV values must be JSON-serializable.");
  if (new TextEncoder().encode(json).byteLength > PLUGIN_KV_VALUE_MAX_BYTES) {
    throw new PluginError("kv.value_too_large", `KV values are at most ${PLUGIN_KV_VALUE_MAX_BYTES} bytes of JSON.`);
  }
  const ttl = options.ttlSeconds;
  if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 1 || ttl > PLUGIN_KV_MAX_TTL_SECONDS)) {
    throw new PluginError("kv.invalid_ttl", `ttlSeconds is a whole number from 1 to ${PLUGIN_KV_MAX_TTL_SECONDS}.`);
  }
  const expiresAt = ttl === undefined ? null : sql`unixepoch() + ${ttl}`;
  await safeBatch(db, [
    db.insert(pluginKv).values({ pluginId, key: kvKey, valueJson: json, expiresAt, updatedAt: sql`unixepoch()` })
      .onConflictDoUpdate({
        target: [pluginKv.pluginId, pluginKv.key],
        set: { valueJson: sql`excluded.value_json`, expiresAt: sql`excluded.expires_at`, updatedAt: sql`excluded.updated_at` },
      }),
    db.delete(pluginKv).where(and(
      eq(pluginKv.pluginId, pluginId),
      inArray(pluginKv.key, db.select({ key: pluginKv.key }).from(pluginKv)
        .where(and(eq(pluginKv.pluginId, pluginId), lte(pluginKv.expiresAt, sql`unixepoch()`)))
        .limit(PRUNE_PER_WRITE)),
    )),
  ] as never);
}

export async function deletePluginKv(db: Database, pluginId: string, key: string): Promise<void> {
  await db.delete(pluginKv).where(and(eq(pluginKv.pluginId, pluginId), eq(pluginKv.key, requireKvKey(key))));
}

/** Live keys with the prefix (all keys without one), in key order, at most 1000. */
export async function listPluginKv(db: Database, pluginId: string, prefix = ""): Promise<string[]> {
  if (typeof prefix !== "string" || prefix.length > PLUGIN_KV_KEY_MAX_LENGTH) {
    throw new PluginError("kv.invalid_key", "The prefix is at most 256 characters.");
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
