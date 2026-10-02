// Dependency keys of storefront app output (sections, product blocks and the
// scripts of active apps; `@scalius/shared/cache-deps`, `plg` and `plgs`).
//
// The plugin tables are not part of the trigger registry: their buyer-visible
// effect is decided per write by this module, which owns every write to
// them. Each write appends `pluginCacheDepStatements` to its own batch, so
// the key advances atomically with the change, exactly as a generated
// trigger would (same clock, same `cache_dep` rows):
//
// - any installation write (install, activate, deactivate, fail, update,
//   settings, uninstall) advances `plg:<id>` and `plg:*`;
// - a record write or delete advances `plgs:<id>:<collection>`;
// - an uninstall that deletes data advances every collection it removes.
//
// KV writes advance nothing: KV is not readable while rendering storefront
// output (the bridge refuses it in render mode).

import { cacheClock, cacheDep } from "@scalius/database/schema";
import type { Database } from "@scalius/database/client";
import { cacheDep as cacheDepKey } from "@scalius/shared/cache-deps";
import { eq, sql } from "drizzle-orm";

/** The two statements that advance `keys` to the next clock value (append them to the write's batch). */
export function pluginCacheDepStatements(db: Database, keys: readonly string[]) {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return [] as const;
  const next = sql<number>`(SELECT ${cacheClock.seq} FROM ${cacheClock} WHERE ${cacheClock.id} = 1)`;
  return [
    db.update(cacheClock).set({ seq: sql`${cacheClock.seq} + 1` }).where(eq(cacheClock.id, 1)),
    db.insert(cacheDep).values(unique.map((dep) => ({ dep, seq: next })))
      .onConflictDoUpdate({ target: cacheDep.dep, set: { seq: sql`excluded.seq` } }),
  ] as const;
}

/** Keys an installation write advances. */
export function pluginInstallationCacheDeps(pluginId: string): string[] {
  return [cacheDepKey.plugin(pluginId), cacheDepKey.anyPlugin()];
}

/** Keys a record write in one collection advances. */
export function pluginCollectionCacheDeps(pluginId: string, collections: Iterable<string>): string[] {
  return [...new Set(collections)].map((collection) => cacheDepKey.pluginCollection(pluginId, collection));
}
