import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { readInvoiceOrderSource } from "./order-reader";
import { snapshotInvoiceOrder } from "./snapshot";

describe("invoice order projection", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
  });
  afterEach(() => sqlite.close());

  it("uses the immutable order-line labels even after the live catalog changes", async () => {
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor) VALUES ('product_1', 'Original', 'original', 10000);
      INSERT INTO product_variants (id, product_id, sku, price_minor, is_default) VALUES ('variant_1', 'product_1', 'SKU-1', 10000, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor, shipping_amount_minor,
        shipping_method_name, shipping_fee_waived)
        VALUES ('order_1', 'Buyer', '+8801700000000', 'Address', 'city', 'zone', 16000, 6000, 'Express', 1);
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, product_name, variant_label)
        VALUES ('item_1', 'order_1', 'product_1', 'variant_1', 1, 10000, 'Original', 'Red / L');
      UPDATE products SET name = 'Renamed';
      UPDATE product_variants SET sku = 'SKU-CHANGED';
    `);

    const source = await readInvoiceOrderSource(db, "order_1");

    expect(source).toMatchObject({ id: "order_1", shippingMethodName: "Express", shippingFeeWaived: true });
    expect(source?.items).toEqual([expect.objectContaining({ productName: "Original", variantLabel: "Red / L" })]);
    await expect(readInvoiceOrderSource(db, "missing")).resolves.toBeNull();
  });

  it("snapshots the frozen buyer inputs of each line for the invoice", async () => {
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor) VALUES ('product_1', 'Pen', 'pen', 10000);
      INSERT INTO product_variants (id, product_id, sku, price_minor, is_default) VALUES ('variant_1', 'product_1', 'PEN-1', 10000, 1);
      INSERT INTO orders (id, customer_name, customer_phone, total_amount_minor, shipping_amount_minor, requires_shipping)
        VALUES ('order_1', 'Buyer', '+8801700000000', 12000, 0, 0);
    `);
    sqlite.prepare(`
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, product_name,
        properties, properties_price_minor, base_unit_price_minor)
      VALUES ('item_1', 'order_1', 'product_1', 'variant_1', 1, 12000, 'Pen', ?, 2000, 10000)
    `).run(JSON.stringify([
      { key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", priceMinor: 2000 },
    ]));

    const source = await readInvoiceOrderSource(db, "order_1");
    const snapshot = snapshotInvoiceOrder(source!);

    expect(snapshot.items[0]?.properties).toEqual([{ label: "Engraving", displayValue: "Anika", priceMinor: 2000 }]);
  });

  it("leaves lines without buyer inputs in the version-1 shape", () => {
    const snapshot = snapshotInvoiceOrder({
      ...baseOrder(),
      items: [{ ...baseItem(), properties: [] }],
    });
    expect(snapshot.items[0]).not.toHaveProperty("properties");
  });
});

function baseItem() {
  return {
    id: "item_1", productId: "product_1", variantId: "variant_1", quantity: 1, price: 100,
    productName: "Pen", variantLabel: null, unitPriceMinor: 10_000,
    lineSubtotalMinor: 10_000, discountAmountMinor: 0, taxableAmountMinor: 0, taxAmountMinor: 0,
  };
}

function baseOrder(): Parameters<typeof snapshotInvoiceOrder>[0] {
  return {
    id: "order_1", version: 1, customerName: "Buyer", customerPhone: "+8801700000000", customerEmail: null,
    customerId: null, shippingAddress: null, city: null, zone: null, area: null, cityName: null, zoneName: null,
    areaName: null, totalAmount: 100, shippingCharge: 0, discountAmount: 0, currencyCode: "BDT",
    currencyDecimalPlaces: 2, subtotalAmountMinor: 10_000, shippingAmountMinor: 0, shippingMethodId: null,
    shippingMethodName: null, shippingMethodDescription: null, shippingMethodBaseAmountMinor: null,
    shippingFeeWaived: null, discountAmountMinor: 0, taxAmountMinor: 0, totalAmountMinor: 10_000, taxLabel: null,
    pricesIncludeTax: false, status: "pending", paymentStatus: "unpaid", paymentMethod: "cod",
    fulfillmentStatus: "pending", paidAmount: 0, balanceDue: 100, createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000, items: [],
  };
}
