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
  if (!productSearchRankJoin(db, query)) return [tier, title];
  return [tier, sql.raw(`COALESCE(${SEARCH_RANK_ALIAS}.rank_score, 0)`), title];
}

const SEARCH_RANK_ALIAS = "search_rank";

/**
 * The bm25 score of every product matching the query, as one set the caller
 * LEFT JOINs to `products` whenever it orders by productSearchRelevanceOrder
 * (which reads `search_rank.rank_score`). Undefined without FTS5.
 *
 * A correlated bm25 lookup per candidate row re-ran the FTS query for every
 * product: 3 s of D1 time for a query such as "gaming" whose category match
 * brings in thousands of products. `LIMIT -1` stops SQLite from flattening
 * the set back into that per-row lookup, so it is materialized once.
 */
export function productSearchRankJoin(db: Database, query: string): { table: SQL; on: SQL } | undefined {
  const sanitized = sanitizeFtsQuery(query);
  if (!isFts5SearchEnabled(db) || !sanitized) return undefined;
  return {
    table: sql`(
      SELECT rowid AS rank_rowid, bm25(products_fts, 10.0, 1.0) AS rank_score
      FROM products_fts
      WHERE products_fts MATCH ${sanitized}
      LIMIT -1
    ) AS ${sql.raw(SEARCH_RANK_ALIAS)}`,
    on: sql.raw(`${SEARCH_RANK_ALIAS}.rank_rowid = "products".rowid`),
  };
}
