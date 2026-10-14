import { getDb } from "@scalius/database/client";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  isFts5SearchEnabled,
  sanitizeFtsQuery,
  searchKeys,
  searchMatch,
  searchPrefixKeys,
  searchRankJoin,
} from "./text-search";
import { productSearchRelevanceOrder } from "../modules/catalog/search-relevance";

const dialect = new SQLiteSyncDialect();
const d1 = () => getDb({ DB: { prepare() {} } as unknown as D1Database });
const turso = () => getDb({ TURSO_DATABASE_URL: "https://merchant.turso.io", TURSO_AUTH_TOKEN: "token" });

describe("provider-aware text search", () => {
  it("matches D1's FTS5 tables with the same MATCH expressions as before", () => {
    const db = d1();
    expect(isFts5SearchEnabled(db)).toBe(true);
    const query = dialect.sqlToQuery(searchMatch(db, "products", "blue shirt")!);
    expect(query.sql).toBe('products.rowid IN (SELECT rowid FROM products_fts WHERE products_fts MATCH ?)');
    expect(query.params).toEqual(["blue* shirt*"]);
    expect(dialect.sqlToQuery(searchKeys(db, "categories", "men clothing", { column: "name" })!).params)
      .toEqual(["name : (men* clothing*)"]);
    expect(dialect.sqlToQuery(searchPrefixKeys(db, "customers", "phone", ["01712", "1712"])).params)
      .toEqual(["phone : (01712* OR 1712*)"]);
    const rank = searchRankJoin(db, "products", "blue", { alias: "search_rank", weights: [10, 1] })!;
    expect(dialect.sqlToQuery(rank.table).sql).toContain("bm25(products_fts, 10.0, 1.0)");
  });

  it("reads the search index on Turso and PostgreSQL: one index range per word", () => {
    const db = turso();
    expect(isFts5SearchEnabled(db)).toBe(false);
    const query = dialect.sqlToQuery(searchMatch(db, "products", "Blue T-Shirt")!);
    expect(query.sql).not.toContain("products_fts");
    expect(query.sql).toMatch(/^products\.id IN \(SELECT doc_id FROM search_fts_terms WHERE source = \? AND term >= \? AND term < \? INTERSECT /);
    // "T-Shirt" is two FTS5 tokens; each word is a prefix of a stored term.
    expect(query.params).toEqual(["products", "blue", "bluf", "products", "t", "u", "products", "shirt", "shiru"]);
  });

  it("folds query words as the index stores them, and a column is its position", () => {
    const query = dialect.sqlToQuery(searchMatch(turso(), "categories", "CAFÉ", { column: "name" })!);
    expect(query.params).toEqual(["categories", 0, "cafe", "caff"]);
    // A word made only of separators matches nothing, as in FTS5.
    expect(dialect.sqlToQuery(searchMatch(turso(), "products", "©")!).sql).toContain("WHERE 0 = 1");
    expect(() => searchMatch(turso(), "products", "x", { column: "sku" })).toThrow(/Invalid search column/);
  });

  it("ranks by title/category tiers and the search index's bm25 on Turso and PostgreSQL", () => {
    const order = productSearchRelevanceOrder(turso(), "bag")
      .map((term) => dialect.sqlToQuery(term).sql)
      .join(" ");
    expect(order).not.toContain("_fts ");
    expect(order).toContain("COALESCE(search_rank.rank_score, 0)");
    const rank = dialect.sqlToQuery(searchRankJoin(turso(), "products", "bag", { alias: "search_rank", weights: [10, 1] })!.table).sql;
    expect(rank).toContain("CASE col WHEN 0 THEN 10.0 WHEN 1 THEN 1.0 ELSE 1.0 END * tf");
    expect(rank).toContain("ln(");
  });

  it("caps user search terms below SQLite's bind limit", () => {
    expect(sanitizeFtsQuery("one two three four five six seven eight nine ten"))
      .toBe("one* two* three* four* five* six* seven* eight*");
  });
});
