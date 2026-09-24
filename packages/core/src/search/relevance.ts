import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import { and, eq, or, sql, type SQL } from "drizzle-orm";

import { publicCategoryConditions } from "../modules/categories/categories.publication";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "./fts5";

const MAX_CATEGORY_SLUG_SEARCH_LENGTH = 160;

/**
 * Matches products whose published category name (or exact slug) matches the
 * query, so "bags" finds products filed under a "Bags" category even when the
 * product title omits the word.
 */
export function productCategoryNameMatch(db: Database, query: string): SQL | undefined {
  const normalizedSlug = query.trim().toLowerCase();
  const categoryMatch = or(
    ftsMatch(db, "categories_fts", "categories", query, { column: "name" }),
    normalizedSlug.length <= MAX_CATEGORY_SLUG_SEARCH_LENGTH
      ? eq(categories.slug, normalizedSlug)
      : undefined,
  );
  if (!categoryMatch) return undefined;

  return sql`EXISTS (
    SELECT 1
    FROM "categories"
    WHERE ${eq(categories.id, products.categoryId)}
      AND ${and(...publicCategoryConditions())}
      AND ${categoryMatch}
  )`;
}

/**
 * Relevance order for product search (Baymard: title and product-type matches
 * first). Tier 0 = every term in the product title, tier 1 = the category name
 * matches, tier 2 = description-only. D1 then orders inside a tier by bm25 with
 * the title column weighted 10x the description; providers without FTS5 fall
 * back to the title.
 */
export function productSearchRelevanceOrder(db: Database, query: string): SQL[] {
  const titleMatch = ftsMatch(db, "products_fts", "products", query, { column: "name" });
  const categoryMatch = productCategoryNameMatch(db, query);
  const tier = sql`CASE
    WHEN ${titleMatch ?? sql`0 = 1`} THEN 0
    WHEN ${categoryMatch ?? sql`0 = 1`} THEN 1
    ELSE 2
  END`;
  const title = sql`${products.name}`;
  const sanitized = sanitizeFtsQuery(query);
  if (!isFts5SearchEnabled(db) || !sanitized) return [tier, title];
  return [
    tier,
    sql`COALESCE((
      SELECT bm25(products_fts, 10.0, 1.0)
      FROM products_fts
      WHERE products_fts MATCH ${sanitized} AND products_fts.rowid = ${sql.raw("products.rowid")}
    ), 0)`,
    title,
  ];
}
