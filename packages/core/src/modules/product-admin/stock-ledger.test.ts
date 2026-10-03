import type { DatabaseSync } from "node:sqlite";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { ConflictError } from "@scalius/core/errors";
import { updateVariant } from "./variants";

const variantInput = {
  selectedOptionValueIds: [],
  imageId: null,
  weight: null,
  sku: "SKU-001",
  price: 120,
  trackInventory: true,
  barcode: null,
  barcodeType: null,
  discountType: "percentage" as const,
  discountPercentage: null,
  discountAmount: null,
};

function setup() {
  let pending: ((sqlite: DatabaseSync) => void) | undefined;
  const harness = createSqliteD1Database({
    beforeBatch(sqlite) {
      const apply = pending;
      pending = undefined;
      apply?.(sqlite);
    },
  });
  harness.sqlite.exec(`
    INSERT INTO products (id, name, price_minor, slug) VALUES ('product_1', 'Mug', 12000, 'mug');
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory, stock_version, low_stock_threshold)
    VALUES ('variant_1', 'product_1', 'SKU-001', 12000, 5, 0, 1, 1, 3, 6);
    INSERT INTO product_low_stock_alerts (id, variant_id, product_id, current_qty, threshold) VALUES ('alert_1', 'variant_1', 'product_1', 5, 6);
  `);
  const state = () => harness.sqlite.prepare(`
    SELECT v.stock, v.stock_version AS stockVersion, a.alert_status AS alertStatus,
      (SELECT count(*) FROM inventory_movements WHERE variant_id = v.id) AS movements
    FROM product_variants v JOIN product_low_stock_alerts a ON a.variant_id = v.id WHERE v.id = 'variant_1'
  `).get();
  return { ...harness, state, raceNextBatch: (race: (sqlite: DatabaseSync) => void) => { pending = race; } };
}

describe("product variant stock ledger routing", () => {
  it("commits a single-SKU stock edit with its movement claim and reconciles the low-stock alert", async () => {
    const { db, state } = setup();

    const result = await updateVariant(db, "product_1", "variant_1", { ...variantInput, stock: 12, expectedStockVersion: 3, expectedAggregateRevision: 1 }, "admin_1");

    expect(result.stock).toBe(12);
    expect(state()).toEqual({ stock: 12, stockVersion: 4, alertStatus: "resolved", movements: 1 });

    await updateVariant(db, "product_1", "variant_1", { ...variantInput, stock: 2, expectedStockVersion: 4, expectedAggregateRevision: 2 }, "admin_1");
    expect(state()).toEqual({ stock: 2, stockVersion: 5, alertStatus: "active", movements: 2 });
  });

  it("writes neither stock nor movement when a concurrent stock change wins", async () => {
    const { db, state, raceNextBatch } = setup();
    raceNextBatch((sqlite) => sqlite.exec("UPDATE product_variants SET stock = 4, stock_version = 4 WHERE id = 'variant_1'"));

    await expect(updateVariant(db, "product_1", "variant_1", { ...variantInput, stock: 12, expectedStockVersion: 3, expectedAggregateRevision: 1 }))
      .rejects.toBeInstanceOf(ConflictError);
    expect(state()).toMatchObject({ stock: 4, stockVersion: 4, movements: 0 });
  });
});
