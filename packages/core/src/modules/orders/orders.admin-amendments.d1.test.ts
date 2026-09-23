import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import * as ordersAdmin from "./orders.admin";
import {
  confirmManualOrderAmendment,
  getAdminOrderAmendmentReadiness,
  previewManualOrderAmendment,
  updateOrder,
} from "./orders.admin";
import { createOrderSchema } from "./orders.validation";
import type { ConfirmManualOrderAmendmentInput } from "./orders.validation";
import type { PreviewManualOrderAmendmentInput } from "./orders.validation";
import { saveAllowedCountries } from "../settings/site-settings.service";

describe("manual COD order amendments on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let beforeAmendmentBatch: (() => void) | null;

  beforeEach(() => {
    beforeAmendmentBatch = null;
    ({ sqlite, db } = createSqliteD1Database({
      beforeBatch(_sqlite, statements) {
        if (!statements.some((statement) => statement.query.includes('"order_amendments"'))) return;
        const before = beforeAmendmentBatch;
        beforeAmendmentBatch = null;
        before?.();
      },
    }));
    sqlite.exec(`
      INSERT INTO delivery_locations (id, name, type, parent_id, external_ids, metadata, is_active)
      VALUES
        ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1),
        ('zone_1', 'North', 'zone', 'city_1', '{}', '{}', 1),
        ('zone_2', 'South', 'zone', 'city_1', '{}', '{}', 1);
      INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
      INSERT OR REPLACE INTO tax_settings
        (id, enabled, prices_include_tax, tax_shipping, default_tax_class_id, display_label, version)
      VALUES ('default', 1, 0, 0, 'tax_standard', 'Tax', 1);
      INSERT INTO tax_rates
        (id, tax_class_id, name, rate_bps, jurisdiction_type, jurisdiction_id, jurisdiction_label, is_active)
      VALUES ('tax_south', 'tax_standard', 'South tax', 1000, 'zone', 'zone_2', 'South', 1);
      INSERT INTO products (id, name, slug, price_minor, is_active)
      VALUES
        ('product_1', 'Test product', 'test-product', 10000, 1),
        ('product_2', 'Swap product', 'swap-product', 12500, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price_minor, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES
        ('variant_1', 'product_1', 'AMEND-SKU', 10000, 10, 2, 1, 1, 1),
        ('variant_2', 'product_2', 'AMEND-SWAP', 12500, 5, 0, 0, 1, 1);
      INSERT INTO orders (
        id, customer_name, customer_phone, customer_email, shipping_address,
        city, zone, city_name, zone_name, currency_code, currency_decimal_places,
        subtotal_amount_minor, shipping_amount_minor, discount_amount_minor,
        tax_amount_minor, total_amount_minor, tax_label, prices_include_tax,
        status, payment_method, payment_status, paid_amount_minor, balance_due_minor,
        fulfillment_status, inventory_pool, inventory_action, version
      ) VALUES (
        'order_1', 'Buyer', '+8801712345678', NULL, '123 Test Street, Dhaka',
        'city_1', 'zone_1', 'Dhaka', 'North', 'BDT', 2, 20000, 6000, 0, 0, 26000, 'Tax', 0,
        'confirmed', 'cod', 'unpaid', 0, 26000, 'pending', 'regular', 'reserved', 1
      );
      INSERT INTO admin_order_create_attempts (
        id, actor_id, request_key_hash, request_hash, order_id, status, attempts
      ) VALUES ('create_1', 'admin_1', 'create-key', 'create-hash', 'order_1', 'committed', 1);
      INSERT INTO cod_tracking (id, order_id, cod_status)
      VALUES ('cod_1', 'order_1', 'pending');
      INSERT INTO order_items (
        id, order_id, product_id, variant_id, quantity, product_name,
        inventory_tracked, unit_price_minor, line_subtotal_minor,
        discount_amount_minor, taxable_amount_minor, tax_amount_minor,
        fulfillment_status
      ) VALUES (
        'item_1', 'order_1', 'product_1', 'variant_1', 2, 'Test product',
        1, 10000, 20000, 0, 0, 0, 'pending'
      );
      INSERT INTO order_tax_snapshots (
        order_id, currency_code, decimal_places, display_label,
        prices_include_tax, shipping_taxed, settings_version,
        calculation_version, destination_snapshot, rate_snapshot
      ) VALUES (
        'order_1', 'BDT', 2, 'Tax', 0, 0,
        1, 'tax-v1', '{"city":"city_1","zone":"zone_1","area":null}', '{}'
      );
      INSERT INTO order_item_tax_snapshots (
        order_item_id, order_id, prices_include_tax, rate_snapshot
      ) VALUES ('item_1', 'order_1', 0, '[]');
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock,
        ledger_version, pool, reservation_generation, stock_version_before,
        stock_version_after, stock_delta, previous_reserved_stock,
        new_reserved_stock, reserved_stock_delta, previous_preorder_stock,
        new_preorder_stock, preorder_stock_delta
      ) VALUES (
        'reservation_1', 'variant_1', 'order_1', 'reserved', 2, 10, 10,
        2, 'regular', 1, 0, 1, 0, 0, 2, 2, 0, 0, 0
      );
    `);
  });

  afterEach(() => sqlite.close());

  type AmendmentDraft = PreviewManualOrderAmendmentInput & { requestKey: string };

  function input(overrides: Partial<AmendmentDraft> = {}): AmendmentDraft {
    return {
      requestKey: crypto.randomUUID(),
      expectedVersion: 1,
      customerName: "Buyer",
      customerPhone: "+8801712345678",
      customerEmail: null,
      shippingAddress: "123 Test Street, Dhaka",
      city: "city_1",
      zone: "zone_1",
      area: null,
      notes: null,
      items: [{
        orderItemId: "item_1",
        productId: "product_1",
        variantId: "variant_1",
        quantity: 2,
      }],
      discountAmount: null,
      shippingCharge: 60,
      ...overrides,
    };
  }

  async function confirmedInput(
    overrides: Partial<AmendmentDraft> = {},
  ): Promise<ConfirmManualOrderAmendmentInput> {
    const draft = input(overrides);
    const preview = await previewManualOrderAmendment(db, "order_1", draft);
    return { ...draft, quoteFingerprint: preview.quoteFingerprint };
  }

  it.each([[3, 3], [1, 1]])(
    "atomically amends quantity to %s and keeps the retained line identity",
    async (quantity, expectedReserved) => {
      const result = await confirmManualOrderAmendment(
        db,
        "order_1",
        await confirmedInput({ items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity }] }),
        "admin_1",
      );

      expect(result).toMatchObject({ id: "order_1", version: 2 });
      expect(sqlite.prepare("SELECT id, quantity FROM order_items").get()).toEqual({
        id: "item_1",
        quantity,
      });
      expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
        .toEqual({ reserved_stock: expectedReserved });
      expect(sqlite.prepare("SELECT expected_version, resulting_version FROM order_amendments").get())
        .toEqual({ expected_version: 1, resulting_version: 2 });
    },
  );

  it("recognizes an untouched manual COD order as amendment-ready", async () => {
    await expect(getAdminOrderAmendmentReadiness(db, "order_1")).resolves.toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("re-quotes destination tax and persists the revised COD balance", async () => {
    const preview = await previewManualOrderAmendment(
      db,
      "order_1",
      input({ zone: "zone_2" }),
    );
    expect(preview).toMatchObject({ taxAmount: 20, totalAmount: 280, balanceDue: 280 });

    await confirmManualOrderAmendment(db, "order_1", await confirmedInput({
      requestKey: "11111111-1111-4111-8111-111111111111",
      zone: "zone_2",
    }), "admin_1");
    expect(sqlite.prepare(`
      SELECT zone, zone_name, tax_amount_minor, total_amount_minor, balance_due_minor
      FROM orders WHERE id = 'order_1'
    `).get()).toEqual({
      zone: "zone_2",
      zone_name: "South",
      tax_amount_minor: 2000,
      total_amount_minor: 28000,
      balance_due_minor: 28000,
    });
  });

  it("replays a duplicate confirmation without changing stock or revision again", async () => {
    const amendment = await confirmedInput({
      requestKey: "22222222-2222-4222-8222-222222222222",
      items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity: 3 }],
    });
    const first = await confirmManualOrderAmendment(db, "order_1", amendment, "admin_1");
    const replay = await confirmManualOrderAmendment(db, "order_1", amendment, "admin_1");
    expect(replay).toEqual(first);
    expect(sqlite.prepare("SELECT version FROM orders WHERE id = 'order_1'").get()).toEqual({ version: 2 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 3 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_amendments").get()).toEqual({ count: 1 });
  });

  it("rejects a changed catalog quote after preview while preserving an exact replay", async () => {
    const draft = input({
      requestKey: "24444444-2444-4444-8444-244444444444",
      items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity: 3 }],
    });
    const preview = await previewManualOrderAmendment(db, "order_1", draft);
    const staleQuote = { ...draft, quoteFingerprint: preview.quoteFingerprint };

    sqlite.exec("UPDATE product_variants SET price_minor = 11000 WHERE id = 'variant_1'");
    await expect(confirmManualOrderAmendment(db, "order_1", staleQuote, "admin_1"))
      .rejects.toThrow(/prices or taxes changed.*refresh the quote/i);
    expect(sqlite.prepare("SELECT version FROM orders WHERE id = 'order_1'").get()).toEqual({ version: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_amendments").get()).toEqual({ count: 0 });

    const refreshed = await previewManualOrderAmendment(db, "order_1", draft);
    const amendment = { ...draft, quoteFingerprint: refreshed.quoteFingerprint };
    const committed = await confirmManualOrderAmendment(db, "order_1", amendment, "admin_1");
    sqlite.exec("UPDATE product_variants SET price_minor = 12000 WHERE id = 'variant_1'");
    await expect(confirmManualOrderAmendment(db, "order_1", amendment, "admin_1"))
      .resolves.toEqual(committed);
  });

  it("replaces a SKU atomically while keeping the retained order identity", async () => {
    const result = await confirmManualOrderAmendment(db, "order_1", await confirmedInput({
      shippingAddress: "456 Revised Street, Dhaka",
      items: [{ productId: "product_2", variantId: "variant_2", quantity: 1 }],
    }), "admin_1");

    expect(result).toMatchObject({ id: "order_1", version: 2, totalAmount: 185 });
    expect(sqlite.prepare("SELECT id, variant_id, quantity FROM order_items").get()).toMatchObject({
      variant_id: "variant_2",
      quantity: 1,
    });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 0 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_2'").get())
      .toEqual({ reserved_stock: 1 });
    expect(sqlite.prepare("SELECT shipping_address FROM orders WHERE id = 'order_1'").get())
      .toEqual({ shipping_address: "456 Revised Street, Dhaka" });
  });

  it("atomically records a changed buyer phone as a new customer identity", async () => {
    await confirmManualOrderAmendment(db, "order_1", await confirmedInput({
      customerPhone: "+8801812345678",
    }), "admin_1");

    const order = sqlite.prepare("SELECT customer_phone, customer_id FROM orders WHERE id = 'order_1'").get();
    expect(order?.customer_phone).toBe("+8801812345678");
    expect(order?.customer_id).toMatch(/^cust_/);
    expect(sqlite.prepare("SELECT phone, total_orders FROM customers").get()).toEqual({
      phone: "+8801812345678",
      total_orders: 1,
    });
    expect(sqlite.prepare("SELECT change_type FROM customer_history").get())
      .toEqual({ change_type: "created" });
  });

  it("rejects reusing an amendment key for different changes", async () => {
    const requestKey = "33333333-3333-4333-8333-333333333333";
    const first = await confirmedInput({ requestKey });
    const changedDraft = input({
      requestKey,
      shippingCharge: 70,
    });
    const changedPreview = await previewManualOrderAmendment(db, "order_1", changedDraft);
    await confirmManualOrderAmendment(db, "order_1", first, "admin_1");
    await expect(confirmManualOrderAmendment(db, "order_1", {
      ...changedDraft,
      quoteFingerprint: changedPreview.quoteFingerprint,
    }, "admin_1")).rejects.toThrow(/different changes/i);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_amendments").get()).toEqual({ count: 1 });
  });

  it("rejects insufficient stock and a stale loaded revision without partial writes", async () => {
    await expect(confirmManualOrderAmendment(db, "order_1", await confirmedInput({
      items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity: 99 }],
    }), "admin_1")).rejects.toThrow(/stock/i);
    const current = await confirmedInput();
    await expect(confirmManualOrderAmendment(db, "order_1", {
      ...current,
      requestKey: crypto.randomUUID(),
      expectedVersion: 2,
    }, "admin_1")).rejects.toThrow(/changed after you opened/i);
    expect(sqlite.prepare("SELECT version FROM orders WHERE id = 'order_1'").get()).toEqual({ version: 1 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 2 });
  });

  it.each([
    ["inventory", `UPDATE product_variants SET stock_version = stock_version + 1 WHERE id = 'variant_1'`],
    ["payment", `INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status) VALUES ('pay_1', 'order_1', 100, 'BDT', 'cod', 'full', 'pending')`],
    ["collection", `UPDATE cod_tracking SET cod_status = 'collected', collected_amount_minor = 26000, collected_at = unixepoch() WHERE order_id = 'order_1'`],
    ["shipment claim", `UPDATE orders SET shipment_claim_id = 'claim_1' WHERE id = 'order_1'`],
    ["shipment", `INSERT INTO delivery_shipments (id, order_id, provider_type, status) VALUES ('shipment_1', 'order_1', 'manual', 'pending')`],
    ["refund", `
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('pay_source', 'order_1', 100, 'BDT', 'cod', 'full', 'completed');
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('pay_refund', 'order_1', -100, 'BDT', 'cod', 'refund', 'pending');
      INSERT INTO refund_attempts (
        id, attempt_key, refund_group_id, order_id, source_payment_id,
        refund_payment_id, gateway, amount_minor, currency, reason, request_hash,
        provider_idempotency_key, refund_reference
      ) VALUES (
        'refund_1', 'attempt_1', 'group_1', 'order_1', 'pay_source',
        'pay_refund', 'cod', 100, 'BDT', 'Test refund', 'hash_1',
        'provider_key_1', 'reference_1'
      )`],
    ["return", `INSERT INTO order_returns (id, order_id, status, reason, actor_type, actor_id) VALUES ('return_1', 'order_1', 'requested', 'Test return', 'admin', 'admin_1')`],
    ["invoice", `INSERT INTO order_invoices (id, order_id, invoice_number, prefix, formatted_number, order_version, snapshot, content_hash, render_version, issued_at) VALUES ('invoice_1', 'order_1', 1, 'INV', 'INV-1', 1, '{}', '${"a".repeat(64)}', 'v1', unixepoch())`],
  ])("rejects concurrent %s evidence inside the final transaction", async (_kind, sqlText) => {
    beforeAmendmentBatch = () => sqlite.exec(sqlText);
    await expect(confirmManualOrderAmendment(db, "order_1", await confirmedInput({
      items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity: 3 }],
    }), "admin_1")).rejects.toThrow(/changed while|conflict|amend/i);
    expect(sqlite.prepare("SELECT version FROM orders WHERE id = 'order_1'").get()).toEqual({ version: 1 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 2 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_amendments").get()).toEqual({ count: 0 });
  });

  it("refuses full-editor replacement for a stale revision, lifecycle change, issued invoice, or return", async () => {
    // A full-editable manual order has no checkout tax snapshot.
    sqlite.exec("DELETE FROM order_item_tax_snapshots; DELETE FROM order_tax_snapshots;");
    const edit = (overrides: Record<string, unknown> = {}) => updateOrder(db, "order_1", {
      ...input(),
      items: [{ productId: "product_1", variantId: "variant_1", quantity: 3, price: 100 }],
      status: "confirmed",
      ...overrides,
    } as never);

    const state = () => [
      sqlite.prepare("SELECT version FROM orders").get(),
      sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get(),
    ];

    await expect(edit({ expectedVersion: 2 })).rejects.toThrow(/changed after you opened/i);
    await expect(edit({ status: "shipped" })).rejects.toThrow(/order status action/i);
    expect(state()).toEqual([{ version: 1 }, { reserved_stock: 2 }]);
    await expect(edit()).resolves.toMatchObject({ id: "order_1" });
    expect(state()).toEqual([{ version: 2 }, { reserved_stock: 3 }]);

    // Invoice then return: each refusal is attributable because the return check runs first.
    sqlite.exec(`INSERT INTO order_invoices (id, order_id, invoice_number, prefix, formatted_number,
      order_version, snapshot, content_hash, render_version, issued_at)
      VALUES ('invoice_1', 'order_1', 1, 'INV', 'INV-1', 2, '{}', '${"a".repeat(64)}', 'v1', unixepoch())`);
    await expect(edit({ expectedVersion: 2 })).rejects.toThrow(/invoice/i);
    sqlite.exec(`INSERT INTO order_returns (id, order_id, status, reason, actor_type, actor_id)
      VALUES ('return_1', 'order_1', 'cancelled', 'Test return', 'admin', 'admin_1')`);
    await expect(edit({ expectedVersion: 2 })).rejects.toThrow(/return/i);
    expect(state()).toEqual([{ version: 2 }, { reserved_stock: 3 }]);
  });

  it("commits a manual order with its reservation, COD tracking, customer stats and replay evidence exactly once", async () => {
    sqlite.exec(`INSERT INTO customers (id, name, phone, total_orders)
      VALUES ('cust_1', 'Buyer', '+8801712345678', 4)`);
    const { expectedVersion: _expectedVersion, ...draft } = input();
    const data = { ...draft, items: [{ productId: "product_1", variantId: "variant_1", quantity: 3 }] };

    const created = await ordersAdmin.createOrder(db, data, "admin_1");
    await expect(ordersAdmin.createOrder(db, data, "admin_1")).resolves.toEqual(created);

    expect(sqlite.prepare("SELECT customer_id, total_amount_minor, balance_due_minor, payment_status, inventory_action FROM orders WHERE id = ?")
      .get(created.id)).toEqual({
      customer_id: "cust_1", total_amount_minor: 36000, balance_due_minor: 36000, payment_status: "unpaid", inventory_action: "reserved",
    });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 5 });
    expect(sqlite.prepare("SELECT total_orders FROM customers").get()).toEqual({ total_orders: 5 });
    expect(sqlite.prepare("SELECT cod_status FROM cod_tracking WHERE order_id = ?").get(created.id)).toEqual({ cod_status: "pending" });
    expect(sqlite.prepare("SELECT status FROM admin_order_create_attempts WHERE order_id = ?").get(created.id))
      .toEqual({ status: "committed" });
  });

  it("creates a manual order only for a present phone from an allowed country", async () => {
    await saveAllowedCountries(db, ["BD"], "include");
    const { expectedVersion: _expectedVersion, ...draft } = input();
    const data = { ...draft, items: [{ productId: "product_1", variantId: "variant_1", quantity: 1 }] };
    const orderIds = () => sqlite.prepare("SELECT id FROM orders ORDER BY id").all().map((row) => row.id);

    await expect(ordersAdmin.createOrder(db, { ...data, customerPhone: "" }, "admin_1"))
      .rejects.toThrow("Phone number is required");
    expect(createOrderSchema.safeParse({ ...data, customerPhone: "" }).success).toBe(false);
    await expect(ordersAdmin.createOrder(db, { ...data, customerPhone: "+919876543210" }, "admin_1"))
      .rejects.toThrow("Phone numbers from IN are not accepted");
    expect(orderIds()).toEqual(["order_1"]);

    // A refused phone does not burn the request key; the route schema stores E.164.
    const corrected = createOrderSchema.parse({ ...data, customerPhone: "+880 1812-345678" });
    const created = await ordersAdmin.createOrder(db, corrected, "admin_1");
    expect(sqlite.prepare("SELECT customer_phone FROM orders WHERE id = ?").get(created.id))
      .toEqual({ customer_phone: "+8801812345678" });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ reserved_stock: 3 });
  });

  it("refuses a full-editor phone change to a disallowed country", async () => {
    sqlite.exec("DELETE FROM order_item_tax_snapshots; DELETE FROM order_tax_snapshots;");
    const edit = (customerPhone: string, expectedVersion = 1) => updateOrder(db, "order_1", {
      ...input({ expectedVersion, customerPhone }),
      items: [{ productId: "product_1", variantId: "variant_1", quantity: 2, price: 100 }],
      status: "confirmed",
    } as never);
    const stored = () => sqlite.prepare("SELECT customer_phone, version FROM orders").get();

    // The stored phone predates the policy; only a changed phone is re-checked.
    await saveAllowedCountries(db, ["IN"], "include");
    await expect(edit("+8801812345678")).rejects.toThrow("Phone numbers from BD are not accepted");
    expect(stored()).toEqual({ customer_phone: "+8801712345678", version: 1 });
    await expect(edit("+8801712345678")).resolves.toMatchObject({ id: "order_1" });

    await saveAllowedCountries(db, ["IN"], "exclude");
    await expect(edit("+919876543210", 2)).rejects.toThrow("Phone numbers from IN are not accepted");
    expect(stored()).toEqual({ customer_phone: "+8801712345678", version: 2 });
    // Regression: the new-phone customer insert once bound 19 values to 23 columns.
    await expect(edit("+8801812345678", 2)).resolves.toMatchObject({ id: "order_1" });
    expect(stored()).toEqual({ customer_phone: "+8801812345678", version: 3 });
    expect(sqlite.prepare(`SELECT c.phone, c.city_name, c.zone_name, c.total_orders, c.account_claimed_at
      FROM customers c JOIN orders o ON o.customer_id = c.id`).get()).toEqual({
      phone: "+8801812345678", city_name: "Dhaka", zone_name: "North", total_orders: 1, account_claimed_at: null,
    });
  });

  it("exposes archive but no permanent order deletion service", () => {
    expect(Object.keys(ordersAdmin).filter((name) => /delete/i.test(name))).toEqual([]);
    expect(ordersAdmin.archiveOrders).toBeTypeOf("function");
  });
});
