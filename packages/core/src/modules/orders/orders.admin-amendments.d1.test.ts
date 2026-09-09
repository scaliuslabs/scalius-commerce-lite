import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import {
  confirmManualOrderAmendment,
  getAdminOrderAmendmentReadiness,
  previewManualOrderAmendment,
} from "./orders.admin";
import type { ConfirmManualOrderAmendmentInput } from "./orders.validation";
import type { PreviewManualOrderAmendmentInput } from "./orders.validation";

interface D1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface D1Statement {
  query: string;
  bind(...values: SQLInputValue[]): D1Statement;
  run(): Promise<D1Result>;
  all(): Promise<D1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): D1Result;
}

function d1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): D1Statement {
  const execute = (): D1Result => ({
    results: sqlite.prepare(query).all(...values),
    success: true,
    meta: {},
  });
  return {
    query,
    bind: (...nextValues) => d1Statement(sqlite, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = sqlite.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = sqlite.prepare(query).all(...values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

describe("manual COD order amendments on D1 storage", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let beforeAmendmentBatch: (() => void) | null;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
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
      INSERT INTO products (id, name, slug, price, is_active)
      VALUES
        ('product_1', 'Test product', 'test-product', 100, 1),
        ('product_2', 'Swap product', 'swap-product', 125, 1);
      INSERT INTO product_variants
        (id, product_id, sku, price, stock, reserved_stock, stock_version, is_default, track_inventory)
      VALUES
        ('variant_1', 'product_1', 'AMEND-SKU', 100, 10, 2, 1, 1, 1),
        ('variant_2', 'product_2', 'AMEND-SWAP', 125, 5, 0, 0, 1, 1);
      INSERT INTO orders (
        id, customer_name, customer_phone, customer_email, shipping_address,
        city, zone, city_name, zone_name, total_amount, shipping_charge,
        discount_amount, currency_code, currency_decimal_places,
        subtotal_amount_minor, shipping_amount_minor, discount_amount_minor,
        tax_amount_minor, total_amount_minor, tax_label, prices_include_tax,
        status, payment_method, payment_status, paid_amount, balance_due,
        fulfillment_status, inventory_pool, inventory_action, version
      ) VALUES (
        'order_1', 'Buyer', '+8801712345678', NULL, '123 Test Street, Dhaka',
        'city_1', 'zone_1', 'Dhaka', 'North', 260, 60,
        0, 'BDT', 2, 20000, 6000, 0, 0, 26000, 'Tax', 0,
        'confirmed', 'cod', 'unpaid', 0, 260, 'pending', 'regular', 'reserved', 1
      );
      INSERT INTO admin_order_create_attempts (
        id, actor_id, request_key_hash, request_hash, order_id, status, attempts
      ) VALUES ('create_1', 'admin_1', 'create-key', 'create-hash', 'order_1', 'committed', 1);
      INSERT INTO cod_tracking (id, order_id, cod_status)
      VALUES ('cod_1', 'order_1', 'pending');
      INSERT INTO order_items (
        id, order_id, product_id, variant_id, quantity, price, product_name,
        inventory_tracked, unit_price_minor, line_subtotal_minor,
        discount_amount_minor, taxable_amount_minor, tax_amount_minor,
        fulfillment_status
      ) VALUES (
        'item_1', 'order_1', 'product_1', 'variant_1', 2, 100, 'Test product',
        1, 10000, 20000, 0, 0, 0, 'pending'
      );
      INSERT INTO order_tax_snapshots (
        order_id, currency_code, decimal_places, display_label,
        prices_include_tax, shipping_taxed, subtotal_minor, shipping_minor,
        discount_minor, taxable_minor, tax_minor, total_minor, settings_version,
        calculation_version, destination_snapshot, rate_snapshot
      ) VALUES (
        'order_1', 'BDT', 2, 'Tax', 0, 0, 20000, 6000, 0, 0, 0, 26000,
        1, 'tax-v1', '{"city":"city_1","zone":"zone_1","area":null}', '{}'
      );
      INSERT INTO order_item_tax_snapshots (
        order_item_id, order_id, unit_price_minor, quantity, gross_amount_minor,
        discount_minor, taxable_amount_minor, tax_minor, prices_include_tax,
        rate_snapshot
      ) VALUES ('item_1', 'order_1', 10000, 2, 20000, 0, 0, 0, 0, '[]');
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
    beforeAmendmentBatch = null;
    const binding = {
      prepare: (query: string) => d1Statement(sqlite, query),
      async batch(statements: D1Statement[]) {
        if (statements.some((statement) => statement.query.includes('"order_amendments"'))) {
          const before = beforeAmendmentBatch;
          beforeAmendmentBatch = null;
          before?.();
        }
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => statement.execute());
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    };
    db = drizzle(binding as unknown as D1Database, { schema }) as unknown as Database;
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
      SELECT zone, zone_name, tax_amount_minor, total_amount_minor, balance_due
      FROM orders WHERE id = 'order_1'
    `).get()).toEqual({
      zone: "zone_2",
      zone_name: "South",
      tax_amount_minor: 2000,
      total_amount_minor: 28000,
      balance_due: 280,
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

    sqlite.exec("UPDATE product_variants SET price = 110 WHERE id = 'variant_1'");
    await expect(confirmManualOrderAmendment(db, "order_1", staleQuote, "admin_1"))
      .rejects.toThrow(/prices or taxes changed.*refresh the quote/i);
    expect(sqlite.prepare("SELECT version FROM orders WHERE id = 'order_1'").get()).toEqual({ version: 1 });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_amendments").get()).toEqual({ count: 0 });

    const refreshed = await previewManualOrderAmendment(db, "order_1", draft);
    const amendment = { ...draft, quoteFingerprint: refreshed.quoteFingerprint };
    const committed = await confirmManualOrderAmendment(db, "order_1", amendment, "admin_1");
    sqlite.exec("UPDATE product_variants SET price = 120 WHERE id = 'variant_1'");
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
    ["payment", `INSERT INTO order_payments (id, order_id, amount, currency, payment_method, payment_type, status) VALUES ('pay_1', 'order_1', 1, 'BDT', 'cod', 'full', 'pending')`],
    ["collection", `UPDATE cod_tracking SET cod_status = 'collected', collected_amount = 260, collected_at = unixepoch() WHERE order_id = 'order_1'`],
    ["shipment claim", `UPDATE orders SET shipment_claim_id = 'claim_1' WHERE id = 'order_1'`],
    ["shipment", `INSERT INTO delivery_shipments (id, order_id, provider_type, status) VALUES ('shipment_1', 'order_1', 'manual', 'pending')`],
    ["refund", `
      INSERT INTO order_payments (id, order_id, amount, currency, payment_method, payment_type, status)
      VALUES ('pay_source', 'order_1', 1, 'BDT', 'cod', 'full', 'completed');
      INSERT INTO order_payments (id, order_id, amount, currency, payment_method, payment_type, status)
      VALUES ('pay_refund', 'order_1', -1, 'BDT', 'cod', 'refund', 'pending');
      INSERT INTO refund_attempts (
        id, attempt_key, refund_group_id, order_id, source_payment_id,
        refund_payment_id, gateway, amount, currency, reason, request_hash,
        provider_idempotency_key, refund_reference
      ) VALUES (
        'refund_1', 'attempt_1', 'group_1', 'order_1', 'pay_source',
        'pay_refund', 'cod', 1, 'BDT', 'Test refund', 'hash_1',
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
});
