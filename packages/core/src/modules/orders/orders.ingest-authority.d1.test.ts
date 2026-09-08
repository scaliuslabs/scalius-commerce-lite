import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createAtomicCheckoutAttempt } from "./checkout-attempts";
import { commitStorefrontOrderPayload } from "./orders.ingest";
import type { StorefrontOrderCommitPayload } from "./orders.types";

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  query: string;
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function createD1Statement(
  sqlite: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: sqlite.prepare(query).all(...values),
    success: true,
    meta: {},
  });

  return {
    query,
    bind: (...nextValues) => createD1Statement(sqlite, query, nextValues),
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

function createPayload(checkoutAuthorityRevision: number): StorefrontOrderCommitPayload {
  return {
    checkoutToken: "chk_order_discount",
    checkoutAuthorityRevision,
    existingCustomer: null,
    orderData: {
      id: "order_discount",
      customerName: "Discount Buyer",
      customerPhone: "+8801712345678",
      customerEmail: "buyer@example.com",
      shippingAddress: "123 Discount Road",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: "Dhaka",
      zoneName: "Mirpur",
      areaName: null,
      notes: null,
      totalAmount: 260,
      shippingCharge: 60,
      discountAmount: 0,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: 20_000,
      shippingAmountMinor: 6_000,
      shippingMethodId: "shipping_standard",
      shippingMethodName: "Standard delivery",
      shippingMethodDescription: "Delivered within 2–3 business days",
      shippingMethodBaseAmountMinor: 6_000,
      shippingFeeWaived: false,
      discountAmountMinor: 0,
      taxAmountMinor: 0,
      totalAmountMinor: 26_000,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: "incomplete",
      paymentMethod: "stripe",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 260,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [
      {
        id: "item_1",
        taxAllocationLineId: "cart:0:variant_1",
        cartKey: "line_1",
        productId: "prod_1",
        variantId: "variant_1",
        quantity: 2,
        price: 100,
        productName: "Discounted Product",
        variantLabel: null,
        productImageMediaId: null,
        inventoryTracked: true,
        unitPriceMinor: 10_000,
        lineSubtotalMinor: 20_000,
        discountAmountMinor: 0,
        taxableAmountMinor: 0,
        taxAmountMinor: 0,
      },
    ],
    discountUsage: null,
    requestUrl: "https://shop.example.com/api/v1/orders",
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      settingsVersion: 0,
      subtotalMinor: 20_000,
      shippingMinor: 6_000,
      discountMinor: 0,
      taxableMinor: 0,
      taxMinor: 0,
      totalMinor: 26_000,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "cart:0:variant_1",
        productId: "prod_1",
        variantId: "variant_1",
        taxClassId: null,
        taxClassName: null,
        unitPriceMinor: 10_000,
        quantity: 2,
        grossAmountMinor: 20_000,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 20_000,
        components: [],
      }],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 6_000,
        discountMinor: 0,
        taxableAmountMinor: 0,
        taxMinor: 0,
        totalMinor: 6_000,
        components: [],
      },
    },
  };
}


describe("storefront checkout authority at the atomic commit", () => {
  let sqlite: DatabaseSync;
  let db: Database;
  let beforeWriteBatch: (() => void) | undefined;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    sqlite.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO products (id, name, slug, price, is_active)
      VALUES ('prod_1', 'Test product', 'test-product', 100, 1);
      INSERT INTO product_variants (id, product_id, sku, price, stock, is_default, track_inventory)
      VALUES ('variant_1', 'prod_1', 'AUTHORITY-SKU', 100, 10, 1, 1);
      INSERT INTO shipping_methods (id, name, fee, is_active)
      VALUES ('shipping_standard', 'Standard delivery', 60, 1);
    `);
    beforeWriteBatch = undefined;
    const binding = {
      prepare: (query: string) => createD1Statement(sqlite, query),
      async batch(statements: SqliteD1Statement[]) {
        if (statements.some((statement) => statement.query.startsWith('insert into "orders"'))) {
          beforeWriteBatch?.();
          beforeWriteBatch = undefined;
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

  function revision(): number {
    return Number(sqlite.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get()?.revision);
  }

  function checkout() {
    const attempt = createAtomicCheckoutAttempt({
      checkoutRequestId: "authority-test",
      requestKey: `checkout_submit:v1:${"a".repeat(64)}`,
      requestHash: "b".repeat(64),
      statusToken: `cst_${"a".repeat(64)}`,
    });
    const payload = createPayload(revision());
    payload.orderData.id = attempt.orderId;
    payload.checkoutToken = attempt.checkoutToken;
    return { payload, commit: { attempt, response: { orderId: attempt.orderId } } };
  }

  it("rejects a SKU price edit after preparation and leaves no checkout side effects", async () => {
    const { payload, commit } = checkout();
    beforeWriteBatch = () => {
      sqlite.exec("UPDATE product_variants SET price = 900 WHERE id = 'variant_1'");
    };

    await expect(commitStorefrontOrderPayload(db, payload, commit))
      .rejects.toThrow("Checkout details changed while the order was being placed");
    expect(revision()).toBe(payload.checkoutAuthorityRevision! + 1);
    for (const table of [
      "orders", "order_items", "checkout_attempts", "order_receipts", "customers",
      "customer_history", "inventory_movements", "order_tax_snapshots",
      "order_item_tax_snapshots", "order_notification_outbox", "meta_capi_purchase_outbox",
    ]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
    expect(sqlite.prepare("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ stock: 10, reserved_stock: 0 });
  });

  it("commits current authority once and replays the saved order after a later price edit", async () => {
    const { payload, commit } = checkout();
    await expect(commitStorefrontOrderPayload(db, payload, commit))
      .resolves.toMatchObject({ alreadyCommitted: false });
    expect(sqlite.prepare("SELECT price, quantity FROM order_items").get())
      .toEqual({ price: 100, quantity: 2 });
    expect(sqlite.prepare("SELECT subtotal_amount_minor, total_amount, total_amount_minor FROM orders").get())
      .toEqual({ subtotal_amount_minor: 20_000, total_amount: 260, total_amount_minor: 26_000 });
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()?.reserved_stock).toBe(2);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM order_receipts").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT status FROM checkout_attempts").get()?.status).toBe("committed");

    sqlite.exec("UPDATE product_variants SET price = 900 WHERE id = 'variant_1'");
    payload.checkoutAuthorityRevision = null;
    await expect(commitStorefrontOrderPayload(db, payload))
      .resolves.toMatchObject({ alreadyCommitted: true, orderId: payload.orderData.id });
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM orders").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM inventory_movements").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()?.reserved_stock).toBe(2);
  });
});
