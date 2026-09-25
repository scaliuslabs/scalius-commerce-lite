// Behaviour of the single storefront commit path on the real migrated schema:
// one guarded batch writes the order, its items, the SKU hold (ledger v2 +
// stockVersion), the idempotency row, the receipt, and the outboxes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { Database } from "@scalius/database/client";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
  createSqliteTursoDatabase,
} from "@scalius/database/testing/sqlite-d1";
import { ConflictError, ValidationError } from "../../errors";
import { applyInventoryForStatusChange } from "../inventory";
import {
  createAtomicCheckoutAttempt,
  resolveExistingCheckoutAttempt,
  type CheckoutAttemptIdentity,
} from "./attempts";
import { commitStorefrontOrderPayload } from "./commit";
import type { StorefrontOrderCommitPayload } from "../orders/types";
import { archiveStaleIncompleteOrders } from "../orders/stale-incomplete";

type Provider = "d1" | "turso";

let sqlite: DatabaseSync | undefined;
afterEach(() => sqlite?.close());

function openStore(provider: Provider, stock = 3): Database {
  sqlite = createMigratedSqlite({ provider });
  sqlite.exec(`
    INSERT INTO products (id, name, slug, price_minor, is_active) VALUES ('prod_1', 'Tee', 'tee', 10000, 1);
    INSERT INTO product_variants (id, product_id, sku, price_minor, stock, is_default, track_inventory)
    VALUES ('var_1', 'prod_1', 'TEE-1', 10000, ${stock}, 1, 1);
  `);
  return provider === "d1"
    ? createSqliteD1Database({ sqlite }).db
    : createSqliteTursoDatabase(sqlite);
}

const identity = (key: string, hash = "b".repeat(64)): CheckoutAttemptIdentity => ({
  checkoutRequestId: `request-${key}`,
  requestKey: `checkout_submit:v1:${key.padEnd(64, "0")}`,
  requestHash: hash,
  statusToken: `cst_${key.padEnd(64, "0")}`,
});

