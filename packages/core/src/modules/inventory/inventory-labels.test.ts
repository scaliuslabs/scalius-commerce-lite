import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
  calculateInventoryLabelEffectivePriceMinor,
  getInventoryLabelVariants,
  INVENTORY_LABEL_VARIANT_LIMIT,
} from "./inventory.service";

describe("inventory barcode label projection", () => {
  it("reads requested SKUs in one bounded lookup, in request order, without mutating stock", async () => {
    const bindCounts: number[] = [];
    const { sqlite, db } = createSqliteD1Database({
      onQuery: (_query, values) => bindCounts.push(values.length),
    });
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, discount_type, discount_bps)
      VALUES ('p1', 'Shirt', 'shirt', 100000, 'percentage', 1000), ('p2', 'Cap', 'cap', 50000, NULL, 0);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, barcode, barcode_type)
      VALUES ('v1', 'p1', 'SHIRT', 100000, 7, 2, 1, '4006381333931', 'ean13'),
             ('v2', 'p2', 'CAP', 50000, 3, 0, 1, NULL, NULL);
    `);
    const before = sqlite.prepare("SELECT id, stock, reserved_stock, stock_version FROM product_variants ORDER BY id").all();
    const padding = Array.from({ length: INVENTORY_LABEL_VARIANT_LIMIT - 3 }, (_, index) => `absent_${index}`);

    const result = await getInventoryLabelVariants(db, ["v2", "gone", "v1", ...padding]);

    expect(result.variants.map((variant) => variant.id)).toEqual(["v2", "v1"]);
    expect(result.missingVariantIds.slice(0, 2)).toEqual(["gone", "absent_0"]);
    expect(result.variants[1]).toMatchObject({
      sku: "SHIRT", barcode: "4006381333931", barcodeType: "ean13", stock: 7, reservedStock: 2, price: 1000, effectivePrice: 900,
    });
    expect(result.variants[1]).not.toHaveProperty("productDiscountType");
    expect(Math.max(...bindCounts)).toBeLessThan(10);
    expect(sqlite.prepare("SELECT id, stock, reserved_stock, stock_version FROM product_variants ORDER BY id").all())
      .toEqual(before);
    await expect(getInventoryLabelVariants(db, [...padding, "a", "b", "c", "d"])).rejects.toThrow(/at most/);
  });

  it("projects the buyer-effective automatic catalog price in minor units", () => {
    const base = {
      priceMinor: 100_000,
      variantDiscountType: null,
      variantDiscountBps: 0,
      variantDiscountAmountMinor: 0,
      productDiscountType: "percentage",
      productDiscountBps: 1_000,
      productDiscountAmountMinor: 0,
    };
    expect(calculateInventoryLabelEffectivePriceMinor(base)).toBe(90_000);
    expect(calculateInventoryLabelEffectivePriceMinor({
      ...base,
      variantDiscountType: "flat",
      variantDiscountAmountMinor: 25_000,
    })).toBe(75_000);
    expect(calculateInventoryLabelEffectivePriceMinor({
      ...base,
      variantDiscountType: "percentage",
      variantDiscountBps: 0,
    })).toBe(90_000);
  });
});
