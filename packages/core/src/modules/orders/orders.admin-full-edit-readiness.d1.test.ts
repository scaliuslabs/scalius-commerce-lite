import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import {
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import {
  getAdminOrderFullEditReadiness,
  getOrderDetails,
  listOrders,
  updateOrder,
} from "./orders.admin";

const TAX_LOCK = /immutable tax and line snapshots/;
const PAYMENT_LOCK = /Payment or refund evidence/;
const SHIPMENT_LOCK = /Fulfillment or shipment evidence/;
const RETURN_OR_INVOICE_LOCK = /Return or invoice evidence/;

// Each row belongs to order_1 only. The refund's source/refund payments sit on
// order_other so the refund attempt is the sole evidence order_1 carries.
const EVIDENCE: Array<[string, string, RegExp]> = [
  ["a checkout tax snapshot", `
    INSERT INTO order_tax_snapshots (
      order_id, currency_code, decimal_places, display_label, prices_include_tax,
      shipping_taxed, settings_version, calculation_version,
      destination_snapshot, rate_snapshot
    ) VALUES ('order_1', 'BDT', 2, 'Tax', 0, 0, 1,
      'tax-v1', '{}', '{}')`, TAX_LOCK],
  ["a payment row", `
    INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
    VALUES ('pay_1', 'order_1', 100, 'BDT', 'cod', 'full', 'pending')`, PAYMENT_LOCK],
  ["a shipment", `
    INSERT INTO delivery_shipments (id, order_id, provider_type, status)
    VALUES ('shipment_1', 'order_1', 'manual', 'pending')`, SHIPMENT_LOCK],
  ["a refund attempt", `
    INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
    VALUES
      ('pay_source', 'order_other', 100, 'BDT', 'cod', 'full', 'completed'),
      ('pay_refund', 'order_other', -100, 'BDT', 'cod', 'refund', 'pending');
    INSERT INTO refund_attempts (
      id, attempt_key, refund_group_id, order_id, source_payment_id, refund_payment_id,
      gateway, amount_minor, currency, reason, request_hash, provider_idempotency_key, refund_reference
    ) VALUES ('refund_1', 'attempt_1', 'group_1', 'order_1', 'pay_source', 'pay_refund',
      'cod', 100, 'BDT', 'Test refund', 'hash_1', 'provider_key_1', 'reference_1')`, PAYMENT_LOCK],
  ["a return", `
    INSERT INTO order_returns (id, order_id, status, reason, actor_type, actor_id)
    VALUES ('return_1', 'order_1', 'cancelled', 'Test return', 'admin', 'admin_1')`, RETURN_OR_INVOICE_LOCK],
  ["an invoice", `
    INSERT INTO order_invoices (id, order_id, invoice_number, prefix, formatted_number,
      order_version, snapshot, content_hash, render_version, issued_at)
    VALUES ('invoice_1', 'order_1', 1, 'INV', 'INV-1', 1, '{}', '${"a".repeat(64)}', 'v1', unixepoch())`,
  RETURN_OR_INVOICE_LOCK],
];

function insertOrder(sqlite: DatabaseSync, id: string): void {
  sqlite.exec(`
    INSERT INTO orders (
      id, customer_name, customer_phone, shipping_address, city, zone, total_amount_minor,
      shipping_amount_minor, discount_amount_minor, currency_code, currency_decimal_places,
      status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
      fulfillment_status, inventory_pool, inventory_action, version
    ) VALUES (
      '${id}', 'Buyer', '+8801712345678', '123 Test Street, Dhaka', 'city_1', 'zone_1', 26000,
      6000, 0, 'BDT', 2, 'confirmed', 'cod', 'unpaid', 0, 26000,
      'pending', 'regular', 'reserved', 1
    );
    INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor, product_name)
    VALUES ('item_${id}', '${id}', 'product_1', 'variant_1', 2, 10000, 'Test product');
  `);
}

describe.each([
  ["D1", (sqlite: DatabaseSync) => createSqliteD1Database({ sqlite }).db],
  ["TursoDB", (sqlite: DatabaseSync) => createSqliteTursoDatabase(sqlite)],
] as const)("admin full-editor readiness from stored evidence on %s", (provider, open) => {
  let sqlite: DatabaseSync;
  let db: Database;

  beforeEach(() => {
    sqlite = createMigratedSqlite({ provider: provider === "D1" ? "d1" : "turso" });
    db = open(sqlite);
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price_minor, is_active)
      VALUES ('product_1', 'Test product', 'test-product', 10000, 1);
      INSERT INTO product_variants (id, product_id, sku, price_minor, stock, reserved_stock, is_default, track_inventory)
      VALUES ('variant_1', 'product_1', 'EDIT-SKU', 10000, 10, 4, 1, 1);
    `);
    for (const id of ["order_1", "order_2", "order_other"]) insertOrder(sqlite, id);
  });

  afterEach(() => sqlite.close());

  async function readinessViews(orderId: string) {
    const listed = await listOrders(db, { limit: 50 });
    const details = await getOrderDetails(db, orderId);
    return {
      direct: await getAdminOrderFullEditReadiness(db, orderId),
      list: listed.orders.find((order) => order.id === orderId)?.fullEditReadiness,
      detail: details?.fullEditReadiness,
      untouchedSibling: listed.orders.find((order) => order.id === "order_2")?.fullEditReadiness,
    };
  }

  function fullEdit() {
    return updateOrder(db, "order_1", {
      expectedVersion: 1,
      status: "confirmed",
      customerName: "Rewritten Buyer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "456 Rewritten Street, Dhaka",
      city: "city_1",
      zone: "zone_1",
      area: null,
      notes: null,
      items: [{ productId: "product_1", variantId: "variant_1", quantity: 3, price: 100 }],
      discountAmount: null,
      shippingCharge: 60,
    } as never);
  }

  it("reports an untouched manual order as editable in every projection", async () => {
    const allowed = { allowed: true, reason: null };
    await expect(readinessViews("order_1")).resolves.toEqual({
      direct: allowed, list: allowed, detail: allowed, untouchedSibling: allowed,
    });
  });

  it.each(EVIDENCE)("locks an order that has %s and refuses the full editor", async (_evidence, sqlText, reason) => {
    sqlite.exec(sqlText);

    const locked = { allowed: false, reason: expect.stringMatching(reason) };
    await expect(readinessViews("order_1")).resolves.toEqual({
      direct: locked,
      list: locked,
      detail: locked,
      untouchedSibling: { allowed: true, reason: null },
    });

    await expect(fullEdit()).rejects.toThrow(reason);
    expect(sqlite.prepare("SELECT customer_name, version FROM orders WHERE id = 'order_1'").get())
      .toEqual({ customer_name: "Buyer", version: 1 });
    expect(sqlite.prepare("SELECT quantity FROM order_items WHERE order_id = 'order_1'").get())
      .toEqual({ quantity: 2 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants").get())
      .toEqual({ reserved_stock: 4 });
  });
});
