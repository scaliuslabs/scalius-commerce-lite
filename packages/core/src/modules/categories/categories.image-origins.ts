// The other hosts the catalogue's images come from. Every product, brand,
// variant and order image is one of the store's own files (a media id); the
// one catalogue image that may be a URL on any https host is a category's.
// A buyer's private page loads images only from the store's own origins and
// the image hosts the merchant allows (Settings → Security): the dashboard
// lists these so the merchant can allow one instead of a placeholder there.
import { categories } from "@scalius/database/schema";
import { and, asc, gt, isNull, like } from "drizzle-orm";
import type { Database } from "@scalius/database/client";

/** Category images read per query, the most queries one listing makes, and the most hosts returned. */
export const CATEGORY_IMAGE_ORIGINS_PAGE = 500;
export const CATEGORY_IMAGE_ORIGINS_PAGES = 10;
export const CATEGORY_IMAGE_ORIGINS_MAX = 50;

function originOf(url: string | null): string | null {
  try {
    const parsed = new URL(url ?? "");
    return parsed.protocol === "https:" && !parsed.username && !parsed.password ? parsed.origin.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * The distinct https origins of the live categories' image URLs, sorted:
 * every category (in id order, a page at a time, up to the bound of queries).
 */
export async function categoryImageOrigins(db: Database): Promise<string[]> {
  const origins = new Set<string>();
  let after = "";
  for (let page = 0; page < CATEGORY_IMAGE_ORIGINS_PAGES; page += 1) {
    const rows = await db
      .select({ id: categories.id, url: categories.imageUrl })
      .from(categories)
      .where(and(isNull(categories.deletedAt), like(categories.imageUrl, "https://%"), gt(categories.id, after)))
      .orderBy(asc(categories.id))
      .limit(CATEGORY_IMAGE_ORIGINS_PAGE)
      .all();
    for (const row of rows) {
      const origin = originOf(row.url);
      if (origin) origins.add(origin);
    }
    if (rows.length < CATEGORY_IMAGE_ORIGINS_PAGE || origins.size > CATEGORY_IMAGE_ORIGINS_MAX) break;
    after = rows[rows.length - 1]!.id;
  }
  return [...origins].sort().slice(0, CATEGORY_IMAGE_ORIGINS_MAX);
}
