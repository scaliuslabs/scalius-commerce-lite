// Regression coverage for the current quote-backed order edit transaction.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../../../packages/database/src/client";
import { createSqliteD1Database } from "../../../../packages/database/src/testing/sqlite-d1";
import { confirmManualOrderAmendment, previewManualOrderAmendment } from "../../../../packages/core/src/modules/orders/admin/amend";
import { restoreOrder } from "../../../../packages/core/src/modules/orders/admin/archive";
import { confirmManualOrderAmendmentSchema, type ConfirmManualOrderAmendmentInput, type PreviewManualOrderAmendmentInput } from "../../../../packages/core/src/modules/orders/validation";

describe("order amendment inventory atomicity", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let beforeAmendmentBatch: (() => void) | null;

  beforeEach(() => {
    beforeAmendmentBatch = null;
    ({ sqlite, db } = createSqliteD1Database({
      beforeBatch() {
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
        discount_amount_minor, taxable_amount_minor, tax_amount_minor
      ) VALUES (
        'item_1', 'order_1', 'product_1', 'variant_1', 2, 'Test product',
        1, 10000, 20000, 0, 0, 0
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

  // Compare durable facts, not the removed pre-write/compensation call sequence.
  function state() {
    return Object.fromEntries([
      "orders", "order_items", "customers", "customer_history", "product_variants",
      "inventory_movements", "order_amendments", "order_tax_snapshots", "order_item_tax_snapshots",
    ].map((table) => [table, sqlite.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));
  }

  async function unchangedOnFailure(data: ConfirmManualOrderAmendmentInput, message: string | RegExp, name = "ConflictError") {
    const before = state();
    await expect(confirmManualOrderAmendment(db, "order_1", data, "admin_1")).rejects.toMatchObject({
      name,
      code: name === "ValidationError" ? "VALIDATION_ERROR" : "CONFLICT",
      message: typeof message === "string" ? message : expect.stringMatching(message),
    });
    expect(state()).toEqual(before);
  }

  function quantity(value: number): Partial<AmendmentDraft> {
    return { items: [{ orderItemId: "item_1", productId: "product_1", variantId: "variant_1", quantity: value }] };
  }

  it("rejects invalid delivery-location hierarchy before inventory or order writes", async () => {
    const data = await confirmedInput(quantity(3));
    sqlite.exec("INSERT INTO delivery_locations (id, name, type, external_ids, metadata, is_active) VALUES ('city_2', 'Other city', 'city', '{}', '{}', 1)");
    await unchangedOnFailure({ ...data, city: "city_2" }, "Selected thana is no longer available for the chosen city.", "ValidationError");
  });

  it("rejects active shipment claims before inventory or order writes", async () => {
    const data = await confirmedInput(quantity(3));
    sqlite.exec("UPDATE orders SET shipment_claim_id = 'claim_active'");
    await unchangedOnFailure(data, "A courier booking is in progress. Try again in a minute.");
  });

  it("rejects active refund attempts before inventory or order writes", async () => {
    const data = await confirmedInput(quantity(3));
    sqlite.exec(`
      INSERT INTO order_payments (id, order_id, amount_minor, currency, payment_method, payment_type, status)
      VALUES ('source', 'order_1', 100, 'BDT', 'cod', 'full', 'completed'),
             ('refund', 'order_1', -100, 'BDT', 'cod', 'refund', 'pending');
      INSERT INTO refund_attempts (id, attempt_key, refund_group_id, order_id, source_payment_id,
        refund_payment_id, gateway, amount_minor, currency, reason, request_hash, provider_idempotency_key, refund_reference)
      VALUES ('attempt', 'key', 'group', 'order_1', 'source', 'refund', 'cod', 100, 'BDT', 'Test', 'hash', 'provider', 'reference');
    `);
    await unchangedOnFailure(data, "Items can't be changed after payment. Refund or create a new order instead.");
  });

  it("fails reserved quantity increases before order/customer/item writes when stock is insufficient", async () => {
    const data = await confirmedInput(quantity(99));
    await unchangedOnFailure(data, /Insufficient stock/, "ValidationError");
  });

  it.each([3, 1])("rolls back reserved quantity %s when the order CAS races", async (value) => {
    const data = await confirmedInput(quantity(value));
    let before: ReturnType<typeof state>;
    beforeAmendmentBatch = () => {
      sqlite.exec("UPDATE orders SET version = version + 1");
      before = state();
    };
    await expect(confirmManualOrderAmendment(db, "order_1", data, "admin_1"))
      .rejects.toThrow("This order changed while the amendment was being confirmed. Reload and review it.");
    expect(state()).toEqual(before!);
  });

  it.each(["shipped", "cancelled"])("blocks inventory rewrites after an order reaches %s", async (status) => {
    const data = await confirmedInput(quantity(3));
    sqlite.prepare("UPDATE orders SET status = ?, inventory_action = ?").run(status, status === "shipped" ? "deducted" : "restored");
    await unchangedOnFailure(data, status === "shipped"
      ? "This order has been sent, so it can't be changed."
      : "This order is closed, so it can't be changed.");
  });

  it("fails reserved quantity decreases before item replacement when the reservation cannot be released", async () => {
    const data = await confirmedInput(quantity(1));
    sqlite.exec("UPDATE product_variants SET reserved_stock = 0 WHERE id = 'variant_1'");
    const before = state();
    await expect(confirmManualOrderAmendment(db, "order_1", data, "admin_1")).rejects.toMatchObject({
      name: "InventoryLedgerDiscontinuityError", message: expect.stringMatching(/reservation|reserved/i),
    });
    expect(state()).toEqual(before);
  });

  it("cannot change lifecycle status through the amendment request", async () => {
    const data = await confirmedInput(quantity(3));
    const parsed = confirmManualOrderAmendmentSchema.parse({ ...data, status: "cancelled" });
    expect(parsed).not.toHaveProperty("status");
    await confirmManualOrderAmendment(db, "order_1", parsed, "admin_1");
    expect(sqlite.prepare("SELECT status FROM orders WHERE id = 'order_1'").get()).toEqual({ status: "confirmed" });
  });

  it.each([3, 1])("rolls back inventory and order CAS when item replacement fails for quantity %s", async (value) => {
    const data = await confirmedInput(quantity(value));
    sqlite.exec(`CREATE TRIGGER fail_item_edit BEFORE UPDATE ON order_items BEGIN SELECT RAISE(ABORT, 'item batch failed'); END`);
    const before = state();
    await expect(confirmManualOrderAmendment(db, "order_1", data, "admin_1")).rejects.toThrow(/item batch failed/);
    expect(state()).toEqual(before);
  });

  it("does not use amendments as a shipped-order inventory reconciliation command", async () => {
    const data = await confirmedInput();
    sqlite.exec("UPDATE orders SET status = 'shipped'");
    await unchangedOnFailure(data, "This order has been sent, so it can't be changed.");
  });

  describe("restoreOrder archive safety", () => {
    beforeEach(() => sqlite.exec("UPDATE orders SET archived_at = 1800000"));

    it("restores only the archive marker and revision without rewriting commerce facts", async () => {
      const before = state();
      await restoreOrder(db, "order_1", 1);
      const after = state();
      expect(after.orders[0]).toEqual({ ...before.orders[0], archived_at: null, version: 2, updated_at: expect.any(Number) });
      expect({ ...after, orders: [] }).toEqual({ ...before, orders: [] });
    });

    it.each([
      ["legacy soft-deleted order", "UPDATE orders SET deleted_at = 1700000", 1, "This legacy-deleted order cannot be restored from the archive."],
      ["unarchived order", "UPDATE orders SET archived_at = NULL", 1, "Order is not archived"],
      ["stale version", "UPDATE orders SET version = 4", 3, "Order was modified by another request. Reload and try again."],
    ] as const)("rejects a %s without touching inventory", async (_label, sql, version, message) => {
      sqlite.exec(sql);
      const before = state();
      await expect(restoreOrder(db, "order_1", version)).rejects.toThrow(message);
      expect(state()).toEqual(before);
    });

    it("reports a CAS race without inventory compensation side effects", async () => {
      const update = db.update.bind(db);
      let before: ReturnType<typeof state>;
      vi.spyOn(db, "update").mockImplementationOnce((...args) => {
        sqlite.exec("UPDATE orders SET version = version + 1");
        before = state();
        return update(...args);
      });
      await expect(restoreOrder(db, "order_1", 1))
        .rejects.toThrow("Order was modified by another request. Reload and try again.");
      expect(state()).toEqual(before!);
    });
  });
});
