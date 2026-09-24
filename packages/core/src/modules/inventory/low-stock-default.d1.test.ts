import type { DatabaseSync } from "node:sqlite";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getStorefrontProductBySlug } from "../products/products.storefront";
import { acknowledgeLowStockAlert, checkAndAlertLowStock, setDefaultLowStockThreshold, setLowStockThreshold } from "./alerts";
import { getInventoryOverview } from "./inventory.service";

describe("store-wide default alert level", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active)
      VALUES ('prod_tee', 'Cotton tee', 'cotton-tee', 50000, 1),
             ('prod_mug', 'Clay mug', 'clay-mug', 30000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, track_inventory, is_default)
      VALUES ('var_tee', 'prod_tee', 'TEE', 50000, 4, 1, 1, 1),
             ('var_mug', 'prod_mug', 'MUG', 30000, 20, 0, 1, 1);
    `);
  });

  afterEach(() => sqlite.close());

  type Overview = {
    variants?: Array<{ sku: string }>;
    alerts?: Array<{ variantSku: string | null; alertStatus: string; currentQty: number; threshold: number }>;
    stats?: { lowStockCount: number };
    defaultLowStockThreshold?: number | null;
  };
  const overview = async (section: "variants" | "alerts", extra: Partial<Parameters<typeof getInventoryOverview>[1]> = {}) =>
    await getInventoryOverview(db, { section, search: "", status: "all", page: 1, limit: 50, ...extra }) as Overview;
  const lowSkus = async () => (await overview("variants", { status: "low" })).variants?.map((variant) => variant.sku);
  const review = async (alertStatus = "active") =>
    (await overview("alerts", { alertStatus })).alerts?.map((alert) => [alert.variantSku, alert.alertStatus, alert.currentQty, alert.threshold]);
  const band = async (slug: string) => (await getStorefrontProductBySlug(db, slug))?.variants?.[0]?.availabilityBand;

  it("applies to SKUs without their own level; a SKU level wins and 0 turns it off", async () => {
    expect(await lowSkus()).toEqual([]);
    expect(await review()).toEqual([]);

    await expect(setDefaultLowStockThreshold(db, 5)).resolves.toEqual({ defaultLowStockThreshold: 5 });
    expect((await overview("variants")).defaultLowStockThreshold).toBe(5);
    expect(await lowSkus()).toEqual(["TEE"]);
    expect((await overview("variants")).stats?.lowStockCount).toBe(1);
    expect(await review()).toEqual([["TEE", "active", 3, 5]]);

    await setLowStockThreshold(db, "var_tee", 0);
    expect(await lowSkus()).toEqual([]);
    expect(await review()).toEqual([]);

    await setLowStockThreshold(db, "var_mug", 25);
    expect(await lowSkus()).toEqual(["MUG"]);
  });

  it("drives the buyer availability band", async () => {
    expect(await band("cotton-tee")).toBe("in_stock");
    await setDefaultLowStockThreshold(db, 5);
    expect(await band("cotton-tee")).toBe("low_stock");
    await setLowStockThreshold(db, "var_tee", 0);
    expect(await band("cotton-tee")).toBe("in_stock");
  });

  it("lists sold-out tracked SKUs for review with no level and no stored alert", async () => {
    sqlite.exec("UPDATE product_variants SET stock = 1 WHERE id = 'var_tee'");
    expect(await review()).toEqual([["TEE", "active", 0, 0]]);

    sqlite.exec("UPDATE product_variants SET track_inventory = 0 WHERE id = 'var_tee'");
    expect(await review()).toEqual([]);
  });

  it("marks a SKU as seen without a stored alert, and restock resolves it", async () => {
    sqlite.exec("UPDATE product_variants SET stock = 1 WHERE id = 'var_tee'");
    await expect(acknowledgeLowStockAlert(db, "var_tee")).resolves.toBe(true);
    expect(await review()).toEqual([]);
    expect(await review("acknowledged")).toEqual([["TEE", "acknowledged", 0, 0]]);

    await expect(acknowledgeLowStockAlert(db, "var_mug")).resolves.toBe(false);

    sqlite.exec("UPDATE product_variants SET stock = 9 WHERE id = 'var_tee'");
    await checkAndAlertLowStock(db, "var_tee");
    expect(await review("resolved")).toEqual([["TEE", "resolved", 8, 0]]);
    sqlite.exec("UPDATE product_variants SET stock = 1 WHERE id = 'var_tee'");
    expect(await review()).toEqual([["TEE", "active", 0, 0]]);
  });

  it("stores the level in settings and rejects bad values as a field error", async () => {
    await setDefaultLowStockThreshold(db, 3);
    await setDefaultLowStockThreshold(db, null);
    expect((await overview("alerts")).defaultLowStockThreshold).toBeNull();

    for (const level of [-1, 1.5, 1_000_001]) {
      await expect(setDefaultLowStockThreshold(db, level)).rejects.toMatchObject({
        status: 400,
        details: { field: "defaultLowStockThreshold" },
      });
    }
    expect(sqlite.prepare("SELECT value FROM settings WHERE category = 'inventory'").get())
      .toEqual({ value: JSON.stringify({ defaultLowStockThreshold: null }) });
  });
});
