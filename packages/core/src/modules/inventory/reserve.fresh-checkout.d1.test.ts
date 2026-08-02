import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { safeBatch, type Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, describe, expect, it } from "vitest";

import {
  isInventoryReservationConflictError,
  prepareStockReservationBatch,
} from "./reserve";

const ledgerV2ValidationMigration = readFileSync(
  fileURLToPath(new URL(
    "../../../../database/migrations/0004_validate_inventory_ledger_v2.sql",
    import.meta.url,
  )),
  "utf8",
);

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function resultRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: resultRows(sqlite.prepare(query), values),
    success: true,
    meta: {},
  });

  return {
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = resultRows(sqlite.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function createFixture(stock: number): {
  sqlite: DatabaseSync;
  db: Database;
} {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      slug TEXT,
      category_id TEXT,
      is_active INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE TABLE product_variants (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      stock INTEGER NOT NULL,
      reserved_stock INTEGER NOT NULL DEFAULT 0,
      preorder_stock INTEGER NOT NULL DEFAULT 0,
      track_inventory INTEGER NOT NULL DEFAULT 1,
      stock_version INTEGER NOT NULL DEFAULT 1,
      allow_preorder INTEGER NOT NULL DEFAULT 0,
      allow_backorder INTEGER NOT NULL DEFAULT 0,
      backorder_limit INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      deleted_at INTEGER
    );
    CREATE TABLE inventory_reservation_lanes (
      variant_id TEXT NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
      pool TEXT NOT NULL,
      lane INTEGER NOT NULL,
      capacity INTEGER,
      reserved_quantity INTEGER NOT NULL DEFAULT 0,
      version INTEGER NOT NULL DEFAULT 0,
      source_stock_version INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (variant_id, pool, lane)
    );
    CREATE INDEX inventory_reservation_lanes_pool_idx
      ON inventory_reservation_lanes(pool, variant_id);
    CREATE TABLE inventory_movements (
      id TEXT PRIMARY KEY,
      variant_id TEXT NOT NULL REFERENCES product_variants(id),
      order_id TEXT,
      type TEXT NOT NULL,
      quantity INTEGER NOT NULL,
      previous_stock INTEGER NOT NULL,
      new_stock INTEGER NOT NULL,
      notes TEXT,
      created_by TEXT,
      ledger_version INTEGER NOT NULL DEFAULT 1,
      pool TEXT,
      reservation_generation INTEGER,
      stock_version_before INTEGER,
      stock_version_after INTEGER,
      stock_delta INTEGER,
      previous_reserved_stock INTEGER,
      new_reserved_stock INTEGER,
      reserved_stock_delta INTEGER,
      previous_preorder_stock INTEGER,
      new_preorder_stock INTEGER,
      preorder_stock_delta INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE UNIQUE INDEX inventory_movements_variant_version_uidx
      ON inventory_movements(variant_id, stock_version_after);
  `);
  sqlite.exec(ledgerV2ValidationMigration);
  sqlite.prepare(`
    INSERT INTO products (id, slug, category_id, is_active)
    VALUES ('product_hot', 'product-hot', 'category_hot', 1)
  `).run();
  sqlite.prepare(`
    INSERT INTO product_variants (
      id, product_id, stock, reserved_stock, preorder_stock,
      track_inventory, stock_version
    ) VALUES ('variant_hot', 'product_hot', ?, 0, 0, 1, 1)
  `).run(stock);

  const binding = {
    prepare: (query: string) => createD1Statement(sqlite, query),
    async batch(statements: SqliteD1Statement[]) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return {
    sqlite,
    db: drizzle(binding as unknown as D1Database, { schema }) as unknown as Database,
  };
}

describe("fresh checkout inventory transaction", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("re-evaluates current counters for plans prepared from the same snapshot", async () => {
    const fixture = createFixture(20);
    sqlite = fixture.sqlite;

    const plans = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const orderId = `order_${String(index + 1).padStart(2, "0")}`;
      return prepareStockReservationBatch(
        fixture.db,
        [{ variantId: "variant_hot", quantity: 1, orderId }],
        "regular",
        {
          reservationKey: "checkout-test",
          freshOrderIds: new Set([orderId]),
        },
      );
    }));

    expect(plans.every((plan) => plan.success)).toBe(true);
    const availabilityChanges = [];
    for (const plan of plans) {
      const results = await safeBatch(fixture.db, plan.statements);
      availabilityChanges.push(
        plan.resolveCommittedAvailabilitySubjects?.(results as readonly unknown[]) ?? [],
      );
    }

    expect(availabilityChanges.slice(0, -1).every((subjects) => subjects.length === 0))
      .toBe(true);
    expect(availabilityChanges.at(-1)).toEqual([{
      productId: "product_hot",
      slug: "product-hot",
      categoryId: "category_hot",
    }]);

    expect(sqlite.prepare(`
      SELECT reserved_stock AS reservedStock, stock_version AS stockVersion
      FROM product_variants
      WHERE id = 'variant_hot'
    `).get()).toEqual({ reservedStock: 20, stockVersion: 21 });

    const movements = sqlite.prepare(`
      SELECT
        stock_version_before AS stockVersionBefore,
        stock_version_after AS stockVersionAfter,
        previous_reserved_stock AS previousReservedStock,
        new_reserved_stock AS newReservedStock,
        reserved_stock_delta AS reservedStockDelta
      FROM inventory_movements
      ORDER BY stock_version_after
    `).all();
    expect(movements).toHaveLength(20);
    expect(movements).toEqual(Array.from({ length: 20 }, (_, index) => ({
      stockVersionBefore: index + 1,
      stockVersionAfter: index + 2,
      previousReservedStock: index,
      newReservedStock: index + 1,
      reservedStockDelta: 1,
    })));
  });

  it("rolls back the complete transaction when the current row is exhausted", async () => {
    const fixture = createFixture(1);
    sqlite = fixture.sqlite;
    const firstOrderId = "order_first";
    const exhaustedOrderId = "order_exhausted";
    const [firstPlan, exhaustedPlan] = await Promise.all([
      prepareStockReservationBatch(
        fixture.db,
        [{ variantId: "variant_hot", quantity: 1, orderId: firstOrderId }],
        "regular",
        {
          reservationKey: "checkout-test",
          freshOrderIds: new Set([firstOrderId]),
        },
      ),
      prepareStockReservationBatch(
        fixture.db,
        [{ variantId: "variant_hot", quantity: 1, orderId: exhaustedOrderId }],
        "regular",
        {
          reservationKey: "checkout-test",
          freshOrderIds: new Set([exhaustedOrderId]),
        },
      ),
    ]);

    await safeBatch(fixture.db, firstPlan.statements);
    const rejected = safeBatch(fixture.db, exhaustedPlan.statements);
    await expect(rejected).rejects.toSatisfy(isInventoryReservationConflictError);

    expect(sqlite.prepare(`
      SELECT reserved_stock AS reservedStock, stock_version AS stockVersion
      FROM product_variants
      WHERE id = 'variant_hot'
    `).get()).toEqual({ reservedStock: 1, stockVersion: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get())
      .toEqual({ count: 1 });
  });

  it("converges an exact deterministic replay without reserving twice", async () => {
    const fixture = createFixture(2);
    sqlite = fixture.sqlite;
    const orderId = "order_replay";
    const plan = await prepareStockReservationBatch(
      fixture.db,
      [{ variantId: "variant_hot", quantity: 1, orderId }],
      "regular",
      {
        reservationKey: "checkout-test",
        freshOrderIds: new Set([orderId]),
      },
    );

    await safeBatch(fixture.db, plan.statements);
    let replayError: unknown;
    try {
      await safeBatch(fixture.db, plan.statements);
    } catch (error) {
      replayError = error;
    }
    const replay = await plan.resolveIdempotentReplay(replayError);

    expect(replay).toMatchObject({ success: true });
    expect(sqlite.prepare(`
      SELECT reserved_stock AS reservedStock, stock_version AS stockVersion
      FROM product_variants
      WHERE id = 'variant_hot'
    `).get()).toEqual({ reservedStock: 1, stockVersion: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get())
      .toEqual({ count: 1 });
  });

  it("derives preorder counters and ledger semantics from transaction state", async () => {
    const fixture = createFixture(0);
    sqlite = fixture.sqlite;
    sqlite.prepare(`
      UPDATE product_variants
      SET preorder_stock = 2, allow_preorder = 1
      WHERE id = 'variant_hot'
    `).run();
    const orderIds = ["order_preorder_1", "order_preorder_2"];
    const plans = await Promise.all(orderIds.map((orderId) =>
      prepareStockReservationBatch(
        fixture.db,
        [{ variantId: "variant_hot", quantity: 1, orderId }],
        "preorder",
        {
          reservationKey: "checkout-test",
          freshOrderIds: new Set([orderId]),
        },
      )
    ));

    for (const plan of plans) await safeBatch(fixture.db, plan.statements);

    expect(sqlite.prepare(`
      SELECT
        stock,
        reserved_stock AS reservedStock,
        preorder_stock AS preorderStock,
        stock_version AS stockVersion
      FROM product_variants
      WHERE id = 'variant_hot'
    `).get()).toEqual({
      stock: 0,
      reservedStock: 2,
      preorderStock: 0,
      stockVersion: 3,
    });
    expect(sqlite.prepare(`
      SELECT
        type,
        pool,
        reserved_stock_delta AS reservedStockDelta,
        preorder_stock_delta AS preorderStockDelta
      FROM inventory_movements
      ORDER BY stock_version_after
    `).all()).toEqual([
      {
        type: "preorder_reserved",
        pool: "preorder",
        reservedStockDelta: 1,
        preorderStockDelta: -1,
      },
      {
        type: "preorder_reserved",
        pool: "preorder",
        reservedStockDelta: 1,
        preorderStockDelta: -1,
      },
    ]);
  });

  it("enforces the backorder limit from transaction state", async () => {
    const fixture = createFixture(0);
    sqlite = fixture.sqlite;
    sqlite.prepare(`
      UPDATE product_variants
      SET allow_backorder = 1, backorder_limit = 2
      WHERE id = 'variant_hot'
    `).run();
    const orderIds = ["order_backorder_1", "order_backorder_2", "order_backorder_3"];
    const plans = await Promise.all(orderIds.map((orderId) =>
      prepareStockReservationBatch(
        fixture.db,
        [{ variantId: "variant_hot", quantity: 1, orderId }],
        "backorder",
        {
          reservationKey: "checkout-test",
          freshOrderIds: new Set([orderId]),
        },
      )
    ));

    await safeBatch(fixture.db, plans[0]!.statements);
    await safeBatch(fixture.db, plans[1]!.statements);
    await expect(safeBatch(fixture.db, plans[2]!.statements))
      .rejects.toSatisfy(isInventoryReservationConflictError);

    expect(sqlite.prepare(`
      SELECT
        stock,
        reserved_stock AS reservedStock,
        stock_version AS stockVersion
      FROM product_variants
      WHERE id = 'variant_hot'
    `).get()).toEqual({ stock: 0, reservedStock: 2, stockVersion: 3 });
    expect(sqlite.prepare(`
      SELECT pool, COUNT(*) AS count
      FROM inventory_movements
      GROUP BY pool
    `).get()).toEqual({ pool: "backorder", count: 2 });
  });
});
