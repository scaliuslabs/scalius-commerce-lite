import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileSqliteMigrationForProvider } from "../src/migration-artifacts";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Draft migration files: the lead moves them into migrations/ (and the
// PostgreSQL sidecar directory) under the next number and points these paths
// at them.
const d1MigrationSql = readFileSync(
  resolve(import.meta.dirname, "../migrations/0065_single_checkout_commit.sql"),
  "utf8",
);
const postgresMigrationSql = readFileSync(
  resolve(import.meta.dirname, "../migrations/postgres/0065_single_checkout_commit.sql"),
  "utf8",
);

type Row = Record<string, unknown>;
type Provider = "d1" | "turso" | "postgres";

/** The fixture and assertions speak one SQL subset against every provider. */
interface Store {
  run(sql: string, ...params: SQLInputValue[]): Promise<void>;
  all(sql: string, ...params: SQLInputValue[]): Promise<Row[]>;
  migrate(): Promise<void>;
  /** Names from `candidates` that still exist as tables, triggers, or functions. */
  existingObjects(candidates: readonly string[]): Promise<string[]>;
  orderColumns(): Promise<string[]>;
  close(): Promise<void>;
}

function sqliteStore(provider: "d1" | "turso"): Store {
  const sqlite: DatabaseSync = createMigratedSqlite({ provider, beforeMigration: "0065_" });
  return {
    async run(sql, ...params) { sqlite.prepare(sql).run(...params); },
    async all(sql, ...params) { return sqlite.prepare(sql).all(...params) as Row[]; },
    async migrate() {
      // D1 applies one migration file as one transaction.
      sqlite.exec("BEGIN");
      try {
        sqlite.exec(compileSqliteMigrationForProvider(d1MigrationSql, provider));
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async existingObjects(candidates) {
      return sqlite.prepare(
        `SELECT name FROM sqlite_schema WHERE name IN (${candidates.map(() => "?").join(", ")})`,
      ).all(...candidates).map((row) => String(row.name));
    },
    async orderColumns() {
      return sqlite.prepare("PRAGMA table_info(orders)").all().map((row) => String(row.name));
    },
    async close() { sqlite.close(); },
  };
}

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. Each test
// creates and drops its own database there.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
let postgresSchema: Promise<string> | undefined;

async function postgresStore(): Promise<Store> {
  postgresSchema ??= compileCanonicalPostgresSchema().then((bundle) => bundle.sql);
  const name = `scalius_migration_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({
    connectionString: url.toString(),
    // bigint columns as numbers, as the runtime adapter reads them.
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
    },
  });
  await client.connect();
  await client.query(await postgresSchema);
  const positional = (sql: string) => {
    let index = 0;
    return sql.replace(/\?/g, () => `$${++index}`);
  };
  return {
    async run(sql, ...params) { await client.query(positional(sql), params); },
    async all(sql, ...params) { return (await client.query(positional(sql), params)).rows; },
    async migrate() {
      await client.query("BEGIN");
      try {
        for (const statement of postgresMigrationSql.split("--> statement-breakpoint")) {
          if (statement.trim()) await client.query(statement);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    },
    async existingObjects(candidates) {
      const { rows } = await client.query(`
        SELECT relname AS name FROM pg_class WHERE relname = ANY($1)
        UNION SELECT tgname FROM pg_trigger WHERE tgname = ANY($1)
        UNION SELECT proname FROM pg_proc WHERE proname = ANY($1)
      `, [candidates]);
      return rows.map((row) => String(row.name));
    },
    async orderColumns() {
      const { rows } = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'orders'",
      );
      return rows.map((row) => String(row.column_name));
    },
    async close() {
      await client.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    },
  };
}

const openStores: Store[] = [];
afterAll(async () => { await Promise.all(openStores.map((store) => store.close())); });

async function one(store: Store, sql: string, ...params: SQLInputValue[]): Promise<Row | undefined> {
  return (await store.all(sql, ...params))[0];
}

async function count(store: Store, sql: string, ...params: SQLInputValue[]): Promise<number> {
  return Number((await one(store, sql, ...params))?.count);
}

async function variant(store: Store, id: string) {
  const row = (await one(store, "SELECT stock, reserved_stock, stock_version FROM product_variants WHERE id = ?", id))!;
  return {
    stock: Number(row.stock),
    reserved_stock: Number(row.reserved_stock),
    stock_version: Number(row.stock_version),
  };
}

function aggregatePayload(orderId: string, items: Array<{ variantId: string; quantity: number }>) {
  const lines = items.map((item, index) => ({
    lineId: `line_${orderId}_${index}`,
    taxClassId: null,
    taxClassName: null,
    unitPriceMinor: 10_000,
    quantity: item.quantity,
    grossAmountMinor: 10_000 * item.quantity,
    discountMinor: 0,
    taxableAmountMinor: 0,
    taxMinor: 0,
    components: [],
  }));
  const subtotalMinor = lines.reduce((sum, line) => sum + line.grossAmountMinor, 0);
  return {
    schemaVersion: 1,
    checkout: {
      requestKey: `checkout_submit:v1:${orderId}`,
      requestHash: `hash_${orderId}`,
      receiptHash: `receipt_${orderId}`,
      authorityRevision: 1,
      response: { orderId, receiptToken: `chk_${orderId}` },
    },
    payload: {
      checkoutToken: `chk_${orderId}`,
      orderData: { id: orderId, totalAmountMinor: subtotalMinor },
      items: items.map((item, index) => ({
        id: `item_${orderId}_${index}`,
        productId: "prod_1",
        variantId: item.variantId,
        productImageMediaId: null,
        quantity: item.quantity,
        price: 100,
        productName: "Lane product",
        variantLabel: null,
        inventoryTracked: true,
        unitPriceMinor: 10_000,
        lineSubtotalMinor: 10_000 * item.quantity,
        discountAmountMinor: 0,
        taxableAmountMinor: 0,
        taxAmountMinor: 0,
        taxAllocationLineId: `line_${orderId}_${index}`,
      })),
      taxQuote: {
        currencyCode: "BDT",
        decimalPlaces: 2,
        displayLabel: "Tax",
        pricesIncludeTax: false,
        shippingTaxed: false,
        subtotalMinor,
        shippingMinor: 0,
        discountMinor: 0,
        taxableMinor: 0,
        taxMinor: 0,
        totalMinor: subtotalMinor,
        settingsVersion: 0,
        calculationVersion: "tax-v1",
        destination: { city: "city_1", zone: "zone_1", area: null },
        lines,
        shipping: { taxMinor: 0 },
      },
    },
    projection: {
      checkoutAttemptId: `coa_${orderId}`,
      guestCustomerId: `cust_${orderId}`,
      customerHistoryId: `hist_${orderId}`,
      codTrackingId: `cod_${orderId}`,
      notificationOutboxId: `ono_${orderId}`,
      metaPurchaseOutboxId: null,
    },
  };
}

/**
 * Rows exactly as the retired coordinator wrote them: an aggregate order with
 * lane edges, the lane counters, and (for pending orders) no projection yet.
 */
async function insertLaneOrder(
  store: Store,
  orderId: string,
  edges: Array<{ variantId: string; quantity: number; lane: number }>,
  projection: "pending" | "complete",
) {
  const payload = aggregatePayload(orderId, edges);
  const total = payload.payload.orderData.totalAmountMinor;
  await store.run(`
    INSERT INTO orders (
      id, customer_name, customer_phone, shipping_address, city, zone,
      total_amount, shipping_charge, total_amount_minor, status, payment_method,
      inventory_pool, inventory_action, inventory_authority,
      checkout_request_key, checkout_request_hash, checkout_receipt_hash,
      checkout_aggregate_version, checkout_aggregate_payload, checkout_inventory_edges,
      checkout_response_payload, checkout_projection_status, created_at, updated_at
    ) VALUES (?, 'Lane Buyer', ?, 'House 1, Road 2', 'city_1', 'zone_1', ?, 0, ?, 'pending', 'cod',
      'regular', 'reserved', 'checkout_lane_v1', ?, ?, ?, 1, ?, ?, ?, ?, 1700000000, 1700000000)
  `,
    orderId,
    `+88017${orderId.replace(/\D/g, "").padStart(8, "0")}`,
    total / 100,
    total,
    payload.checkout.requestKey,
    payload.checkout.requestHash,
    payload.checkout.receiptHash,
    JSON.stringify(payload),
    JSON.stringify(edges.map((edge) => ({ ...edge, pool: "regular" }))),
    JSON.stringify(payload.checkout.response),
    projection,
  );
  for (const edge of edges) {
    await store.run(`
      UPDATE inventory_reservation_lanes
      SET reserved_quantity = reserved_quantity + ?, version = version + 1
      WHERE variant_id = ? AND pool = 'regular' AND lane = ?
    `, edge.quantity, edge.variantId, edge.lane);
  }
  if (projection === "complete") {
    for (const [index, edge] of edges.entries()) {
      await store.run(`
        INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, price, inventory_tracked, created_at)
        VALUES (?, ?, 'prod_1', ?, ?, 100, 1, 1700000000)
      `, `item_${orderId}_${index}`, orderId, edge.variantId, edge.quantity);
    }
  }
}

/** A lane hold consumed before the migration: terminal lane edge (+ stock edge when shipped). */
async function closeLaneOrder(
  store: Store,
  orderId: string,
  edge: { variantId: string; quantity: number; lane: number },
  operation: "released" | "deducted",
) {
  const lane = (await one(
    store,
    "SELECT capacity, reserved_quantity, version FROM inventory_reservation_lanes WHERE variant_id = ? AND lane = ?",
    edge.variantId,
    edge.lane,
  ))!;
  const sku = await variant(store, edge.variantId);
  const deducted = operation === "deducted";
  await store.run(`
    INSERT INTO checkout_inventory_lane_movements (
      id, order_id, variant_id, pool, lane, operation, quantity,
      lane_capacity_before, lane_reserved_before, lane_reserved_after,
      lane_version_before, lane_version_after,
      source_stock_version_before, source_stock_version_after,
      stock_before, stock_after, legacy_reserved_stock_before, legacy_reserved_stock_after, created_at
    ) VALUES (?, ?, ?, 'regular', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1700000100)
  `,
    `lane_terminal_${orderId}`, orderId, edge.variantId, edge.lane, operation, edge.quantity,
    Number(lane.capacity), Number(lane.reserved_quantity), Number(lane.reserved_quantity) - edge.quantity,
    Number(lane.version), Number(lane.version) + 1,
    sku.stock_version, sku.stock_version + (deducted ? 1 : 0),
    sku.stock, sku.stock - (deducted ? edge.quantity : 0),
    sku.reserved_stock, sku.reserved_stock,
  );
  if (deducted) {
    await store.run(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock, notes,
        ledger_version, pool, reservation_generation, stock_version_before, stock_version_after,
        stock_delta, previous_reserved_stock, new_reserved_stock, reserved_stock_delta,
        previous_preorder_stock, new_preorder_stock, preorder_stock_delta, created_at
      ) VALUES (?, ?, ?, 'deducted', ?, ?, ?, 'lane ship', 2, 'regular', 1, ?, ?, ?, ?, ?, 0, 0, 0, 0, 1700000100)
    `,
      `checkout_lane_stock_v1:${orderId}`, edge.variantId, orderId, edge.quantity,
      sku.stock, sku.stock - edge.quantity,
      sku.stock_version, sku.stock_version + 1, -edge.quantity,
      sku.reserved_stock, sku.reserved_stock,
    );
    await store.run(
      "UPDATE product_variants SET stock = stock - ?, stock_version = stock_version + 1 WHERE id = ?",
      edge.quantity,
      edge.variantId,
    );
  }
  await store.run(
    "UPDATE inventory_reservation_lanes SET reserved_quantity = reserved_quantity - ?, version = version + 1 WHERE variant_id = ? AND lane = ?",
    edge.quantity,
    edge.variantId,
    edge.lane,
  );
  await store.run(
    "UPDATE orders SET inventory_action = ?, status = ? WHERE id = ?",
    deducted ? "deducted" : "restored",
    deducted ? "shipped" : "cancelled",
    orderId,
  );
}

