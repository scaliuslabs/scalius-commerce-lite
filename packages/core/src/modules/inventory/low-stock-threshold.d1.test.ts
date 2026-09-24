import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkAndAlertLowStock, setLowStockThreshold } from "./alerts";
import { adjustInventory, listInventoryMovements } from "./inventory.service";

describe("SKU alert levels on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active)
      VALUES ('prod_tee', 'Cotton tee', 'cotton-tee', 50000, 1);
      INSERT INTO product_option_definitions (id, product_id, name, normalized_name, position, standard_mapping)
      VALUES ('popt_size', 'prod_tee', 'Size', 'size', 0, 'size'),
             ('popt_color', 'prod_tee', 'Color', 'color', 1, 'color');
      INSERT INTO product_option_values (id, option_definition_id, value, normalized_value, position)
      VALUES ('pval_l', 'popt_size', 'L', 'l', 0), ('pval_white', 'popt_color', 'White', 'white', 0);
      INSERT INTO product_variants (id, product_id, option_combination_key, sku, price_minor, stock, reserved_stock, track_inventory)
      VALUES ('var_l_white', 'prod_tee', 'pval_l|pval_white', 'TEE-L-WHITE', 50000, 5, 2, 1);
      INSERT INTO product_variant_option_values (variant_id, option_definition_id, option_value_id)
      VALUES ('var_l_white', 'popt_size', 'pval_l'), ('var_l_white', 'popt_color', 'pval_white');
    `);
  });

  afterEach(() => sqlite.close());

  const variant = () => sqlite.prepare(`
    SELECT low_stock_threshold AS threshold, stock, stock_version AS stockVersion, version
    FROM product_variants WHERE id = 'var_l_white'
  `).get();
  const alert = () => sqlite.prepare(`
    SELECT alert_status AS status, current_qty AS currentQty, threshold
    FROM product_low_stock_alerts WHERE variant_id = 'var_l_white'
  `).get();
  const movementCount = () => sqlite.prepare("SELECT count(*) AS count FROM inventory_movements").get()?.count;

  it("saves the level, raises the alert at once and never touches stock", async () => {
    await expect(setLowStockThreshold(db, "var_l_white", 5))
      .resolves.toEqual({ variantId: "var_l_white", lowStockThreshold: 5 });

    expect(variant()).toEqual({ threshold: 5, stock: 5, stockVersion: 1, version: 1 });
    expect(alert()).toEqual({ status: "active", currentQty: 3, threshold: 5 });
    expect(movementCount()).toBe(0);
  });

  it("turns the alert off with an empty level", async () => {
    await setLowStockThreshold(db, "var_l_white", 5);
    await setLowStockThreshold(db, "var_l_white", null);

    expect(variant()).toMatchObject({ threshold: null });
    expect(alert()).toMatchObject({ status: "resolved" });
  });

  it.each([-1, 1.5, 1_000_001, Number.NaN])("rejects %s as a field error and writes nothing", async (level) => {
    await expect(setLowStockThreshold(db, "var_l_white", level)).rejects.toMatchObject({
      status: 400,
      details: { field: "lowStockThreshold" },
    });
    expect(variant()).toMatchObject({ threshold: null });
    expect(alert()).toBeUndefined();
  });

  it("refuses untracked SKUs and products in trash", async () => {
    sqlite.exec("UPDATE product_variants SET track_inventory = 0");
    await expect(setLowStockThreshold(db, "var_l_white", 5)).rejects.toMatchObject({ status: 404 });

    sqlite.exec("UPDATE product_variants SET track_inventory = 1; UPDATE products SET deleted_at = unixepoch()");
    await expect(setLowStockThreshold(db, "var_l_white", 5)).rejects.toMatchObject({ status: 404 });
    expect(variant()).toMatchObject({ threshold: null });
  });

  it("flags a sold-out SKU for review without an alert level and clears it after restock", async () => {
    sqlite.exec("UPDATE product_variants SET stock = 2, reserved_stock = 2");
    await checkAndAlertLowStock(db, "var_l_white");
    expect(alert()).toEqual({ status: "active", currentQty: 0, threshold: 0 });

    sqlite.exec("UPDATE product_variants SET stock = 6");
    await checkAndAlertLowStock(db, "var_l_white");
    expect(alert()).toMatchObject({ status: "resolved", currentQty: 4 });
  });

  it("shows the variant's option values on its history rows", async () => {
    await adjustInventory(db, "var_l_white", {
      operationKey: "invop_threshold_test_0001",
      delta: 3,
      reason: "received",
    });

    const { movements } = await listInventoryMovements(db, { limit: 10 });
    expect(movements).toEqual([
      expect.objectContaining({ variantSku: "TEE-L-WHITE", optionLabel: "L / White", productName: "Cotton tee" }),
    ]);
  });
});
