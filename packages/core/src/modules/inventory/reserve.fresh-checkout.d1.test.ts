import type { DatabaseSync } from "node:sqlite";

import { safeBatch } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, describe, expect, it } from "vitest";

import {
  isInventoryReservationConflictError,
  prepareStockReservationBatch,
} from "./reserve";

function createFixture(stock: number) {
  const fixture = createSqliteD1Database({ foreignKeys: true });
  fixture.sqlite.exec(`
    INSERT INTO products (id, name, slug, price, is_active)
    VALUES ('product_hot', 'Hot product', 'product-hot', 100, 1);
    INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, preorder_stock, track_inventory, stock_version, is_default)
    VALUES ('variant_hot', 'product_hot', 'HOT-1', 100, ${stock}, 0, 0, 1, 1, 1);
  `);
  return fixture;
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
    for (const plan of plans) {
      await safeBatch(fixture.db, plan.statements);
    }

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
