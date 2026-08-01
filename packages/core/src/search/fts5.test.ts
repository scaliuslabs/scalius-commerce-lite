import { getDb } from "@scalius/database/client";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import {
  ftsMatch,
  isFts5SearchEnabled,
  sanitizeFtsQuery,
} from "./fts5";

const dialect = new SQLiteSyncDialect();

describe("provider-aware text search", () => {
  it("uses FTS5 for D1", () => {
    const db = getDb({ DB: { prepare() {} } as unknown as D1Database });
    const condition = ftsMatch(db, "products_fts", "products", "blue shirt")!;
    const query = dialect.sqlToQuery(condition);

    expect(isFts5SearchEnabled(db)).toBe(true);
    expect(query.sql).toContain("products_fts");
    expect(query.sql.toLowerCase()).toContain("match");
    expect(query.params).toEqual(["blue* shirt*"]);
  });

  it("uses bounded ordinary-SQL search for Turso MVCC", () => {
    const db = getDb({
      TURSO_DATABASE_URL: "https://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    });
    const condition = ftsMatch(db, "products_fts", "products", "blue shirt")!;
    const query = dialect.sqlToQuery(condition);

    expect(isFts5SearchEnabled(db)).toBe(false);
    expect(query.sql).not.toContain("products_fts");
    expect(query.sql).toContain("instr(lower(coalesce(products.name");
    expect(query.sql).toContain("instr(lower(coalesce(products.description");
    expect(query.params).toEqual(["blue", "blue", "shirt", "shirt"]);
  });

  it("preserves an explicit FTS column scope in both providers", () => {
    const d1 = getDb({ DB: { prepare() {} } as unknown as D1Database });
    const turso = getDb({
      TURSO_DATABASE_URL: "https://merchant.turso.io",
      TURSO_AUTH_TOKEN: "token",
    });

    const d1Query = dialect.sqlToQuery(
      ftsMatch(d1, "categories_fts", "categories", "men clothing", {
        column: "name",
      })!,
    );
    const tursoQuery = dialect.sqlToQuery(
      ftsMatch(turso, "categories_fts", "categories", "men clothing", {
        column: "name",
      })!,
    );

    expect(d1Query.params).toEqual(["name : (men* clothing*)"]);
    expect(tursoQuery.sql).toContain("categories.name");
    expect(tursoQuery.sql).not.toContain("categories.description");
    expect(tursoQuery.params).toEqual(["men", "clothing"]);
  });

  it("caps user search terms below SQLite's bind limit", () => {
    expect(sanitizeFtsQuery("one two three four five six seven eight nine ten"))
      .toBe("one* two* three* four* five* six* seven* eight*");
  });
});
