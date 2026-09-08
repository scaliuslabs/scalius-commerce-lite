import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { safeBatch, type Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { createAtomicCheckoutAttempt } from "./checkout-attempts";
import { commitStorefrontOrderPayload } from "./orders.ingest";
import type { StorefrontOrderCommitPayload } from "./orders.types";
import { calculateDiscountAmount, isDiscountValid } from "../discounts/discounts.eligibility";
import { createDiscount, deleteDiscount, permanentlyDeleteDiscount, restoreDiscounts, setDiscountActiveStatus, updateDiscount } from "../discounts/discounts.service";
import { createDiscountSchema, updateDiscountSchema } from "../discounts/discounts.validation";
import { prepareStockReservationBatch } from "../inventory";

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
  let beforeWriteBatch: (() => void | Promise<void>) | undefined;
  let databaseNow: number;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const migrations = new URL("../../../../database/migrations/", import.meta.url);
    for (const name of readdirSync(migrations).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      sqlite.exec(readFileSync(new URL(name, migrations), "utf8"));
    }
    databaseNow = Math.floor(Date.now() / 1000);
    sqlite.function("unixepoch", () => databaseNow);
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
          const beforeWrite = beforeWriteBatch;
          beforeWriteBatch = undefined;
          await beforeWrite?.();
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

  function checkout(identity = "a") {
    const attempt = createAtomicCheckoutAttempt({
      checkoutRequestId: "authority-test",
      requestKey: `checkout_submit:v1:${identity.repeat(64)}`,
      requestHash: "b".repeat(64),
      statusToken: `cst_${identity.repeat(64)}`,
    });
    const payload = createPayload(revision());
    payload.orderData.id = attempt.orderId;
    payload.checkoutToken = attempt.checkoutToken;
    return { payload, commit: { attempt, response: { orderId: attempt.orderId } } };
  }

  async function discountedCheckout(overrides: Record<string, unknown> = {}) {
    const rule = createDiscountSchema.parse({
      code: "AUDIT50", type: "amount_off_order", valueType: "percentage",
      discountValue: 50, isActive: true, startDate: new Date((databaseNow - 60) * 1000),
      ...overrides,
    });
    const discount = await createDiscount(db, rule, { canToggleStatus: true });
    const cart = [{ id: "prod_1", price: 100, quantity: 2, variantId: "variant_1" }];
    const validation = await isDiscountValid(db, rule.code, 200, cart, "+8801712345678", "", "BDT");
    expect(validation.valid).toBe(true);
    const amount = await calculateDiscountAmount(db, validation.discount!, 260, cart, 60, validation.applicableProductIds, "BDT", validation.hasProductRestrictions);
    const { payload, commit } = checkout();
    Object.assign(payload.orderData, {
      totalAmount: 260 - amount, totalAmountMinor: 26_000 - amount * 100,
      discountAmount: amount, discountAmountMinor: amount * 100, balanceDue: 260 - amount,
    });
    payload.items[0]!.discountAmountMinor = amount * 100;
    payload.taxQuote.discountMinor = amount * 100;
    payload.taxQuote.totalMinor = 26_000 - amount * 100;
    payload.taxQuote.lines[0]!.discountMinor = amount * 100;
    payload.taxQuote.lines[0]!.totalMinor = 20_000 - amount * 100;
    payload.discountUsage = {
      discountId: validation.discount!.id,
      revision: validation.discount!.revision,
      amountDiscounted: amount,
    };
    return { payload, commit, discount, rule };
  }

  function expectNoCheckoutWrites() {
    for (const table of [
      "orders", "order_items", "checkout_attempts", "order_receipts", "customers",
      "customer_history", "inventory_movements", "order_tax_snapshots",
      "order_item_tax_snapshots", "order_notification_outbox", "meta_capi_purchase_outbox",
      "discount_usage", "discount_customer_redemptions",
    ]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
    expect(sqlite.prepare("SELECT stock, reserved_stock FROM product_variants WHERE id = 'variant_1'").get())
      .toEqual({ stock: 10, reserved_stock: 0 });
  }

  it.each(["deactivate", "amount edit", "scope edit", "trash", "restore", "delete permanently"])(
    "rejects a discount %s after validation and advisory reads without committing any checkout writes",
    async (change) => {
      const { payload, commit, discount, rule } = await discountedCheckout();
      beforeWriteBatch = async () => {
        if (change === "deactivate") {
          await setDiscountActiveStatus(db, discount.id, false, discount.revision);
        } else if (change === "amount edit" || change === "scope edit") {
          await updateDiscount(db, discount.id, updateDiscountSchema.parse({
            ...rule, id: discount.id, expectedRevision: discount.revision,
            ...(change === "amount edit" ? { discountValue: 25 } : {
              type: "amount_off_products", appliesToProducts: ["prod_1"],
            }),
          }));
        } else {
          await deleteDiscount(db, discount.id);
          if (change === "restore") await restoreDiscounts(db, [discount.id]);
          if (change === "delete permanently") await permanentlyDeleteDiscount(db, discount.id);
        }
      };
      await expect(commitStorefrontOrderPayload(db, payload, commit))
        .rejects.toThrow("Checkout details changed while the order was being placed");
      expect(revision()).toBe(payload.checkoutAuthorityRevision);
      expectNoCheckoutWrites();
    },
  );

  it.each([-61, 0, 10, 11])("checks the discount schedule at database commit time (offset %s)", async (offset) => {
    const { payload, commit } = await discountedCheckout({ endDate: new Date((databaseNow + 10) * 1000) });
    beforeWriteBatch = () => { databaseNow += offset; };
    if (offset < -60 || offset > 10) {
      await expect(commitStorefrontOrderPayload(db, payload, commit))
        .rejects.toThrow("Checkout details changed while the order was being placed");
      expectNoCheckoutWrites();
    } else {
      await expect(commitStorefrontOrderPayload(db, payload, commit)).resolves.toMatchObject({ alreadyCommitted: false });
    }
  });

  it("ignores unrelated discount edits and replays committed money after deactivation", async () => {
    const { payload, commit, discount, rule } = await discountedCheckout({ limitOnePerCustomer: true });
    const other = await createDiscount(db, { ...rule, code: "OTHER50" }, { canToggleStatus: true });
    beforeWriteBatch = async () => { await setDiscountActiveStatus(db, other.id, false, other.revision); };
    await expect(commitStorefrontOrderPayload(db, payload, commit)).resolves.toMatchObject({ alreadyCommitted: false });
    expect(revision()).toBe(payload.checkoutAuthorityRevision);
    await setDiscountActiveStatus(db, discount.id, false, discount.revision);
    delete (payload.discountUsage as Partial<NonNullable<typeof payload.discountUsage>>).revision;
    await expect(commitStorefrontOrderPayload(db, payload)).resolves.toMatchObject({ alreadyCommitted: true });
    expect(sqlite.prepare("SELECT discount_amount, total_amount FROM orders").all()).toEqual([{ discount_amount: 100, total_amount: 160 }]);
    for (const table of ["discount_usage", "discount_customer_redemptions", "order_receipts", "inventory_movements"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(1);
    }
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()?.reserved_stock).toBe(2);
  });

  it.each(["maxUses", "limitOnePerCustomer"])("preserves atomic %s limits for two prepared checkouts", async (limit) => {
    const { payload, commit } = await discountedCheckout({ [limit]: limit === "maxUses" ? 1 : true });
    const second = checkout("b");
    const nextPayload = structuredClone(payload);
    nextPayload.orderData.id = second.payload.orderData.id;
    nextPayload.checkoutToken = second.payload.checkoutToken;
    nextPayload.items[0]!.id = "item_2";
    // The first order lands after the second has read advisory usage limits.
    beforeWriteBatch = async () => { await commitStorefrontOrderPayload(db, payload, commit); };
    await expect(commitStorefrontOrderPayload(db, nextPayload, second.commit))
      .rejects.toThrow(limit === "maxUses" ? "usage limit" : "already used by this customer");
    expect(sqlite.prepare("SELECT id FROM orders").all()).toEqual([{ id: payload.orderData.id }]);
    expect(sqlite.prepare("SELECT COUNT(*) AS count FROM discount_usage").get()?.count).toBe(1);
    expect(sqlite.prepare("SELECT reserved_stock FROM product_variants WHERE id = 'variant_1'").get()?.reserved_stock).toBe(2);
  });

  it("rejects a discount change before the order-only replay batch and preserves the existing reservation", async () => {
    const { payload, commit, discount } = await discountedCheckout();
    const reservation = await prepareStockReservationBatch(db, [{
      variantId: "variant_1", quantity: 2, orderId: payload.orderData.id,
    }], "regular", {
      reservationKey: "checkout-ingest:v1",
      freshOrderIds: new Set([payload.orderData.id]),
    });
    await safeBatch(db, reservation.statements);
    const movements = sqlite.prepare("SELECT * FROM inventory_movements").all();
    const stock = sqlite.prepare("SELECT stock, reserved_stock, stock_version FROM product_variants WHERE id = 'variant_1'").get();
    let commitBatches = 0;
    beforeWriteBatch = () => {
      commitBatches += 1;
      // The first batch discovers the already-committed reservation. Change
      // the discount only when the committer retries without inventory writes.
      beforeWriteBatch = async () => {
        commitBatches += 1;
        await setDiscountActiveStatus(db, discount.id, false, discount.revision);
      };
    };
    await expect(commitStorefrontOrderPayload(db, payload, commit))
      .rejects.toThrow("Checkout details changed while the order was being placed");
    expect(commitBatches).toBe(2);
    expect(sqlite.prepare("SELECT * FROM inventory_movements").all()).toEqual(movements);
    expect(sqlite.prepare("SELECT stock, reserved_stock, stock_version FROM product_variants WHERE id = 'variant_1'").get()).toEqual(stock);
    for (const table of ["orders", "order_items", "order_receipts", "checkout_attempts", "discount_usage", "customers", "customer_history"]) {
      expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, table).toBe(0);
    }
  });

  it("rejects a SKU price edit after preparation and leaves no checkout side effects", async () => {
    const { payload, commit } = checkout();
    beforeWriteBatch = () => {
      sqlite.exec("UPDATE product_variants SET price = 900 WHERE id = 'variant_1'");
    };

    await expect(commitStorefrontOrderPayload(db, payload, commit))
      .rejects.toThrow("Checkout details changed while the order was being placed");
    expect(revision()).toBe(payload.checkoutAuthorityRevision! + 1);
    expectNoCheckoutWrites();
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
