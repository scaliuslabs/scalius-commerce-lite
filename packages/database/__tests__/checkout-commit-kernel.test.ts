import type { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildCheckoutCommitStatements,
  buildCheckoutReservationLaneSnapshotStatement,
  buildEnsureCheckoutReservationLanesStatement,
  buildExistingCheckoutIdentityStatement,
  buildRebalanceCheckoutReservationLanesStatements,
  type CheckoutCommittedOrderRow,
  type PortableSqlStatement,
  type PreparedCheckoutCommit,
} from "../src/checkout-commit";
import { buildCheckoutProjectionStatements } from "../src/checkout-projection";
import { createProviderSchemaDatabase } from "../scripts/sqlite-provider-schema";

function executeRun(database: DatabaseSync, statement: PortableSqlStatement): void {
  database.prepare(statement.sql).run(...statement.args);
}

function executeAll<T extends Record<string, unknown>>(
  database: DatabaseSync,
  statement: PortableSqlStatement,
): T[] {
  return database.prepare(statement.sql).all(...statement.args) as T[];
}

function executeCommitBatch(
  database: DatabaseSync,
  commits: readonly PreparedCheckoutCommit[],
  outboxId: string,
): void {
  const statements = buildCheckoutCommitStatements(commits, outboxId);
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) {
      if (/\bSELECT CASE\b/i.test(statement.sql)) executeAll(database, statement);
      else executeRun(database, statement);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function orderRow(id: string): CheckoutCommittedOrderRow {
  return {
    id,
    customerName: `Customer ${id}`,
    customerPhone: `+8801700${id.slice(-6).padStart(6, "0")}`,
    customerEmail: `${id}@invalid.example`,
    shippingAddress: "123 Test Road",
    city: "city_1",
    zone: "zone_1",
    area: null,
    cityName: "Dhaka",
    zoneName: "Dhanmondi",
    areaName: null,
    totalAmount: 101,
    shippingCharge: 1,
    discountAmount: 0,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    subtotalAmountMinor: 10_000,
    shippingAmountMinor: 100,
    shippingMethodId: "shipping_standard",
    shippingMethodName: "Standard delivery",
    shippingMethodDescription: null,
    shippingMethodBaseAmountMinor: 100,
    shippingFeeWaived: false,
    discountAmountMinor: 0,
    taxAmountMinor: 0,
    totalAmountMinor: 10_100,
    taxLabel: "Tax",
    pricesIncludeTax: false,
    status: "pending",
    notes: null,
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    paidAmount: 0,
    balanceDue: 101,
    fulfillmentStatus: "pending",
    inventoryPool: "regular",
    inventoryAction: "reserved",
    customerId: null,
    accountOwnerCustomerId: null,
  };
}

function commit(options: {
  id: string;
  variantId?: string;
  lane?: number;
  quantity?: number;
  reservedBefore?: number;
  laneVersionBefore?: number;
  requestHash?: string;
  authorityRevision?: number;
}): PreparedCheckoutCommit {
  const lane = options.lane ?? 0;
  const quantity = options.quantity ?? 1;
  const reservedBefore = options.reservedBefore ?? 0;
  const laneVersionBefore = options.laneVersionBefore ?? 0;
  const order = orderRow(options.id);
  const requestKey = `checkout_submit:v1:${options.id}`;
  const requestHash = options.requestHash ?? `hash_${options.id}`;
  const receiptHash = `receipt_${options.id}`;
  const authorityRevision = options.authorityRevision ?? 3;
  const response = { orderId: options.id, receiptToken: `proof_${options.id}` };
  const {
    customerId: _customerId,
    accountOwnerCustomerId: _accountOwnerCustomerId,
    ...orderData
  } = order;
  const payload = {
    checkoutToken: `proof_${options.id}`,
    existingCustomer: null,
    orderData,
    items: [{
      id: `item_${options.id}`,
      taxAllocationLineId: `line_${options.id}`,
      productId: "product_hot",
      variantId: options.variantId ?? "variant_hot",
      quantity,
      price: 100,
      productName: "Hot product",
      variantLabel: null,
      inventoryTracked: true,
      productImageMediaId: null,
      unitPriceMinor: 10_000,
      lineSubtotalMinor: 10_000 * quantity,
      discountAmountMinor: 0,
      taxableAmountMinor: 10_000 * quantity,
      taxAmountMinor: 0,
    }],
    taxQuote: {
      schemaVersion: 1,
      calculationVersion: "tax-v1",
      enabled: false,
      currencyCode: "BDT",
      decimalPlaces: 2,
      displayLabel: "Tax",
      pricesIncludeTax: false,
      shippingTaxed: false,
      settingsVersion: 1,
      subtotalMinor: 10_000,
      shippingMinor: 100,
      discountMinor: 0,
      taxableMinor: 10_000,
      taxMinor: 0,
      totalMinor: order.totalAmountMinor,
      destination: { city: "city_1", zone: "zone_1", area: null },
      lines: [{
        lineId: `line_${options.id}`,
        productId: "product_hot",
        variantId: options.variantId ?? "variant_hot",
        taxClassId: null,
        taxClassName: null,
        unitPriceMinor: 10_000,
        quantity,
        grossAmountMinor: 10_000 * quantity,
        discountMinor: 0,
        taxableAmountMinor: 10_000 * quantity,
        taxMinor: 0,
        totalMinor: 10_000 * quantity,
        components: [],
      }],
      shipping: {
        taxClassId: null,
        taxClassName: null,
        grossAmountMinor: 100,
        discountMinor: 0,
        taxableAmountMinor: 100,
        taxMinor: 0,
        totalMinor: 100,
        components: [],
      },
    },
  };
  return {
    requestKey,
    requestHash,
    receiptHash,
    authorityRevision,
    lane,
    order,
    response,
    aggregate: {
      schemaVersion: 1,
      checkout: { requestKey, requestHash, receiptHash, authorityRevision, response },
      payload,
      projection: {
        checkoutAttemptId: `coa_${options.id}`,
        guestCustomerId: `customer_${options.id}`,
        customerHistoryId: `history_${options.id}`,
        codTrackingId: `cod_${options.id}`,
        notificationOutboxId: `notification_${options.id}`,
        metaPurchaseOutboxId: `meta_${options.id}`,
      },
    },
    edges: [{
      variantId: options.variantId ?? "variant_hot",
      pool: "regular",
      lane,
      quantity,
      capacity: 4,
      reservedBefore,
      reservedAfter: reservedBefore + quantity,
      laneVersionBefore,
      laneVersionAfter: laneVersionBefore + 1,
      sourceStockVersion: 1,
    }],
  };
}

describe("checkout aggregate commit kernel", () => {
  let database: DatabaseSync;

  beforeEach(async () => {
    database = await createProviderSchemaDatabase("d1");
    database.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO products (id, name, price, slug, is_active)
      VALUES ('product_hot', 'Hot product', 100, 'hot-product', 1);
      INSERT INTO product_variants (
        id, product_id, sku, price, stock, reserved_stock,
        stock_version, track_inventory, is_default
      ) VALUES (
        'variant_hot', 'product_hot', 'HOT-1', 100, 10, 2,
        1, 1, 1
      );
    `);
  });

  afterEach(() => database.close());

  it("keeps legacy reservations separate and splits only remaining capacity", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const rows = executeAll<{
      lane: number;
      capacity: number;
      reservedQuantity: number;
      laneVersion: number;
      sourceStockVersion: number;
    }>(database, buildCheckoutReservationLaneSnapshotStatement(["variant_hot"]));

    expect(rows).toEqual([
      expect.objectContaining({
        lane: 0,
        capacity: 4,
        reservedQuantity: 0,
        laneVersion: 0,
        sourceStockVersion: 1,
      }),
      expect.objectContaining({
        lane: 1,
        capacity: 4,
        reservedQuantity: 0,
        laneVersion: 0,
        sourceStockVersion: 1,
      }),
    ]);
    expect(rows.reduce((sum, row) => sum + row.capacity, 0)).toBe(8);
  });

  it("rebalances only coordinated capacity while legacy reservations remain", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const statements = buildRebalanceCheckoutReservationLanesStatements([{
      variantId: "variant_hot",
      targetLane: 0,
      sourceStockVersion: 1,
      lanes: [
        { capacity: 4, reservedQuantity: 0, laneVersion: 0 },
        { capacity: 4, reservedQuantity: 0, laneVersion: 0 },
      ],
    }]);

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of statements) {
        if (/\bSELECT CASE\b/i.test(statement.sql)) executeAll(database, statement);
        else executeRun(database, statement);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    expect(database.prepare(`
      SELECT lane, capacity, reserved_quantity AS reservedQuantity
      FROM inventory_reservation_lanes
      WHERE variant_id = 'variant_hot' AND pool = 'regular'
      ORDER BY lane
    `).all()).toEqual([
      { lane: 0, capacity: 8, reservedQuantity: 0 },
      { lane: 1, capacity: 0, reservedQuantity: 0 },
    ]);
  });

  it("rejects a stale economic authority snapshot before writing the order or inventory", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const stale = commit({ id: "order_stale_authority" });
    database.prepare(`
      UPDATE checkout_authority
      SET revision = revision + 1, updated_at = unixepoch()
      WHERE id = 'default'
    `).run();

    expect(() => executeCommitBatch(database, [stale], "batch_stale_authority"))
      .toThrow(/CHECKOUT_AUTHORITY_CHANGED/i);
    expect(database.prepare(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE id = 'order_stale_authority') AS orders,
        (SELECT SUM(reserved_quantity) FROM inventory_reservation_lanes
         WHERE variant_id = 'variant_hot') AS reserved
    `).get()).toEqual({ orders: 0, reserved: 0 });
  });

  it("synchronizes lane capacity when legacy inventory counters change", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    database.exec(`
      UPDATE product_variants
      SET reserved_stock = reserved_stock + 2,
          stock_version = stock_version + 1
      WHERE id = 'variant_hot';
    `);

    expect(database.prepare(`
      SELECT
        SUM(capacity) AS capacity,
        SUM(reserved_quantity) AS coordinatedReserved,
        MIN(source_stock_version) AS minVersion,
        MAX(source_stock_version) AS maxVersion
      FROM inventory_reservation_lanes
      WHERE variant_id = 'variant_hot' AND pool = 'regular'
    `).get()).toEqual({
      capacity: 6,
      coordinatedReserved: 0,
      minVersion: 2,
      maxVersion: 2,
    });
  });

  it("commits complete aggregates, exact lane edges, and one batch outbox atomically", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const commits = [
      commit({ id: "order_1", reservedBefore: 0, laneVersionBefore: 0 }),
      commit({
        id: "order_2",
        quantity: 2,
        reservedBefore: 1,
        laneVersionBefore: 1,
      }),
    ];

    executeCommitBatch(database, commits, "batch_1");

    expect(database.prepare(`
      SELECT reserved_quantity AS reserved, version
      FROM inventory_reservation_lanes
      WHERE variant_id = 'variant_hot' AND pool = 'regular' AND lane = 0
    `).get()).toEqual({ reserved: 3, version: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM orders WHERE checkout_aggregate_version = 1
    `).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM orders
      WHERE checkout_aggregate_version = 1
        AND inventory_authority = 'checkout_lane_v1'
    `).get()).toEqual({ count: 2 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM checkout_attempts
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT COUNT(*) AS count FROM order_items
    `).get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT order_ids AS orderIds, status FROM checkout_batch_outbox WHERE id = 'batch_1'
    `).get()).toEqual({ orderIds: '["order_1","order_2"]', status: "pending" });

    const replayRows = executeAll<{
      requestKey: string;
      requestHash: string;
      orderId: string;
      responsePayload: string;
    }>(database, buildExistingCheckoutIdentityStatement(commits.map((value) => value.requestKey)));
    expect(replayRows).toHaveLength(2);
    expect(JSON.parse(replayRows[0]!.responsePayload)).toMatchObject({ orderId: "order_1" });
  });

  it("commits authenticated ownership independently from the delivery phone", () => {
    database.prepare(`
      INSERT INTO customers (id, name, phone, account_claimed_at)
      VALUES ('customer_account', 'Account owner', '+8801711111111', unixepoch())
    `).run();
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const authenticated = commit({ id: "order_authenticated" });
    authenticated.order.customerId = "customer_account";
    authenticated.order.accountOwnerCustomerId = "customer_account";
    (authenticated.aggregate.payload as {
      existingCustomer: { id: string } | null;
    }).existingCustomer = { id: "customer_account" };
    authenticated.aggregate.projection!.guestCustomerId = null;
    authenticated.aggregate.projection!.customerHistoryId = null;

    executeCommitBatch(database, [authenticated], "batch_authenticated");

    expect(database.prepare(`
      SELECT customer_id AS customerId,
             account_owner_customer_id AS accountOwnerCustomerId,
             customer_phone AS customerPhone
      FROM orders WHERE id = 'order_authenticated'
    `).get()).toEqual({
      customerId: "customer_account",
      accountOwnerCustomerId: "customer_account",
      customerPhone: authenticated.order.customerPhone,
    });
  });

  it("binds the aggregate once and omits empty inventory lane statements", () => {
    const untracked = commit({ id: "order_untracked" });
    untracked.edges = [];
    untracked.order.inventoryAction = "none";
    (untracked.aggregate.payload as { orderData: { inventoryAction: string } })
      .orderData.inventoryAction = "none";

    const statements = buildCheckoutCommitStatements([untracked], "batch_untracked");
    expect(statements).toHaveLength(3);
    expect(String(statements[0]?.args[0])).not.toContain("Customer order_untracked");
    expect(String(statements[1]?.args[0])).toContain("Customer order_untracked");
    executeCommitBatch(database, [untracked], "batch_untracked");

    expect(database.prepare(`
      SELECT inventory_action AS inventoryAction,
             checkout_projection_status AS projectionStatus
      FROM orders WHERE id = 'order_untracked'
    `).get()).toEqual({ inventoryAction: "none", projectionStatus: "pending" });
    expect(database.prepare(`
      SELECT status FROM checkout_batch_outbox WHERE id = 'batch_untracked'
    `).get()).toEqual({ status: "pending" });
  });

  it("rolls the whole microbatch back when a lane snapshot is stale", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const stale = commit({
      id: "order_stale",
      reservedBefore: 1,
      laneVersionBefore: 0,
    });

    expect(() => executeCommitBatch(database, [stale], "batch_stale"))
      .toThrow(/CHECKOUT_RESERVATION_CONFLICT/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM checkout_batch_outbox").get()).toEqual({ count: 0 });
    expect(database.prepare(`
      SELECT reserved_quantity AS reserved, version
      FROM inventory_reservation_lanes
      WHERE variant_id = 'variant_hot' AND lane = 0
    `).get()).toEqual({ reserved: 0, version: 0 });
  });

  it("keeps uncertain retries idempotent and leaves the ledger unchanged", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    const first = commit({ id: "order_retry" });
    executeCommitBatch(database, [first], "batch_retry_1");

    expect(() => executeCommitBatch(database, [first], "batch_retry_2"))
      .toThrow(/CHECKOUT_RESERVATION_CONFLICT/i);
    expect(database.prepare(`
      SELECT COUNT(*) AS orders,
             (SELECT reserved_quantity FROM inventory_reservation_lanes
              WHERE variant_id = 'variant_hot' AND lane = 0) AS reserved
      FROM orders
    `).get()).toEqual({ orders: 1, reserved: 1 });
  });

  it("rejects aggregate mutation and variant deletion after commit", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    executeCommitBatch(database, [commit({ id: "order_guard" })], "batch_guard");

    expect(() => database.exec(`
      UPDATE orders SET checkout_request_hash = 'changed' WHERE id = 'order_guard';
    `)).toThrow(/CHECKOUT_AGGREGATE_IMMUTABLE/);
    expect(() => database.exec(`
      DELETE FROM product_variants WHERE id = 'variant_hot';
    `)).toThrow(/CHECKOUT_VARIANT_HAS_LEDGER_HISTORY/);
  });

  it("projects every normalized COD fact once and replays without double-counting", () => {
    executeRun(database, buildEnsureCheckoutReservationLanesStatement(["variant_hot"]));
    executeCommitBatch(database, [commit({ id: "order_projection" })], "batch_projection");
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM orders_fts
      WHERE orders_fts MATCH 'projection'
    `).get()).toEqual({ count: 0 });
    const projection = buildCheckoutProjectionStatements("batch_projection");

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of projection) {
        if (/\bSELECT CASE WHEN\b/i.test(statement.sql)) executeAll(database, statement);
        else executeRun(database, statement);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }

    expect(database.prepare(`
      SELECT checkout_projection_status AS projectionStatus, customer_id AS customerId
      FROM orders WHERE id = 'order_projection'
    `).get()).toEqual({
      projectionStatus: "complete",
      customerId: "customer_order_projection",
    });
    expect(database.prepare(`
      SELECT total_orders AS totalOrders, total_spent AS totalSpent
      FROM customers WHERE id = 'customer_order_projection'
    `).get()).toEqual({ totalOrders: 1, totalSpent: 0 });
    for (const table of [
      "checkout_attempts",
      "order_receipts",
      "order_items",
      "order_tax_snapshots",
      "order_item_tax_snapshots",
      "cod_tracking",
      "order_notification_outbox",
      "meta_capi_purchase_outbox",
    ]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(), table)
        .toEqual({ count: 1 });
    }
    expect(database.prepare(`
      SELECT status FROM checkout_batch_outbox WHERE id = 'batch_projection'
    `).get()).toEqual({ status: "complete" });
    expect(database.prepare(`
      SELECT COUNT(*) AS count
      FROM orders_fts
      WHERE orders_fts MATCH 'projection'
    `).get()).toEqual({ count: 1 });

    // A lost projector response is harmless: a completed outbox has no target
    // rows, so no customer aggregate or normalized fact changes again.
    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of projection) {
        if (/\bSELECT CASE WHEN\b/i.test(statement.sql)) executeAll(database, statement);
        else executeRun(database, statement);
      }
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    expect(database.prepare(`
      SELECT total_orders AS totalOrders FROM customers
      WHERE id = 'customer_order_projection'
    `).get()).toEqual({ totalOrders: 1 });
  });

  it("rejects malformed in-memory edges before any database call", () => {
    const malformed = commit({ id: "order_malformed" });
    malformed.edges[0]!.reservedAfter += 1;
    expect(() => buildCheckoutCommitStatements([malformed], "batch_malformed"))
      .toThrow(/not one exact finite reservation edge/i);
  });
});