async function populatedStore(provider: Provider): Promise<Store> {
  const store = provider === "postgres" ? await postgresStore() : sqliteStore(provider);
  openStores.push(store);
  await store.run(`
    INSERT INTO products (id, name, slug, price, is_active)
    VALUES ('prod_1', 'Lane product', 'lane-product', 100, 1), ('prod_2', 'Cold product', 'cold-product', 100, 1)
  `);
  await store.run(`
    INSERT INTO product_variants (id, product_id, sku, price, stock, reserved_stock, stock_version, is_default, track_inventory)
    VALUES ('var_hot', 'prod_1', 'LANE-HOT', 100, 10, 0, 1, 1, 1),
           ('var_cold', 'prod_2', 'LANE-COLD', 100, 5, 1, 1, 1, 1)
  `);
  await store.run(`
    INSERT INTO inventory_reservation_lanes (variant_id, pool, lane, capacity, reserved_quantity, version, source_stock_version)
    VALUES ('var_hot', 'regular', 0, 5, 0, 0, 1), ('var_hot', 'regular', 1, 5, 0, 0, 1),
           ('var_cold', 'regular', 0, 2, 0, 0, 1), ('var_cold', 'regular', 1, 2, 0, 0, 1)
  `);
  // Outstanding holds: A (projection still pending) and B (projected).
  await insertLaneOrder(store, "order_a1", [{ variantId: "var_hot", quantity: 2, lane: 0 }], "pending");
  await insertLaneOrder(store, "order_b2", [
    { variantId: "var_hot", quantity: 1, lane: 1 },
    { variantId: "var_cold", quantity: 1, lane: 0 },
  ], "complete");
  // Closed holds: C shipped, D cancelled.
  await insertLaneOrder(store, "order_c3", [{ variantId: "var_hot", quantity: 1, lane: 1 }], "complete");
  await closeLaneOrder(store, "order_c3", { variantId: "var_hot", quantity: 1, lane: 1 }, "deducted");
  await insertLaneOrder(store, "order_d4", [{ variantId: "var_cold", quantity: 1, lane: 1 }], "complete");
  await closeLaneOrder(store, "order_d4", { variantId: "var_cold", quantity: 1, lane: 1 }, "released");
  await store.run("INSERT INTO checkout_batch_outbox (id, order_ids) VALUES ('cbo_1', ?)", JSON.stringify(["order_a1"]));
  return store;
}

