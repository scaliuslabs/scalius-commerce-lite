// The ids catalogue handles name (`@scalius/shared/storefront-theme` handles):
// what an app template, page preset or section-settings write names by
// handle, resolved against the store when it is applied or listed. A live
// (not trashed) category or collection with that slug resolves; anything
// else does not, and the section that names it is left out.
import { and, isNull, sql } from "drizzle-orm";
import { categories, collections } from "@scalius/database/schema";
import { safeBatch, type Database } from "@scalius/database/client";
import {
  storefrontHandleKey,
  storefrontHandleRefs,
  type StorefrontHandleLookup,
  type StorefrontHandleRef,
} from "@scalius/shared/storefront-theme";

/** Handles one lookup resolves (a bound json_each set per kind, within D1's parameter limit). */
export const THEME_HANDLE_LOOKUP_MAX = 200;

/**
 * A lookup for every handle the values name: one batch, one indexed read per
 * kind named (none when the values name no handle). Handles past the bound
 * resolve to nothing.
 */
export async function readThemeHandleLookup(db: Database, values: readonly unknown[]): Promise<StorefrontHandleLookup> {
  const refs = new Map<string, StorefrontHandleRef>();
  for (const value of values) {
    for (const ref of storefrontHandleRefs(value)) {
      if (refs.size >= THEME_HANDLE_LOOKUP_MAX) break;
      refs.set(storefrontHandleKey(ref), ref);
    }
  }
  const handles = (kind: StorefrontHandleRef["kind"]) => JSON.stringify([...refs.values()].filter((ref) => ref.kind === kind).map((ref) => ref.handle));
  const found = new Map<string, string>();
  const kinds = (["category", "collection"] as const).filter((kind) => [...refs.values()].some((ref) => ref.kind === kind));
  if (kinds.length > 0) {
    const reads = kinds.map((kind) => kind === "category"
      ? db.select({ id: categories.id, slug: categories.slug }).from(categories).where(and(
        sql`${categories.slug} IN (SELECT CAST(value AS TEXT) FROM json_each(${handles(kind)}))`,
        isNull(categories.deletedAt),
      ))
      : db.select({ id: collections.id, slug: collections.slug }).from(collections).where(and(
        sql`${collections.slug} IN (SELECT CAST(value AS TEXT) FROM json_each(${handles(kind)}))`,
        isNull(collections.deletedAt),
      )));
    const results = await safeBatch(db, reads as never) as Array<Array<{ id: string; slug: string | null }>>;
    kinds.forEach((kind, index) => {
      for (const row of results[index] ?? []) if (row.slug) found.set(`${kind}:${row.slug}`, row.id);
    });
  }
  return (ref) => found.get(storefrontHandleKey(ref)) ?? null;
}
