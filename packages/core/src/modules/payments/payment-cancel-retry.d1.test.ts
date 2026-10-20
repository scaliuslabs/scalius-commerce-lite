// A provider cancel followed by a retry and a payment, on real D1 storage
// with real inventory: the order's stock is reserved exactly once throughout,
// and shipping deducts it. A cancel only ends the attempt it names.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { applyInventoryForStatusChange } from "../inventory/inventory-transitions";
import { processPaymentConfirmed, processPaymentFailed } from "./process-payment";

describe("cancel at the provider, retry, pay", () => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    ({ sqlite, db } = createSqliteD1Database());
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active)
      VALUES ('product_1', 'Kurta', 'kurta', 50000, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES ('variant_1', 'product_1', 'KURTA-M', 50000, 10, 0, 0, 1, 1);
      INSERT INTO orders (
        id, order_number, customer_name, customer_phone, shipping_address, city, zone,
        currency_code, currency_decimal_places, subtotal_amount_minor, shipping_amount_minor,
        discount_amount_minor, tax_amount_minor, total_amount_minor, status, payment_method,
        payment_status, paid_amount_minor, balance_due_minor, fulfillment_status,
        inventory_pool, inventory_action, version
      ) VALUES (
        'order_1', 5001, 'Karim', '+8801812345602', 'Village road', 'city_1', 'zone_1',
        'BDT', 2, 100000, 0, 0, 0, 100000, 'incomplete', 'stripe', 'unpaid', 0, 100000,
        'pending', 'regular', 'reserved', 1
      );
      INSERT INTO order_items (
        id, order_id, product_id, variant_id, quantity, product_name, inventory_tracked,
        unit_price_minor, line_subtotal_minor, discount_amount_minor, taxable_amount_minor, tax_amount_minor
      ) VALUES ('item_1', 'order_1', 'product_1', 'variant_1', 2, 'Kurta', 1, 50000, 100000, 0, 0, 0);
      UPDATE product_variants SET reserved_stock = 2 WHERE id = 'variant_1';
    `);
  });

  afterEach(() => sqlite.close());

  const stock = () => sqlite.prepare("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'").get();
  const order = () => sqlite.prepare("SELECT status, payment_status, inventory_action FROM orders WHERE id = 'order_1'").get();

  function openAttempt(providerSessionId: string, createdAt: number) {
    sqlite.prepare(`
      INSERT INTO payment_session_attempts
        (id, attempt_key, order_id, gateway, payment_type, amount_minor, currency, request_hash, status,
         provider_session_id, provider_correlation_id, created_at, updated_at)
      VALUES (?, ?, 'order_1', 'stripe', 'full', 100000, 'BDT', ?, 'created', ?, NULL, ?, ?)
    `).run(`psa_${providerSessionId}`, `key_${providerSessionId}`, `hash_${providerSessionId}`, providerSessionId, createdAt, createdAt);
  }

  const cancel = (providerRef: string) => processPaymentFailed(db, { orderId: "order_1", provider: "stripe", providerRef });
  const pay = (providerRef: string) => processPaymentConfirmed(db, {
    orderId: "order_1",
    provider: "stripe",
    amountMinor: 100000,
    currency: "BDT",
    paymentType: "full",
    providerRef,
  });

  it("keeps the stock reserved exactly once and deducts it at shipping", async () => {
    openAttempt("pi_1", 1_700_000_000);
    await expect(cancel("pi_1")).resolves.toEqual({ applied: true });
    expect(order()).toEqual({ status: "incomplete", payment_status: "failed", inventory_action: "reserved" });
    expect(stock()).toEqual({ stock: 10, reserved_stock: 2 });

    // The buyer retries: a new session. The first intent's late cancel names an old attempt.
    openAttempt("pi_2", 1_700_000_100);
    await expect(cancel("pi_1")).resolves.toEqual({ applied: false });

    await expect(pay("pi_2")).resolves.toEqual({ success: true, paymentType: "full" });
    await expect(pay("pi_2")).resolves.toEqual({ success: true, alreadyProcessed: true });
    // A cancel after the payment changes nothing.
    await expect(cancel("pi_2")).resolves.toEqual({ applied: false });
    expect(order()).toEqual({ status: "pending", payment_status: "paid", inventory_action: "reserved" });
    expect(stock()).toEqual({ stock: 10, reserved_stock: 2 });

    await applyInventoryForStatusChange(db, "order_1", "shipped");
    expect(stock()).toEqual({ stock: 8, reserved_stock: 0 });
  });

  it("reserves again, once, the stock an earlier cancel released from the open order", async () => {
    // What a provider cancel used to do: release the stock, leave the order open.
    await applyInventoryForStatusChange(db, "order_1", "cancelled");
    expect(order()).toMatchObject({ status: "incomplete", inventory_action: "restored" });
    expect(stock()).toEqual({ stock: 10, reserved_stock: 0 });

    await expect(pay("pi_2")).resolves.toEqual({ success: true, paymentType: "full" });
    await expect(pay("pi_2")).resolves.toEqual({ success: true, alreadyProcessed: true });
    expect(order()).toEqual({ status: "pending", payment_status: "paid", inventory_action: "reserved" });
    expect(stock()).toEqual({ stock: 10, reserved_stock: 2 });

    await applyInventoryForStatusChange(db, "order_1", "shipped");
    expect(stock()).toEqual({ stock: 8, reserved_stock: 0 });
  });

  it("records the payment and reports a shortfall when the released units were sold", async () => {
    await applyInventoryForStatusChange(db, "order_1", "cancelled");
    sqlite.exec("UPDATE product_variants SET reserved_stock = 9 WHERE id = 'variant_1'");

    await expect(pay("pi_2")).resolves.toEqual({ success: true, paymentType: "full", inventoryShortfall: true });
    expect(order()).toEqual({ status: "pending", payment_status: "paid", inventory_action: "restored" });
    expect(stock()).toEqual({ stock: 10, reserved_stock: 9 });
  });
});
