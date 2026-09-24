// Integer money end to end on the real migrated schema, for D1 and TursoDB:
// every stored amount is exact minor units, totals are the sum of their parts,
// and the HTTP contract sees decimals converted once.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import {
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import { recordCODCollection } from "../payments/cod";
import { processPaymentConfirmed } from "../payments/process-payment";
import { processRefund } from "../payments/refund-service";
import { getStorefrontFeedProducts } from "../catalog/feed";
import { getStorefrontProducts } from "../catalog/listing";
import { presentStorefrontCartValidation, validateStorefrontCartItems } from "../checkout/cart-validation";
import { createOrder } from "./admin/create";
import { quoteManualOrder } from "./admin/quote";

type Provider = "d1" | "turso";
type Row = Record<string, number | string | null>;

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function open(provider: Provider): Database {
  sqlite = createMigratedSqlite({ provider });
  return provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
}

function all(sql: string, ...params: string[]): Row[] {
  return sqlite!.prepare(sql).all(...params) as Row[];
}

function get(sql: string, ...params: string[]): Row {
  return sqlite!.prepare(sql).get(...params) as Row;
}

/** A 9.99 product at 12.5% off (৳9 each: BDT cash rounding), 10% zone tax on merchandise only. */
function seedCatalog(pricesIncludeTax: boolean): void {
  sqlite!.exec(`
    INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
    VALUES ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1), ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1);
    INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
    INSERT OR REPLACE INTO tax_settings
      (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
    VALUES ('default', 1, ${pricesIncludeTax ? 1 : 0}, 0, 'tax_standard', 'VAT', 1);
    INSERT INTO tax_rates
      (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, is_active)
    VALUES ('tax_north', 'tax_standard', 'North VAT', 1000, 'zone', 'zone_1', 'North', 1);
    INSERT INTO products (id, name, slug, price_minor, discount_type, discount_bps, is_active)
    VALUES ('tee', 'Tee', 'tee', 999, 'percentage', 1250, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
    VALUES ('tee_sku', 'tee', 'TEE-1', 999, 10, 1, 0);
  `);
}

function manualOrder(overrides: Record<string, unknown> = {}) {
  return {
    requestKey: crypto.randomUUID(),
    customerName: "Buyer",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "Road 1, Dhaka",
    city: "city_1",
    zone: "zone_1",
    area: null,
    notes: null,
    items: [{ productId: "tee", variantId: "tee_sku", quantity: 3 }],
    discountAmount: 1,
    shippingCharge: 60,
    ...overrides,
  };
}

function insertOrder(id: string, totalMinor: number, paymentMethod: string, status = "pending"): void {
  sqlite!.prepare(`
    INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, payment_method, status,
      subtotal_amount_minor, total_amount_minor, balance_due_minor)
    VALUES (?, 'Buyer', '+8801712345678', 'Road 1', 'city_1', 'zone_1', ?, ?, ?, ?, ?)
  `).run(id, paymentMethod, status, totalMinor, totalMinor, totalMinor);
}

