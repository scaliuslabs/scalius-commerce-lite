// Tax-exempt buyers (audit I9) on the migrated schema, for D1 and TursoDB: the
// merchant marks a customer exempt with an exemption number, an order filed
// under them pays no tax, its tax snapshot and invoice keep the exemption, and
// unmarking the customer later leaves the order as it was priced.
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { createMigratedSqlite, createSqliteD1Database, createSqliteTursoDatabase } from "@scalius/database/testing/sqlite-d1";
import { getCustomerDetail, updateCustomer } from "../customers/customers.service";
import { createOrder } from "./admin/create";
import { quoteManualOrder } from "./admin/quote";
import { readInvoiceOrderSource } from "./invoices/order-reader";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function open(provider: "d1" | "turso"): Database {
  sqlite = createMigratedSqlite({ provider });
  const db = provider === "d1" ? createSqliteD1Database({ sqlite }).db : createSqliteTursoDatabase(sqlite);
  sqlite.exec(`
    INSERT INTO places (id, name, country_code, level, parent_id, external_ids, metadata, is_active)
    VALUES ('city_1', 'Dhaka', 'BD', 1, NULL, '{}', '{}', 1), ('zone_1', 'North', 'BD', 2, 'city_1', '{}', '{}', 1);
    INSERT INTO tax_classes (id, name) VALUES ('tax_standard', 'Standard');
    INSERT OR REPLACE INTO tax_settings (id, enabled, tax_shipping, default_tax_class_id, display_label, version)
    VALUES ('default', 1, 1, 'tax_standard', 'VAT', 1);
    INSERT INTO tax_regions (id, country_code) VALUES ('txreg_bd', 'BD');
    INSERT INTO tax_rates (id, tax_class_id, tax_region_id, name, rate_bps, is_active)
    VALUES ('tax_bd', 'tax_standard', 'txreg_bd', 'VAT', 1500, 1);
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('desk', 'Desk', 'desk', 100000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
    VALUES ('desk_sku', 'desk', 'DESK-1', 100000, 10, 1, 0);
    INSERT INTO customers (id, name, phone, origin) VALUES ('cust_co', 'Acme Ltd', '+8801712345678', 'merchant');
  `);
  return db;
}

function manualOrder(overrides: Record<string, unknown> = {}) {
  return {
    requestKey: crypto.randomUUID(),
    customerId: "cust_co",
    customerName: "Acme Ltd",
    customerPhone: "+8801712345678",
    customerEmail: null,
    shippingAddress: "Road 1, Dhaka",
    city: "city_1",
    zone: "zone_1",
    area: null,
    notes: null,
    items: [{ productId: "desk", variantId: "desk_sku", quantity: 1 }],
    discountAmount: 0,
    shippingCharge: 100,
    ...overrides,
  };
}

describe.each(["d1", "turso"] as const)("tax-exempt buyers (%s)", (provider) => {
  it("prices an exempt customer's order with no tax and keeps the exemption on the order", async () => {
    const db = open(provider);
    // 1,000 + 100 delivery, 15% VAT on both.
    await expect(quoteManualOrder(db, manualOrder())).resolves.toMatchObject({ taxAmount: 165, totalAmount: 1_265 });

    await updateCustomer(db, "cust_co", { taxExempt: true, taxExemptionId: "  BIN-000123  " }, null);
    expect(await getCustomerDetail(db, "cust_co")).toMatchObject({ taxExempt: true, taxExemptionId: "BIN-000123" });
    await expect(quoteManualOrder(db, manualOrder())).resolves.toMatchObject({ taxAmount: 0, totalAmount: 1_100 });
    // A guest order (no customer named) still pays tax.
    await expect(quoteManualOrder(db, manualOrder({ customerId: null }))).resolves.toMatchObject({ taxAmount: 165 });

    const created = await createOrder(db, manualOrder(), "admin_1");
    expect(sqlite!.prepare("SELECT tax_amount_minor, total_amount_minor FROM orders WHERE id = ?").get(created.id))
      .toEqual({ tax_amount_minor: 0, total_amount_minor: 110_000 });
    expect(sqlite!.prepare("SELECT tax_exempt, tax_exemption_id FROM order_tax_snapshots WHERE order_id = ?").get(created.id))
      .toEqual({ tax_exempt: 1, tax_exemption_id: "BIN-000123" });

    // The customer stops being exempt: the order keeps what it was priced with; the id is cleared.
    await updateCustomer(db, "cust_co", { taxExempt: false }, null);
    expect(await getCustomerDetail(db, "cust_co")).toMatchObject({ taxExempt: false, taxExemptionId: null });
    expect((await readInvoiceOrderSource(db, created.id))?.taxExemption).toEqual({ exemptionId: "BIN-000123" });
    await expect(quoteManualOrder(db, manualOrder())).resolves.toMatchObject({ taxAmount: 165 });
  });
});
