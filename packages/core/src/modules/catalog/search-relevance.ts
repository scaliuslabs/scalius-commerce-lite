import type { Database } from "@scalius/database/client";
import { categories, products } from "@scalius/database/schema";
import { and, eq, or, sql, type SQL, type SQLWrapper } from "drizzle-orm";

import { publicCategoryConditions } from "../categories";
import { ftsMatch, isFts5SearchEnabled, sanitizeFtsQuery } from "../../search/fts5";
import { buyerState } from "./buyer-state";

const MAX_CATEGORY_SLUG_SEARCH_LENGTH = 160;

/**
 * Matches products whose published category name (or exact slug) matches the
 * query, so "bags" finds products filed under a "Bags" category even when the
 * product title omits the word.
 */
export function productCategoryNameMatch(db: Database, query: string, category: SQLWrapper = products.categoryId): SQL | undefined {
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
  return sql`${category} IN (
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

/** Only the first 100 rank positions can use the bounded FTS probe. */
const MAX_RANK_PAGE_POSITION = 100;

/**
 * A full-query rank prefix can answer a page entirely from title matches
 * only when it contains every possible tie at that page's cutoff. Otherwise
 * the original full-tier page runs, including category-only matches.
 */
export function boundedProductSearchPage(
  db: Database,
  query: string,
  input: { limit: number; offset: number; eligibility: SQL[]; fallback: SQL },
): SQL | undefined {
  const needed = input.offset + input.limit + 1;
  const sanitized = sanitizeFtsQuery(query);
  if (!isFts5SearchEnabled(db) || !sanitized || needed > MAX_RANK_PAGE_POSITION) return undefined;
  const budget = needed * 4 + 1;
  const count = sql.raw(String(needed));
  const prefixLimit = sql.raw(String(budget));
  return sql`
    WITH rank_prefix AS MATERIALIZED (
      SELECT rowid AS rank_rowid, rank AS relevance_score
      FROM products_fts
      WHERE products_fts MATCH ${sanitized} AND rank MATCH 'bm25(10.0,1.0)'
      ORDER BY rank LIMIT ${prefixLimit}
    ), prefix_bounds AS MATERIALIZED (
      SELECT COUNT(*) AS prefix_count, MAX(relevance_score) AS last_score FROM rank_prefix
    ), eligible_titles AS MATERIALIZED (
      SELECT ${buyerState.productId} AS page_product_id, rank_prefix.relevance_score,
        ${products.name} AS product_name, ${buyerState.productCreatedAt} AS product_created_at
      FROM rank_prefix
      CROSS JOIN ${products}
      CROSS JOIN ${buyerState}
      WHERE products.rowid = rank_prefix.rank_rowid AND ${buyerState.productId} = ${products.id}
        AND ${ftsMatch(db, "products_fts", "products", query, { column: "name" })!}
        AND ${and(...input.eligibility) ?? sql`1 = 1`}
    ), prefix_proof AS MATERIALIZED (
      SELECT CASE WHEN COUNT(*) >= ${count} AND (
        (SELECT prefix_count FROM prefix_bounds) < ${prefixLimit}
        OR SUM(CASE WHEN relevance_score < (SELECT last_score FROM prefix_bounds) THEN 1 ELSE 0 END) >= ${count}
      ) THEN 1 ELSE 0 END AS use_prefix FROM eligible_titles
    ), prefix_page AS MATERIALIZED (
      SELECT page_product_id, 0 AS relevance_tier, relevance_score FROM eligible_titles
      ORDER BY relevance_score, product_name, product_created_at DESC, page_product_id
      LIMIT (SELECT CASE WHEN use_prefix = 1 THEN ${sql.raw(String(input.limit + 1))} ELSE 0 END FROM prefix_proof)
      OFFSET ${sql.raw(String(input.offset))}
    ), baseline_page AS MATERIALIZED (
      SELECT * FROM (${input.fallback})
      LIMIT (SELECT CASE WHEN use_prefix = 0 THEN 9223372036854775807 ELSE 0 END FROM prefix_proof)
    )
    SELECT * FROM prefix_page UNION ALL SELECT * FROM baseline_page
  `;
}

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
