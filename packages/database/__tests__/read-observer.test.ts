import { eq, inArray, sql } from "drizzle-orm";
import { SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { safeBatch } from "../src/batch-helper";
import { getDb } from "../src/client";
import { createPostgresDatabase, type PostgresHttpConnection } from "../src/postgres-adapter";
import {
  currentReadObserver,
  observeStatement,
  pinnedSourceValues,
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

describe("read observer", { timeout: 30_000 }, () => {
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

describe("capture on every provider", { timeout: 30_000 }, () => {
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

describe("bound statements of row-keyed tables", { timeout: 30_000 }, () => {
  /** The settings documents each settings statement of a run pinned (category x key). */
  async function settingsDocuments(run: () => Promise<unknown>): Promise<string[][]> {
    const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
    const observer: ReadObserver = {
      observeTables: () => undefined,
      valueTables: new Set(["settings"]),
      observeBoundStatement: (_tables, sql, params) => statements.push({ sql, params }),
    };
    await runWithReadObserver(observer, run);
    return statements.map(({ sql, params }) => pinnedSourceValues(sql, params, "settings", ["category", "key"])
      .flatMap((pinned) => (pinned.category ?? ["?"]).flatMap((category) => (pinned.key ?? ["?"]).map((key) => `${category}:${key}`)))
      .sort());
  }

  const read = (db: Database) => async () => {
    await db.select({ key: settings.key }).from(settings)
      .where(sql`${settings.key} = 'document' AND ${settings.category} IN (${"seo"}, ${"it's"})`).all();
    await db.select({ id: products.id }).from(products).where(eq(products.slug, "not-reported")).all();
  };
  const expected = [["it's:document", "seo:document"]];

  it("D1 (bound after prepare), with and without a request session", async () => {
    const sqlite = createMigratedSqlite();
    expect(await settingsDocuments(read(getDb({ DB: createSqliteD1Binding(sqlite) })))).toEqual(expected);
    const binding = createSqliteD1Binding(sqlite);
    const session = getDb({ DB: Object.assign(Object.create(binding) as D1Database, { withSession: () => binding }) });
    expect(await settingsDocuments(read(session))).toEqual(expected);
    expect(await settingsDocuments(read(createSqliteD1Database().db))).toEqual(expected);
  });

  it("Turso and PostgreSQL (bound with the statement)", async () => {
    expect(await settingsDocuments(read(createSqliteTursoDatabase(createMigratedSqlite({ provider: "turso" }))))).toEqual(expected);
    const connection: PostgresHttpConnection = {
      query: () => Promise.resolve({ rows: [], fields: [] }),
      transaction: async (queries) => Promise.all(queries),
    };
    const postgres = createPostgresDatabase("postgresql://user:secret@example.neon.tech/db", { connect: () => connection });
    expect(await settingsDocuments(read(postgres))).toEqual(expected);
  });

  it("reports no statement of another table", async () => {
    const { db } = createSqliteD1Database();
    expect(await settingsDocuments(() => db.select({ id: products.id }).from(products).all())).toEqual([]);
  });
});

describe("pinned source values", () => {
  const pin = (sql: string, params: unknown[] = []) => pinnedSourceValues(sql, params, "settings", ["category", "key"]);

  it("reads = and IN pins of each settings source against literals and bound values", () => {
    expect(pin(`select * from "settings" where ("settings"."key" = ? and "settings"."category" in (?, ?))`, ["document", "seo", "currency"]))
      .toEqual([{ category: ["seo", "currency"], key: ["document"] }]);
    expect(pin("select * from settings s where s.category = 'inventory' and s.key = 'document'"))
      .toEqual([{ category: ["inventory"], key: ["document"] }]);
  });

  it("scopes each source to its own query level and skips other tables' columns", () => {
    const sql = `select p.id, (select value from settings where category = 'currency' and key = 'document') as c
      from products p where p.category = ? and p.key = ? and p.slug in (?, ?)`;
    expect(pin(sql, ["x", "y", "a", "b"])).toEqual([{ category: ["currency"], key: ["document"] }]);
    // Placeholders inside literals and comments are not placeholders.
    expect(pin(`select '?' as q /* ? */, value from settings where category = ? and key = 'document'`, ["seo"]))
      .toEqual([{ category: ["seo"], key: ["document"] }]);
  });

  it("leaves a column unpinned when it is not compared with a value", () => {
    expect(pin("select * from settings")).toEqual([{ category: null, key: null }]);
    expect(pin("select * from products p join settings s on s.category = p.slug where s.key = 'document'"))
      .toEqual([{ category: null, key: ["document"] }]);
    expect(pin("select * from settings where category = ? and key = 'document'", [null])).toEqual([{ category: null, key: ["document"] }]);
    expect(pin("select * from products")).toEqual([]);
  });
});
