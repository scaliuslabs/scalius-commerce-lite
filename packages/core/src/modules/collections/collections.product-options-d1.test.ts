import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { describe, expect, it } from "vitest";
import { listCollectionProductOptions } from "./collections.service";

function setup() {
  const harness = createSqliteD1Database();
  harness.sqlite.exec(`
    INSERT INTO categories (id, name, slug, status) VALUES ('cat_a', 'Panjabi', 'panjabi', 'published');
    INSERT INTO products (id, name, price_minor, slug, category_id, is_active, created_at) VALUES
      ('prod_old', 'Attar', 30000, 'attar', NULL, 1, 1700000000),
      ('prod_new', 'Cotton panjabi', 250000, 'cotton-panjabi', 'cat_a', 1, 1700000500),
      ('prod_open', 'Tupi', 25000, 'tupi', 'cat_a', 0, 1700000100);
    INSERT INTO product_variants (id, product_id, sku, option_combination_key, price_minor, stock, reserved_stock, track_inventory, is_default) VALUES
      ('var_attar', 'prod_old', 'ATTAR', NULL, 30000, 12, 2, 1, 1),
      ('var_m', 'prod_new', 'PANJABI-M', 'm', 250000, 3, 5, 1, 0),
      ('var_l', 'prod_new', 'PANJABI-L', 'l', 250000, 4, 0, 1, 0),
      ('var_tupi', 'prod_open', 'TUPI', NULL, 25000, 0, 0, 0, 1);
  `);
  return harness;
}

describe("collection product picker on D1", () => {
  it("opens on the newest products with price, variant count and sellable stock", async () => {
    const { db } = setup();

    const { products, pagination } = await listCollectionProductOptions(db, { limit: 20 });

    expect(pagination.total).toBe(3);
    expect(products.map(({ id, price, variantCount, available }) => ({ id, price, variantCount, available }))).toEqual([
      // Two optioned SKUs; the oversold M counts as zero, never negative.
      { id: "prod_new", price: 2500, variantCount: 2, available: 4 },
      // Stock is not tracked for the only SKU.
      { id: "prod_open", price: 250, variantCount: 0, available: null },
      // A simple product's hidden SKU is not a variant.
      { id: "prod_old", price: 300, variantCount: 0, available: 10 },
    ]);
  });

  it("limits to the chosen categories", async () => {
    const { db } = setup();

    const { products } = await listCollectionProductOptions(db, { categoryIds: ["cat_a"] });

    expect(products.map((product) => product.id)).toEqual(["prod_new", "prod_open"]);
  });
});