function prepare(key: string, overrides: {
  quantity?: number;
  hash?: string;
  phone?: string;
  paymentMethod?: string;
  status?: string;
} = {}) {
  const attempt = createAtomicCheckoutAttempt(identity(key, overrides.hash));
  const quantity = overrides.quantity ?? 1;
  const revision = Number(sqlite!.prepare("SELECT revision FROM checkout_authority WHERE id = 'default'").get()?.revision);
  const payload: StorefrontOrderCommitPayload = {
    checkoutToken: attempt.checkoutToken,
    checkoutAuthorityRevision: revision,
    checkoutSideEffects: { orderCreatedNotification: true, metaPurchase: false },
    existingCustomer: null,
    orderData: {
      id: attempt.orderId,
      customerName: "Race Buyer",
      customerPhone: overrides.phone ?? `+88017${key.replace(/\D/g, "").padStart(8, "1").slice(-8)}`,
      customerEmail: null,
      shippingAddress: "House 1, Road 2, Dhaka",
      city: "city_1", zone: "zone_1", area: null, cityName: null, zoneName: null, areaName: null,
      notes: null,
      totalAmount: 100 * quantity,
      shippingCharge: 0,
      discountAmount: 0,
      currencyCode: "BDT",
      currencyDecimalPlaces: 2,
      subtotalAmountMinor: 10_000 * quantity,
      shippingAmountMinor: 0,
      shippingMethodId: null,
      shippingMethodName: null,
      shippingMethodDescription: null,
      shippingMethodBaseAmountMinor: null,
      shippingFeeWaived: null,
      discountAmountMinor: 0,
      taxAmountMinor: 0,
      totalAmountMinor: 10_000 * quantity,
      taxLabel: "Tax",
      pricesIncludeTax: false,
      status: overrides.status ?? "pending",
      paymentMethod: overrides.paymentMethod ?? "cod",
      paymentStatus: "unpaid",
      paidAmount: 0,
      balanceDue: 100 * quantity,
      fulfillmentStatus: "pending",
      inventoryPool: "regular",
      inventoryAction: "reserved",
    },
    items: [{
      id: `item_${attempt.orderId}`,
      taxAllocationLineId: "line_1",
      cartKey: null,
      productId: "prod_1",
      variantId: "var_1",
      quantity,
      price: 100,
      productName: "Tee",
      variantLabel: null,
      productImageMediaId: null,
      inventoryTracked: true,
      unitPriceMinor: 10_000,
      lineSubtotalMinor: 10_000 * quantity,
      discountAmountMinor: 0,
      taxableAmountMinor: 0,
      taxAmountMinor: 0,
    }],
    requestUrl: "https://shop.example.com/api/v1/orders",
    taxQuote: {
      schemaVersion: 1, calculationVersion: "tax-v1", enabled: false, currencyCode: "BDT",
      decimalPlaces: 2, displayLabel: "Tax", pricesIncludeTax: false, shippingTaxed: false,
      settingsVersion: 0, subtotalMinor: 10_000 * quantity, shippingMinor: 0, discountMinor: 0,
      taxableMinor: 0, taxMinor: 0, totalMinor: 10_000 * quantity,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: "line_1", productId: "prod_1", variantId: "var_1", taxClassId: null, taxClassName: null,
        unitPriceMinor: 10_000, quantity, grossAmountMinor: 10_000 * quantity, discountMinor: 0,
        taxableAmountMinor: 0, taxMinor: 0, totalMinor: 10_000 * quantity, components: [],
      }],
      shipping: {
        taxClassId: null, taxClassName: null, grossAmountMinor: 0, discountMinor: 0,
        taxableAmountMinor: 0, taxMinor: 0, totalMinor: 0, components: [],
      },
    },
  } as unknown as StorefrontOrderCommitPayload;
  return { payload, commit: { attempt, response: { orderId: attempt.orderId, receiptToken: attempt.checkoutToken } } };
}

const counters = () => sqlite!.prepare(
  "SELECT stock, reserved_stock, stock_version FROM product_variants WHERE id = 'var_1'",
).get();
const rows = (table: string, where = "1 = 1") =>
  Number(sqlite!.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get()?.count);

