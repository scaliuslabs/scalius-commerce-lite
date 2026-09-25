import { eq, inArray, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { safeBatch } from "../src/batch-helper";
import { getDb } from "../src/client";
import { createPostgresDatabase, type PostgresHttpConnection } from "../src/postgres-adapter";
import {
  currentReadObserver,
  observeStatement,
  runWithReadObserver,
  statementTables,
  UNPARSEABLE_STATEMENT_TABLE,
  type ReadObserver,
} from "../src/read-observer";
import { categories, productBuyerState, products, productVariants, settings } from "../src/schema";
import {
  createMigratedSqlite,
  createSqliteD1Binding,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "../src/testing/sqlite-d1";
import type { Database } from "../src/types";

const dialect = new SQLiteSyncDialect();

function recorder(): ReadObserver & { tables: Set<string>; statements: number } {
  const tables = new Set<string>();
  const observer = {
    tables,
    statements: 0,
    observeTables(seen: readonly string[]) {
      observer.statements += 1;
      for (const table of seen) tables.add(table);
    },
  };
  return observer;
}

async function capture(run: () => Promise<unknown>): Promise<string[]> {
  const observer = recorder();
  await runWithReadObserver(observer, run);
  return [...observer.tables].sort();
}

/** One representative public read: a join, a subquery and a batch. */
async function representativeReads(db: Database): Promise<void> {
  await db
    .select({ id: products.id, sku: productVariants.sku })
    .from(products)
    .leftJoin(productVariants, eq(productVariants.productId, products.id))
    .where(inArray(products.id, db.select({ id: productBuyerState.productId }).from(productBuyerState)))
    .all();
  await safeBatch(db, [
    db.select({ id: categories.id }).from(categories),
    db.select({ key: settings.key }).from(settings).where(eq(settings.category, "seo")),
  ] as const);
}

const REPRESENTATIVE_TABLES = ["categories", "product_buyer_state", "product_variants", "products", "settings"];

describe("statement table extraction", () => {
  it("reads Drizzle's quoted joins and subqueries", () => {
    const query = dialect.sqlToQuery(
      sql`select ${products.id} from ${products} left join ${productVariants} on ${productVariants.productId} = ${products.id} where ${products.id} in (select ${productBuyerState.productId} from ${productBuyerState})`,
    );
    expect([...statementTables(query.sql)].sort()).toEqual(["product_buyer_state", "product_variants", "products"]);
  });

  it("handles raw SQL shapes readers write by hand", () => {
    const cases: Array<[string, string[]]> = [
      ["SELECT * FROM products p, product_variants v WHERE v.product_id = p.id", ["product_variants", "products"]],
      ["select p.id from products as p join main.categories c on c.id = p.category_id", ["categories", "products"]],
      ["SELECT value FROM json_each(?) j JOIN products ON products.id = j.value", ["products"]],
      ["WITH RECURSIVE tree(id) AS (SELECT id FROM categories UNION ALL SELECT c.id FROM categories c JOIN tree ON c.parent_id = tree.id) SELECT * FROM tree", ["categories"]],
      ["with \"sq\" as (select \"id\" from \"brands\"), other as not materialized (select 1 from pages) select * from \"sq\", other", ["brands", "pages"]],
      ["SELECT 'from orders' AS label FROM settings -- from customers\n /* join user */", ["settings"]],
      ["select \"from\", \"valid_from\" from \"promotions\" where a is not distinct from b", ["promotions"]],
      ["SELECT (SELECT count(*) FROM product_media m WHERE m.product_id = p.id), 0 FROM products p ORDER BY a, b", ["product_media", "products"]],
      ["select * from products group by category_id, brand_id limit 10, 20", ["products"]],
      ["INSERT INTO cache_dep (dep, seq) SELECT ?, seq FROM cache_clock ON CONFLICT (dep) DO UPDATE SET seq = excluded.seq", ["cache_clock", "cache_dep"]],
      ["UPDATE OR IGNORE \"products\" SET \"name\" = ? WHERE \"id\" = ?", ["products"]],
      ["DELETE FROM media WHERE id = ?", ["media"]],
      ["select 1", []],
      ["SELECT seq FROM [cache_clock]", ["cache_clock"]],
    ];
    for (const [statement, tables] of cases) {
      expect([...statementTables(statement)].sort(), statement).toEqual(tables);
    }
  });

  it("returns the same frozen array for a repeated literal-free statement", () => {
    const statement = "select \"id\" from \"products\" where \"id\" = ?";
    expect(statementTables(statement)).toBe(statementTables(statement));
    expect(Object.isFrozen(statementTables(statement))).toBe(true);
  });
});

describe("read observer", () => {
  it("does nothing outside an observer and isolates concurrent observers", async () => {
    expect(currentReadObserver()).toBeUndefined();
    observeStatement("select * from products");

    const first = recorder();
    const second = recorder();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
    await Promise.all([
      runWithReadObserver(first, async () => {
        observeStatement("select * from products");
        await tick();
        observeStatement("select * from categories");
      }),
      runWithReadObserver(second, async () => {
        await tick();
        observeStatement("select * from brands");
        await tick();
        observeStatement("select * from pages");
      }),
    ]);
    expect([...first.tables].sort()).toEqual(["categories", "products"]);
    expect([...second.tables].sort()).toEqual(["brands", "pages"]);
  });

  it("never lets an observer failure reach the query", async () => {
    const { db } = createSqliteD1Database();
    const throwing: ReadObserver = {
      observeTables() {
        throw new Error("observer bug");
      },
    };
    await expect(runWithReadObserver(throwing, () => db.select({ id: products.id }).from(products).all()))
      .resolves.toEqual([]);
  });

  it("reports the unparseable pseudo-table instead of nothing when parsing fails", () => {
    const observer = recorder();
    const poisoned = { indexOf: () => { throw new Error("boom"); } } as unknown as string;
    runWithReadObserver(observer, () => observeStatement(poisoned));
    expect([...observer.tables]).toEqual([UNPARSEABLE_STATEMENT_TABLE]);
  });
});

describe("capture on every provider", () => {
  it("D1 through getDb, with and without a request session", async () => {
    const sqlite = createMigratedSqlite();
    const plain = getDb({ DB: createSqliteD1Binding(sqlite) });
    expect(await capture(() => representativeReads(plain))).toEqual(REPRESENTATIVE_TABLES);

    const binding = createSqliteD1Binding(sqlite);
    const sessionBinding = Object.assign(Object.create(binding) as D1Database, {
      withSession: () => binding,
    });
    const session = getDb({ DB: sessionBinding });
    expect(await capture(() => representativeReads(session))).toEqual(REPRESENTATIVE_TABLES);
  });

  it("D1 test harness database", async () => {
    const { db } = createSqliteD1Database();
    expect(await capture(() => representativeReads(db))).toEqual(REPRESENTATIVE_TABLES);
  });

  it("Turso adapter, single statements and read batches", async () => {
    const db = createSqliteTursoDatabase(createMigratedSqlite({ provider: "turso" }));
    expect(await capture(() => representativeReads(db))).toEqual(REPRESENTATIVE_TABLES);
  });

  it("PostgreSQL adapter, single statements and read batches", async () => {
    const connection: PostgresHttpConnection = {
      query: () => Promise.resolve({ rows: [], fields: [] }),
      transaction: async (queries) => Promise.all(queries),
    };
    const db = createPostgresDatabase("postgresql://user:secret@example.neon.tech/db", {
      connect: () => connection,
    });
    expect(await capture(() => representativeReads(db))).toEqual(REPRESENTATIVE_TABLES);
  });
});