const providers = (["d1", "turso", "postgres"] as const).filter(
  (provider) => provider !== "postgres" || Boolean(postgresUrl),
);

describe.each(providers)("single checkout commit migration (%s)", (provider) => {
  it("folds outstanding lane holds into SKU counters with one ledger-v2 edge each", async () => {
    const store = await populatedStore(provider);
    const hotBefore = await variant(store, "var_hot");
    const coldBefore = await variant(store, "var_cold");

    await store.migrate();

    // A (2) and B (1) still hold var_hot; B holds var_cold on top of 1 legacy unit.
    expect(await variant(store, "var_hot")).toEqual({
      stock: hotBefore.stock,
      reserved_stock: hotBefore.reserved_stock + 3,
      stock_version: hotBefore.stock_version + 2,
    });
    expect(await variant(store, "var_cold")).toEqual({
      stock: coldBefore.stock,
      reserved_stock: coldBefore.reserved_stock + 1,
      stock_version: coldBefore.stock_version + 1,
    });
    expect(await store.all(`
      SELECT variant_id, order_id, quantity, stock_version_before, stock_version_after,
        previous_reserved_stock, new_reserved_stock, reservation_generation
      FROM inventory_movements WHERE id LIKE 'lane-fold:%' ORDER BY variant_id, stock_version_after
    `)).toEqual([
      { variant_id: "var_cold", order_id: "order_b2", quantity: 1, stock_version_before: 1, stock_version_after: 2,
        previous_reserved_stock: 1, new_reserved_stock: 2, reservation_generation: 1 },
      { variant_id: "var_hot", order_id: "order_a1", quantity: 2, stock_version_before: 2, stock_version_after: 3,
        previous_reserved_stock: 0, new_reserved_stock: 2, reservation_generation: 1 },
      { variant_id: "var_hot", order_id: "order_b2", quantity: 1, stock_version_before: 3, stock_version_after: 4,
        previous_reserved_stock: 2, new_reserved_stock: 3, reservation_generation: 1 },
    ]);
  });

  it("materializes the pending projection so order items exist without a recovery job", async () => {
    const store = await populatedStore(provider);
    await store.migrate();

    for (const table of [
      "order_items", "order_item_tax_snapshots", "order_tax_snapshots", "cod_tracking", "order_notification_outbox",
    ]) {
      expect(await count(store, `SELECT COUNT(*) AS count FROM ${table} WHERE order_id = 'order_a1'`), table).toBe(1);
    }
    expect(await one(store, "SELECT status, order_id FROM checkout_attempts WHERE request_key = 'checkout_submit:v1:order_a1'"))
      .toEqual({ status: "committed", order_id: "order_a1" });
    expect(await one(store, "SELECT order_id, status FROM order_receipts WHERE token_hash = 'receipt_order_a1'"))
      .toEqual({ order_id: "order_a1", status: "active" });
    expect(await one(store, "SELECT customer_id FROM orders WHERE id = 'order_a1'"))
      .toEqual({ customer_id: "cust_order_a1" });
    // Already projected orders are not duplicated.
    expect(await count(store, "SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'order_b2'")).toBe(2);
    if (provider === "d1") {
      // Pending aggregates were never indexed; they are searchable now.
      expect(await store.all("SELECT rowid FROM orders_fts WHERE orders_fts MATCH 'customer_phone:8801700000001'"))
        .toEqual(await store.all("SELECT rowid FROM orders WHERE id = 'order_a1'"));
    }
  });

  it("keeps closed lane holds in the ledger as non-foldable history that nets to zero", async () => {
    const store = await populatedStore(provider);
    await store.migrate();

    expect(await store.all(`
      SELECT order_id, type, quantity, ledger_version, pool, reservation_generation
      FROM inventory_movements WHERE order_id IN ('order_c3', 'order_d4') ORDER BY order_id, type
    `)).toEqual([
      { order_id: "order_c3", type: "deducted", quantity: 1, ledger_version: 2, pool: "regular", reservation_generation: 1 },
      { order_id: "order_c3", type: "reserved", quantity: 1, ledger_version: 1, pool: "regular", reservation_generation: 1 },
      { order_id: "order_d4", type: "released", quantity: -1, ledger_version: 1, pool: "regular", reservation_generation: 1 },
      { order_id: "order_d4", type: "reserved", quantity: 1, ledger_version: 1, pool: "regular", reservation_generation: 1 },
    ]);
  });

  it("drops the lane, aggregate, and outbox machinery", async () => {
    const store = await populatedStore(provider);
    await store.migrate();

    expect(await store.existingObjects([
      "inventory_reservation_lanes", "checkout_inventory_lane_movements", "checkout_batch_outbox",
      "_single_checkout_commit_guard", "product_variants_checkout_lane_capacity_sync",
      "orders_checkout_aggregate_shape_guard", "orders_inventory_authority_insert_guard",
      "checkout_commit_v1",
    ])).toEqual([]);
    expect((await store.orderColumns()).filter((name) => name.startsWith("checkout_") || name === "inventory_authority"))
      .toEqual([]);
    // Ledger semantics still reject a deduction that leaves the hold in place.
    await expect(store.run(`
      INSERT INTO inventory_movements (
        id, variant_id, order_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
        stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock,
        reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta
      ) VALUES ('bad_deduct', 'var_hot', 'order_b2', 'deducted', 1, 9, 8, 2, 'regular', 90, 91, -1, 3, 3, 0, 0, 0, 0)
    `)).rejects.toThrow(/ledger v2 operation semantics/);
  });

  it("voids an orphaned aggregate whose request key committed another order", async () => {
    const store = await populatedStore(provider);
    // The old coordinator accepted a reused key with another payload and never
    // projected the second order; the key already belongs to order_b2.
    await insertLaneOrder(store, "order_e5", [{ variantId: "var_cold", quantity: 1, lane: 1 }], "pending");
    await store.run(`INSERT INTO checkout_attempts (id, request_key, request_hash, checkout_token, order_id, status)
      VALUES ('att_reused', 'checkout_submit:v1:order_e5', 'other_hash', 'chk_other', 'order_b2', 'committed')`);
    const coldBefore = await variant(store, "var_cold");

    await store.migrate();

    expect(await one(store, "SELECT status, inventory_action FROM orders WHERE id = 'order_e5'"))
      .toEqual({ status: "cancelled", inventory_action: "restored" });
    expect(await count(store, "SELECT COUNT(*) AS count FROM order_items WHERE order_id = 'order_e5'")).toBe(0);
    // Its hold is released, not folded: var_cold only gains order_b2's unit.
    expect((await variant(store, "var_cold")).reserved_stock).toBe(coldBefore.reserved_stock + 1);
    expect(await store.all(`SELECT type, quantity, ledger_version FROM inventory_movements
      WHERE order_id = 'order_e5' ORDER BY type`)).toEqual([
      { type: "released", quantity: -1, ledger_version: 1 },
      { type: "reserved", quantity: 1, ledger_version: 1 },
    ]);
  });

  it("aborts without changes when lane counters disagree with outstanding lane edges", async () => {
    const store = await populatedStore(provider);
    await store.run(
      "UPDATE inventory_reservation_lanes SET reserved_quantity = reserved_quantity + 1 WHERE variant_id = 'var_cold' AND lane = 0",
    );
    const before = await variant(store, "var_cold");

    await expect(store.migrate()).rejects.toThrow(/CHECK constraint failed|SINGLE_CHECKOUT_COMMIT_UNRECONCILED/);
    expect(await variant(store, "var_cold")).toEqual(before);
    expect(await count(store, "SELECT COUNT(*) AS count FROM inventory_reservation_lanes")).toBe(4);
  });
});