describe.each(["d1", "turso"] as const)("storefront checkout commit (%s)", (provider) => {
  it("writes the order, items, hold, idempotency row, receipt, and outbox in one batch", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("a", { quantity: 2 });

    const result = await commitStorefrontOrderPayload(db, payload, commit);

    expect(result).toMatchObject({ orderId: payload.orderData.id, alreadyCommitted: false });
    const orderId = payload.orderData.id;
    expect(rows("order_items", `order_id = '${orderId}'`)).toBe(1);
    expect(rows("order_item_tax_snapshots", `order_id = '${orderId}'`)).toBe(1);
    expect(rows("checkout_attempts", `order_id = '${orderId}' AND status = 'committed'`)).toBe(1);
    expect(rows("order_receipts", `order_id = '${orderId}' AND status = 'active'`)).toBe(1);
    expect(rows("notification_outbox", `order_id = '${orderId}'`)).toBe(1);
    expect(rows("meta_capi_purchase_outbox")).toBe(0);
    expect(counters()).toEqual({ stock: 3, reserved_stock: 2, stock_version: 2 });
    expect(sqlite!.prepare(`
      SELECT type, quantity, ledger_version, reservation_generation, stock_version_before, stock_version_after,
        previous_reserved_stock, new_reserved_stock
      FROM inventory_movements WHERE order_id = ?
    `).all(orderId)).toEqual([{
      type: "reserved", quantity: 2, ledger_version: 2, reservation_generation: 1,
      stock_version_before: 1, stock_version_after: 2, previous_reserved_stock: 0, new_reserved_stock: 2,
    }]);
  });

  it("commits one order and one hold for concurrent submits of the same checkout", async () => {
    const db = openStore(provider);
    const first = prepare("same");
    const second = prepare("same");

    const outcomes = await Promise.allSettled([
      commitStorefrontOrderPayload(db, first.payload, first.commit),
      commitStorefrontOrderPayload(db, second.payload, second.commit),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(ConflictError);
    expect(rows("orders")).toBe(1);
    expect(counters()).toMatchObject({ reserved_stock: 1 });
    const replay = await resolveExistingCheckoutAttempt<{ orderId: string }>(db, identity("same"));
    expect(replay).toEqual({
      status: "replay",
      response: expect.objectContaining({ orderId: expect.any(String) }),
    });
    expect(sqlite!.prepare("SELECT id FROM orders").get()?.id)
      .toBe((replay as { response: { orderId: string } }).response.orderId);
    // The checkout commit numbers the order in the same INSERT (#1001).
    expect(sqlite!.prepare("SELECT order_number FROM orders").get()).toEqual({ order_number: 1001 });
  });

  it("refuses the same checkout key with different checkout details (409)", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("k1");
    await commitStorefrontOrderPayload(db, payload, commit);

    await expect(resolveExistingCheckoutAttempt(db, identity("k1", "c".repeat(64))))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("never oversells the last units to concurrent buyers", async () => {
    const db = openStore(provider, 3);
    const buyers = Array.from({ length: 8 }, (_, index) => prepare(`buyer${index}`));

    const outcomes = await Promise.allSettled(
      buyers.map(({ payload, commit }) => commitStorefrontOrderPayload(db, payload, commit)),
    );

    const committed = outcomes.filter((outcome) => outcome.status === "fulfilled");
    expect(committed).toHaveLength(3);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(ValidationError);
    }
    expect(counters()).toEqual({ stock: 3, reserved_stock: 3, stock_version: 4 });
    expect(rows("orders")).toBe(3);
    expect(rows("order_items")).toBe(3);
    // The buyer who took the last unit is the one that moves the public band.
    const transitions = committed.flatMap((outcome) =>
      (outcome as PromiseFulfilledResult<{ availabilityTransitionVariantIds: string[] }>).value.availabilityTransitionVariantIds);
    expect(transitions).toContain("var_1");
  });

  it("releases a cancelled hold exactly once, deducts on ship, and restores on return", async () => {
    const db = openStore(provider, 5);
    const cancelled = prepare("cancel", { quantity: 2 });
    const shipped = prepare("ship", { quantity: 1 });
    await commitStorefrontOrderPayload(db, cancelled.payload, cancelled.commit);
    await commitStorefrontOrderPayload(db, shipped.payload, shipped.commit);
    expect(counters()).toMatchObject({ stock: 5, reserved_stock: 3 });

    await applyInventoryForStatusChange(db, cancelled.payload.orderData.id, "cancelled");
    await applyInventoryForStatusChange(db, cancelled.payload.orderData.id, "cancelled");
    expect(counters()).toMatchObject({ stock: 5, reserved_stock: 1 });
    expect(rows("inventory_movements", `order_id = '${cancelled.payload.orderData.id}' AND type = 'released'`)).toBe(1);

    await applyInventoryForStatusChange(db, shipped.payload.orderData.id, "shipped");
    expect(counters()).toMatchObject({ stock: 4, reserved_stock: 0 });

    await applyInventoryForStatusChange(db, shipped.payload.orderData.id, "returned");
    expect(counters()).toMatchObject({ stock: 5, reserved_stock: 0 });
  });

  it("expires the hold of an unpaid online-payment checkout once", async () => {
    const db = openStore(provider, 2);
    const { payload, commit } = prepare("online", { paymentMethod: "stripe", status: "incomplete" });
    await commitStorefrontOrderPayload(db, payload, commit);
    expect(counters()).toMatchObject({ reserved_stock: 1 });
    // An unpaid online checkout never notifies the merchant.
    expect(rows("notification_outbox")).toBe(0);

    const cutoff = Math.floor(Date.now() / 1000) + 60;
    const first = await archiveStaleIncompleteOrders(db, cutoff);
    const second = await archiveStaleIncompleteOrders(db, cutoff);

    expect(first.archivedOrderIds).toEqual([payload.orderData.id]);
    expect(second.found).toBe(0);
    expect(counters()).toMatchObject({ stock: 2, reserved_stock: 0 });
    expect(rows("inventory_movements", `order_id = '${payload.orderData.id}' AND type = 'released'`)).toBe(1);
  });
});

describe("orders migrated from checkout lanes", () => {
  const migrationSql = readFileSync(
    resolve(import.meta.dirname, "../../../../database/migrations/0065_single_checkout_commit.sql"),
    "utf8",
  );

  it("release and ship through the single reservation model after the fold", async () => {
    sqlite = createMigratedSqlite({ beforeMigration: "0065_" });
    sqlite.exec(`
      INSERT INTO products (id, name, slug, price, is_active) VALUES ('prod_1', 'Tee', 'tee', 100, 1);
      INSERT INTO product_variants (id, product_id, sku, price, stock, is_default, track_inventory)
      VALUES ('var_1', 'prod_1', 'TEE-1', 100, 10, 1, 1);
      INSERT INTO inventory_reservation_lanes (variant_id, pool, lane, capacity, reserved_quantity, version, source_stock_version)
      VALUES ('var_1', 'regular', 0, 5, 2, 1, 1), ('var_1', 'regular', 1, 5, 1, 1, 1);
    `);
    const laneOrder = (id: string, quantity: number, lane: number) => {
      const payload = JSON.stringify({
        schemaVersion: 1,
        checkout: { requestKey: `key_${id}`, requestHash: `hash_${id}`, receiptHash: `receipt_${id}` },
        payload: { orderData: { id, totalAmountMinor: 10_000 * quantity } },
      });
      sqlite!.prepare(`
        INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, total_amount,
          shipping_charge, total_amount_minor, status, payment_method, inventory_pool, inventory_action,
          inventory_authority, checkout_request_key, checkout_request_hash, checkout_receipt_hash,
          checkout_aggregate_version, checkout_aggregate_payload, checkout_inventory_edges,
          checkout_response_payload, checkout_projection_status)
        VALUES (?, 'Lane Buyer', ?, 'House 1', 'city_1', 'zone_1', ?, 0, ?, 'pending', 'cod', 'regular',
          'reserved', 'checkout_lane_v1', ?, ?, ?, 1, ?, ?, '{}', 'complete')
      `).run(id, `+8801700000${lane}0${quantity}`, quantity * 100, quantity * 10_000,
        `key_${id}`, `hash_${id}`, `receipt_${id}`, payload,
        JSON.stringify([{ variantId: "var_1", pool: "regular", lane, quantity }]));
      sqlite!.prepare(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, price, inventory_tracked)
        VALUES (?, ?, 'prod_1', 'var_1', ?, 100, 1)`).run(`item_${id}`, id, quantity);
    };
    laneOrder("lane_cancel", 2, 0);
    laneOrder("lane_ship", 1, 1);
    sqlite.exec(compileSqliteMigrationForProvider(migrationSql, "d1"));
    sqlite.exec(compiledMigrationSql("d1", undefined, "0066_"));
    const db = createSqliteD1Database({ sqlite }).db;
    expect(counters()).toMatchObject({ stock: 10, reserved_stock: 3 });

    await applyInventoryForStatusChange(db, "lane_cancel", "cancelled");
    await applyInventoryForStatusChange(db, "lane_cancel", "cancelled");
    expect(counters()).toMatchObject({ stock: 10, reserved_stock: 1 });

    await applyInventoryForStatusChange(db, "lane_ship", "shipped");
    expect(counters()).toMatchObject({ stock: 9, reserved_stock: 0 });

    // New checkouts use the same counter afterwards.
    const { payload, commit } = prepare("after_fold", { quantity: 9 });
    await commitStorefrontOrderPayload(db, payload, commit);
    expect(counters()).toMatchObject({ stock: 9, reserved_stock: 9 });
  });
});

describe.each(["d1", "turso"] as const)("Wave A lines at the storefront commit (%s)", (provider) => {
  type Payload = StorefrontOrderCommitPayload;
  const withoutAddress = (payload: Payload, kind: "pickup" | null): void => {
    Object.assign(payload.orderData, {
      shippingAddress: null, city: null, zone: null, area: null, cityName: null, zoneName: null,
      requiresShipping: false,
      shippingMethodKind: kind,
      pickupAddress: kind === "pickup" ? "Shop 4, Gulshan 1" : null,
      pickupHours: kind === "pickup" ? "10am-8pm" : null,
    });
  };

  it("commits a pickup order without an address, its line typed pickup", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("pickup");
    withoutAddress(payload, "pickup");
    payload.items[0]!.fulfillmentType = "pickup";
    await commitStorefrontOrderPayload(db, payload, commit);
    const orderId = payload.orderData.id;
    expect(sqlite!.prepare("SELECT requires_shipping, shipping_method_kind, pickup_address, shipping_address FROM orders WHERE id = ?").get(orderId))
      .toEqual({ requires_shipping: 0, shipping_method_kind: "pickup", pickup_address: "Shop 4, Gulshan 1", shipping_address: null });
    expect(sqlite!.prepare("SELECT fulfillment_type, fulfilled_quantity FROM order_items WHERE order_id = ?").get(orderId))
      .toEqual({ fulfillment_type: "pickup", fulfilled_quantity: 0 });
    expect(counters()).toMatchObject({ reserved_stock: 1 });
  });

  it("refuses an order that ships without an address, writing nothing", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("noaddress");
    Object.assign(payload.orderData, { shippingAddress: null, city: null, zone: null });
    await expect(commitStorefrontOrderPayload(db, payload, commit)).rejects.toThrow(/shipping address required/);
    expect(rows("orders")).toBe(0);
    expect(counters()).toMatchObject({ reserved_stock: 0 });
  });

  it("commits a service-only order with no delivery method and no fee", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("service");
    withoutAddress(payload, null);
    payload.items[0]!.fulfillmentType = "service";
    await commitStorefrontOrderPayload(db, payload, commit);
    expect(sqlite!.prepare("SELECT requires_shipping, shipping_method_kind, shipping_method_id FROM orders WHERE id = ?").get(payload.orderData.id))
      .toEqual({ requires_shipping: 0, shipping_method_kind: null, shipping_method_id: null });
    expect(sqlite!.prepare("SELECT fulfillment_type FROM order_items WHERE order_id = ?").get(payload.orderData.id))
      .toEqual({ fulfillment_type: "service" });
  });

  it("freezes buyer inputs, their surcharge and the base price on the line", async () => {
    const db = openStore(provider);
    const { payload, commit } = prepare("props");
    const properties = [{ key: "engraving", type: "text", label: "Engraving", value: "Anika", displayValue: "Anika", priceMinor: 2_000 }];
    Object.assign(payload.items[0]!, {
      properties: JSON.stringify(properties),
      propertiesPriceMinor: 2_000,
      baseUnitPriceMinor: 8_000,
    });
    await commitStorefrontOrderPayload(db, payload, commit);
    const line = sqlite!.prepare(
      "SELECT properties, properties_price_minor, base_unit_price_minor, unit_price_minor FROM order_items WHERE order_id = ?",
    ).get(payload.orderData.id) as { properties: string; properties_price_minor: number; base_unit_price_minor: number; unit_price_minor: number };
    expect(JSON.parse(line.properties)).toEqual(properties);
    expect(line).toMatchObject({ properties_price_minor: 2_000, base_unit_price_minor: 8_000, unit_price_minor: 10_000 });
  });
});
