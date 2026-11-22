// The other hosts the catalogue's images come from. A category image may be
// a URL on any https host (product photos are the store's own files), and a
// buyer's private page loads images only from the store's own origins and
// the hosts the merchant allows (Settings → Security): the dashboard lists
// these so the merchant can allow one instead of seeing a placeholder there.
import { categories } from "@scalius/database/schema";
import { and, isNull, like } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

/** At most this many category images are read, and this many hosts returned. */
export const CATEGORY_IMAGE_ORIGINS_SCAN = 500;
export const CATEGORY_IMAGE_ORIGINS_MAX = 50;

/** The distinct https origins of the live categories' image URLs, sorted. */
export async function categoryImageOrigins(db: Database): Promise<string[]> {
  const rows = await db
    .select({ url: categories.imageUrl })
    .from(categories)
    .where(and(isNull(categories.deletedAt), like(categories.imageUrl, "https://%")))
    .limit(CATEGORY_IMAGE_ORIGINS_SCAN)
    .all();
  const origins = new Set<string>();
  for (const { url } of rows) {
    try {
      const parsed = new URL(url ?? "");
      if (parsed.protocol === "https:" && !parsed.username && !parsed.password) origins.add(parsed.origin.toLowerCase());
    } catch {
      // Not a URL: nothing to allow.
    }
  }
  return [...origins].sort().slice(0, CATEGORY_IMAGE_ORIGINS_MAX);
}
