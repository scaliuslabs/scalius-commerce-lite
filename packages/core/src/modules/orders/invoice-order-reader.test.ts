import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { readInvoiceOrderSource } from "./invoice-order-reader";

describe("invoice order projection", () => {
  it("uses the immutable order-line labels even after the live catalog changes", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price) VALUES ('product_1', 'Original', 'original', 100);
      INSERT INTO product_variants (id, product_id, sku, price, is_default) VALUES ('variant_1', 'product_1', 'SKU-1', 100, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount, shipping_charge,
        shipping_method_name, shipping_fee_waived)
        VALUES ('order_1', 'Buyer', '+8801700000000', 'Address', 'city', 'zone', 160, 60, 'Express', 1);
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, price, product_name, variant_label)
        VALUES ('item_1', 'order_1', 'product_1', 'variant_1', 1, 100, 'Original', 'Red / L');
      UPDATE products SET name = 'Renamed';
      UPDATE product_variants SET sku = 'SKU-CHANGED';
    `);

    const source = await readInvoiceOrderSource(db, "order_1");

    expect(source).toMatchObject({ id: "order_1", shippingMethodName: "Express", shippingFeeWaived: true });
    expect(source?.items).toEqual([expect.objectContaining({ productName: "Original", variantLabel: "Red / L" })]);
    await expect(readInvoiceOrderSource(db, "missing")).resolves.toBeNull();
  });
});
