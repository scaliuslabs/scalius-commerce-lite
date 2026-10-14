import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import { and, eq, or, sql, type SQL } from "drizzle-orm";

import { publicCategoryConditions } from "../categories";
import { searchMatch, searchRank } from "../../search";

const MAX_CATEGORY_SLUG_SEARCH_LENGTH = 160;

/**
 * Matches products whose published category name (or exact slug) matches the
 * query, so "bags" finds products filed under a "Bags" category even when the
 * product title omits the word.
 */
export function productCategoryNameMatch(db: Database, query: string): SQL | undefined {
  const normalizedSlug = query.trim().toLowerCase();
  const categoryMatch = or(
    searchMatch(db, "categories", query, { column: "name" }),
    normalizedSlug.length <= MAX_CATEGORY_SLUG_SEARCH_LENGTH
      ? eq(categories.slug, normalizedSlug)
      : undefined,
  );
  if (!categoryMatch) return undefined;

  // A set of matching category ids, not a per-product EXISTS: OR-ed with the
  // products_fts rowid set, both sides stay index lookups instead of forcing
  // a scan of every product (1.4M rows read per search at 30k products).
  return sql`${products.categoryId} IN (
    SELECT "categories"."id"
    FROM "categories"
    WHERE ${and(...publicCategoryConditions())}
      AND ${categoryMatch}
  )`;
}


/**
 * Relevance order for product search (Baymard: title and product-type matches
 * first). Tier 0 = every term in the product title, tier 1 = the category name
 * matches, tier 2 = description-only. Inside a tier, FTS5's bm25 with the
 * title weighted 10x the description (`productSearchRank`, on every
 * provider), then the title.
 */
export function productSearchRelevanceOrder(db: Database, query: string): SQL[] {
  const titleMatch = searchMatch(db, "products", query, { column: "name" });
  const categoryMatch = productCategoryNameMatch(db, query);
  const tier = sql`CASE
    WHEN ${titleMatch ?? sql`0 = 1`} THEN 0
    WHEN ${categoryMatch ?? sql`0 = 1`} THEN 1
    ELSE 2
  END`;
  const title = sql`${products.name}`;
  const rank = productSearchRank(db, query);
  return rank ? [tier, rank.score, title] : [tier, title];
}

/**
 * The bm25 score of each product for the query. On D1 it is one set
 * (`search_rank`) the caller LEFT JOINs (`join`) to `products` whenever it
 * orders by productSearchRelevanceOrder: a correlated per-row MATCH re-ran
 * the search for every candidate, 3 s of D1 time for a query such as
 * "gaming" whose category match brings in thousands of products.
 */
export function productSearchRank(db: Database, query: string) {
  return searchRank(db, "products", query, { alias: "search_rank", weights: [10, 1] });
}