describe.each(["d1", "turso"] as const)("integer money (%s)", (provider) => {
  it("prices a discounted, shipped, tax-exclusive order as the exact sum of its parts", async () => {
    const db = open(provider);
    seedCatalog(false);

    // 999 × 0.875 = 874.125 paisa rounds half-up to whole taka (900); 3 × 900 = 2700;
    // taxable 2700 − 100 = 2600; VAT 260 rounds to whole taka (300). Merchant-entered
    // amounts are whole taka: a delivery charge with paisa is refused.
    await expect(quoteManualOrder(db, manualOrder())).resolves.toMatchObject({
      subtotalAmount: 27,
      shippingAmount: 60,
      discountAmount: 1,
      taxAmount: 3,
      totalAmount: 89,
    });
    await expect(createOrder(db, manualOrder({ shippingCharge: 60.1 }), "admin_1"))
      .rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
    await expect(createOrder(db, manualOrder({ discountAmount: 0.5 }), "admin_1"))
      .rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
    const created = await createOrder(db, manualOrder(), "admin_1");

    const order = get(`
      SELECT subtotal_amount_minor, shipping_amount_minor, discount_amount_minor, tax_amount_minor,
        total_amount_minor, paid_amount_minor, balance_due_minor
      FROM orders WHERE id = ?`, created.id);
    expect(order).toEqual({
      subtotal_amount_minor: 2700,
      shipping_amount_minor: 6000,
      discount_amount_minor: 100,
      tax_amount_minor: 300,
      total_amount_minor: 8900,
      paid_amount_minor: 0,
      balance_due_minor: 8900,
    });
    expect(Number(order.subtotal_amount_minor) + Number(order.shipping_amount_minor)
      - Number(order.discount_amount_minor) + Number(order.tax_amount_minor)).toBe(order.total_amount_minor);
    expect(all(`
      SELECT unit_price_minor, quantity, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor
      FROM order_items WHERE order_id = ?`, created.id)).toEqual([{
      unit_price_minor: 900,
      quantity: 3,
      line_subtotal_minor: 2700,
      discount_amount_minor: 100,
      taxable_amount_minor: 2600,
      tax_amount_minor: 300,
    }]);
  });

  it("keeps inclusive tax inside the total", async () => {
    const db = open(provider);
    seedCatalog(true);

    // Gross 2600 already contains VAT: 2600 × 1000 / 11000 = 236.36 paisa, shown as whole taka (200).
    const quote = await quoteManualOrder(db, manualOrder());
    expect(quote).toMatchObject({ subtotalAmount: 27, taxAmount: 2, totalAmount: 86 });
  });

  it("settles a deposit then the balance to exactly the order total", async () => {
    const db = open(provider);
    insertOrder("order_plan", 10_030, "stripe", "incomplete");
    sqlite!.exec(`INSERT INTO payment_plans (id, order_id, total_amount_minor, deposit_amount_minor, balance_due_minor, status)
      VALUES ('plan', 'order_plan', 10030, 2507, 7523, 'pending')`);
    const pay = (paymentType: "deposit" | "balance", amountMinor: number, providerRef: string) =>
      processPaymentConfirmed(db, { orderId: "order_plan", provider: "stripe", amountMinor, currency: "BDT", paymentType, providerRef });

    await expect(pay("deposit", 2507, "pi_deposit")).resolves.toMatchObject({ success: true, paymentType: "deposit" });
    expect(get("SELECT payment_status, paid_amount_minor, balance_due_minor FROM orders"))
      .toEqual({ payment_status: "partial", paid_amount_minor: 2507, balance_due_minor: 7523 });
    await expect(pay("balance", 7522, "pi_short")).resolves.toMatchObject({ success: false });
    await expect(pay("balance", 7523, "pi_balance")).resolves.toMatchObject({ success: true, paymentType: "balance" });

    expect(get("SELECT payment_status, paid_amount_minor, balance_due_minor FROM orders"))
      .toEqual({ payment_status: "paid", paid_amount_minor: 10_030, balance_due_minor: 0 });
    expect(get("SELECT status FROM payment_plans")).toEqual({ status: "completed" });
    expect(get("SELECT sum(amount_minor) AS paid FROM order_payments WHERE status = 'succeeded'")).toEqual({ paid: 10_030 });
  });

  it("collects COD once, then records a partial manual refund in exact minor units", async () => {
    const db = open(provider);
    insertOrder("order_cod", 10_000, "cod", "delivered");
    sqlite!.exec("INSERT INTO cod_tracking (id, order_id, cod_status) VALUES ('cod', 'order_cod', 'pending')");

    await expect(recordCODCollection(db, { orderId: "order_cod", collectedBy: "Courier", collectedAmountMinor: 9_999 }))
      .rejects.toThrow("Record the full cash balance of ৳100.");
    await recordCODCollection(db, { orderId: "order_cod", collectedBy: "Courier", collectedAmountMinor: 10_000 });
    await recordCODCollection(db, { orderId: "order_cod", collectedBy: "Courier", collectedAmountMinor: 10_000 });
    expect(get("SELECT payment_status, paid_amount_minor, balance_due_minor FROM orders"))
      .toEqual({ payment_status: "paid", paid_amount_minor: 10_000, balance_due_minor: 0 });
    expect(get("SELECT cod_status, collected_amount_minor FROM cod_tracking"))
      .toEqual({ cod_status: "collected", collected_amount_minor: 10_000 });
    expect(get("SELECT count(*) AS n, sum(amount_minor) AS total FROM order_payments")).toEqual({ n: 1, total: 10_000 });

    // A taka refund is whole taka: 40.5 is refused, 40 is converted once to 4000 paisa.
    await expect(processRefund(db, { orderId: "order_cod", amount: 40.5, reason: "damaged", manualSettlementConfirmed: true }))
      .rejects.toMatchObject({ status: 400, message: "Taka amounts are whole numbers." });
    await expect(processRefund(db, { orderId: "order_cod", amount: 40, reason: "damaged", manualSettlementConfirmed: true }))
      .resolves.toMatchObject({ success: true, amount: 40, isFullRefund: false });
    expect(get("SELECT status, payment_status, paid_amount_minor, balance_due_minor FROM orders"))
      .toEqual({ status: "delivered", payment_status: "partially_refunded", paid_amount_minor: 6_000, balance_due_minor: 0 });
    expect(get("SELECT amount_minor FROM order_payments WHERE payment_type = 'refund'")).toEqual({ amount_minor: 4_000 });
  });

  it("derives feed and cart prices from minor units without float drift", async () => {
    const db = open(provider);
    sqlite!.exec(`
      INSERT INTO media (id, filename, kind, object_key, size, mime_type, alt_text, status)
      VALUES ('img', 'tee.jpg', 'image', 'products/tee.jpg', 1, 'image/jpeg', 'Tee', 'ready');
      INSERT INTO products (id, name, slug, price_minor, discount_type, discount_bps, is_active)
      VALUES ('tee', 'Tee', 'tee', 999, 'percentage', 1250, 1), ('cap', 'Cap', 'cap', 10, NULL, 0, 1),
        ('pin', 'Pin', 'pin', 25, 'flat', 0, 1);
      INSERT INTO product_media (id, product_id, media_id, alt_text, is_primary, sort_order)
      VALUES ('pmed_tee_primary', 'tee', 'img', 'Tee', 1, 0);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
      VALUES ('tee_sku', 'tee', 'TEE-1', 999, 5, 1, 1), ('cap_sku', 'cap', 'CAP-1', 10, 5, 1, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, discount_type, discount_amount_minor, stock, is_default, track_inventory)
      VALUES ('pin_sku', 'pin', 'PIN-1', 25, 'flat', 5, 5, 1, 1);
    `);

    const feed = await getStorefrontFeedProducts(db, { limit: 10 });
    expect(feed.products.map((product) => ({ id: product.id, price: product.price, sale: product.discountedPrice })))
      .toEqual([{ id: "tee", price: 9.99, sale: 9 }]);
    expect(feed.products[0]!.variants[0]).toMatchObject({ price: 9.99 });

    // 0.1 + 0.2: SKUs at 10 and 25 − 5 paisa total exactly 30, presented as 0.3.
    const cart = await validateStorefrontCartItems(db, [
      { productId: "cap", variantId: "cap_sku", quantity: 1, price: 0.1, productName: "Cap", variantLabel: null },
      { productId: "pin", variantId: "pin_sku", quantity: 1, price: 0.2, productName: "Pin", variantLabel: null },
    ]);
    expect(cart.valid).toBe(true);
    expect(cart.subtotalMinor).toBe(30);
    expect(presentStorefrontCartValidation(cart, 2).subtotal).toBe(0.3);

    // Decimal price filters resolve against the saved store currency inside the query,
    // including BDT whole-taka cash rounding of percentage prices (8.74 → 9).
    const listed = async (minPrice: number, maxPrice: number) =>
      (await getStorefrontProducts(db, { minPrice, maxPrice })).products.map((product) => product.id);
    await expect(listed(8.99, 9)).resolves.toEqual(["tee"]);
    await expect(listed(8.7, 8.75)).resolves.toEqual([]);
    sqlite!.exec(`INSERT INTO settings (id, key, value, type, category)
      VALUES ('currency_doc', 'document', '{"currencyCode":"KWD"}', 'json', 'currency')`);
    await expect(listed(0.87, 0.875)).resolves.toEqual(["tee"]);
    await expect(getStorefrontProducts(db, { minPrice: 0.87, maxPrice: 0.875 }))
      .resolves.toMatchObject({ products: [{ id: "tee", discountedPrice: 0.874 }] });
  });
});
