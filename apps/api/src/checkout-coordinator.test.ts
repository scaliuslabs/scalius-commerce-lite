import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";

import type {
  CheckoutCommitCommand,
  CheckoutCommittedOrderRow,
  PortableSqlStatement,
} from "@scalius/database/checkout-commit";
import {
  createCheckoutSqlTransport,
  type CheckoutSqlTransport,
} from "@scalius/database/checkout-transport";
import type { Database } from "@scalius/database/client";
import * as schema from "@scalius/database/schema";
import { compileSqliteMigrationForProvider } from "@scalius/database/migration-artifacts";
import type { MetaPurchaseQueueMessage } from "@scalius/core/integrations/meta/purchase-outbox";
import type { OrderNotificationQueueMessage } from "@scalius/core/modules/notifications";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CheckoutCoordinator,
  CheckoutCoordinatorEngine,
  CheckoutIntentCoordinatorEngine,
  createRemoteCheckoutCommitGateway,
  getCheckoutCommitCoordinatorName,
  getCheckoutCommitLane,
  getCheckoutCoordinatorTopology,
  getCheckoutIngressCoordinatorName,
  submitCheckoutCommitToCoordinator,
  submitCheckoutIntentToCoordinator,
  type CheckoutIntentCommand,
} from "./checkout-coordinator";

type JsonObject = Record<string, unknown>;
type SQLiteInput = string | number | bigint | null | Uint8Array;
type CheckoutSideEffectQueueMessage =
  | OrderNotificationQueueMessage
  | MetaPurchaseQueueMessage;

const migrationDirectory = fileURLToPath(new URL(
  "../../../packages/database/migrations/",
  import.meta.url,
));

function createCheckoutDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  for (const name of readdirSync(migrationDirectory)
    .filter((candidate) => /^\d{4}_.+\.sql$/.test(candidate))
    .sort()) {
    database.exec(compileSqliteMigrationForProvider(
      readFileSync(`${migrationDirectory}/${name}`, "utf8"),
      "d1",
    ));
  }
  return database;
}

function sqliteTransport(
  database: DatabaseSync,
): CheckoutSqlTransport {
  return {
    provider: "d1",
    async all<T>(statement: PortableSqlStatement) {
      return database.prepare(statement.sql).all(
        ...(statement.args as SQLiteInput[]),
      ) as T[];
    },
    async get<T>(statement: PortableSqlStatement) {
      return (database.prepare(statement.sql).get(
        ...(statement.args as SQLiteInput[]),
      ) ?? null) as T | null;
    },
    async atomic(statements: readonly PortableSqlStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of statements) {
          if (/\bSELECT CASE WHEN\b/i.test(statement.sql)) {
            database.prepare(statement.sql).all(...(statement.args as SQLiteInput[]));
          } else {
            database.prepare(statement.sql).run(...(statement.args as SQLiteInput[]));
          }
        }
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    close() {},
  };
}

interface StatefulTursoHarness {
  transport: CheckoutSqlTransport;
  requestedBatchModes: Array<string | undefined>;
  loseNextCheckoutCommitResponse(): void;
}

type StatefulTursoBatchStatement = string | {
  sql: string;
  args?: readonly unknown[];
};

function batchStatementSql(statement: StatefulTursoBatchStatement): string {
  return typeof statement === "string" ? statement : statement.sql;
}

function batchStatementArgs(statement: StatefulTursoBatchStatement): SQLInputValue[] {
  if (typeof statement === "string" || statement.args === undefined) return [];
  if (!Array.isArray(statement.args)) {
    throw new Error("Stateful Turso test connection accepts positional arguments only.");
  }
  return statement.args as SQLInputValue[];
}

/**
 * Stateful test connection for the real Turso checkout transport. DatabaseSync
 * supplies SQLite semantics while this boundary preserves Turso's raw rows,
 * transaction modes, commit/rollback, direct all/get calls, and uncertain
 * post-commit responses. It deliberately does not emulate MVCC scheduling.
 */
function statefulTursoTransport(database: DatabaseSync): StatefulTursoHarness {
  const requestedBatchModes: Array<string | undefined> = [];
  let loseCheckoutCommitResponse = false;

  const connection = {
    async batch(
      statements: StatefulTursoBatchStatement[],
      options?: { mode?: string; raw?: boolean },
    ) {
      requestedBatchModes.push(options?.mode);
      const transactional = options?.mode !== undefined;
      const shouldLoseResponse = loseCheckoutCommitResponse
        && statements.some((statement) =>
          /\bINSERT\s+INTO\s+orders\b/i.test(batchStatementSql(statement))
        );
      if (transactional) {
        database.exec(options?.mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
      }
      try {
        const results = statements.map((statement) => {
          const prepared = database.prepare(batchStatementSql(statement));
          const args = batchStatementArgs(statement);
          if (prepared.columns().length === 0) {
            const result = prepared.run(...args);
            return { rows: [], rowsAffected: Number(result.changes) };
          }
          prepared.setReturnArrays(true);
          return {
            rows: prepared.all(...args) as unknown as SQLOutputValue[][],
            rowsAffected: 0,
          };
        });
        if (transactional) database.exec("COMMIT");
        if (shouldLoseResponse) {
          loseCheckoutCommitResponse = false;
          throw new Error("simulated Turso response loss after checkout commit");
        }
        return results;
      } catch (error) {
        if (transactional && database.isTransaction) database.exec("ROLLBACK");
        throw error;
      }
    },
    async all(sql: string, ...args: SQLInputValue[]) {
      return database.prepare(sql).all(...args);
    },
    async get(sql: string, ...args: SQLInputValue[]) {
      return database.prepare(sql).get(...args) ?? null;
    },
    close() {},
  };

  return {
    transport: createCheckoutSqlTransport({
      DATABASE_PROVIDER: "turso",
      TURSO_DATABASE_URL: "turso://stateful-conformance.turso.io",
      TURSO_AUTH_TOKEN: "test-token",
    }, {
      connectTurso: (() => connection) as never,
    }),
    requestedBatchModes,
    loseNextCheckoutCommitResponse() {
      loseCheckoutCommitResponse = true;
    },
  };
}

interface SqliteD1Result {
  results: Record<string, SQLOutputValue>[];
  success: true;
  meta: Record<string, never>;
}

interface SqliteD1Statement {
  bind(...values: SQLInputValue[]): SqliteD1Statement;
  run(): Promise<SqliteD1Result>;
  all(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  execute(): SqliteD1Result;
}

function sqliteRows(
  statement: StatementSync,
  values: SQLInputValue[],
): Record<string, SQLOutputValue>[] {
  return statement.all(...values);
}

function sqliteD1Statement(
  database: DatabaseSync,
  query: string,
  values: SQLInputValue[] = [],
): SqliteD1Statement {
  const execute = (): SqliteD1Result => ({
    results: sqliteRows(database.prepare(query), values),
    success: true,
    meta: {},
  });
  return {
    bind: (...nextValues) => sqliteD1Statement(database, query, nextValues),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => {
      const statement = database.prepare(query);
      statement.setReturnArrays(true);
      return statement.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = sqliteRows(database.prepare(query), values)[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute,
  };
}

function sqliteD1Binding(database: DatabaseSync): D1Database {
  return {
    prepare: (query: string) => sqliteD1Statement(database, query),
    async batch(statements: SqliteD1Statement[]) {
      database.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
}

function drizzleDatabase(database: DatabaseSync): Database {
  return drizzle(sqliteD1Binding(database), { schema }) as unknown as Database;
}

function order(id: string, inventoryAction = "reserved"): CheckoutCommittedOrderRow {
  return {
    id,
    customerName: `Buyer ${id}`,
    customerPhone: `+88017${id.slice(-8).padStart(8, "0")}`,
    customerEmail: null,
    shippingAddress: "Dhaka",
    city: "city_1",
    zone: "zone_1",
    area: null,
    cityName: "Dhaka",
    zoneName: "Dhanmondi",
    areaName: null,
    totalAmount: 100,
    shippingCharge: 0,
    discountAmount: 0,
    currencyCode: "BDT",
    currencyDecimalPlaces: 2,
    subtotalAmountMinor: 10_000,
    shippingAmountMinor: 0,
    discountAmountMinor: 0,
    taxAmountMinor: 0,
    totalAmountMinor: 10_000,
    taxLabel: "Tax",
    pricesIncludeTax: false,
    status: "pending",
    notes: null,
    paymentMethod: "cod",
    paymentStatus: "unpaid",
    paidAmount: 0,
    balanceDue: 100,
    fulfillmentStatus: "pending",
    inventoryPool: "regular",
    inventoryAction,
    customerId: null,
    accountOwnerCustomerId: null,
  };
}

function command(
  id: string,
  options: {
    requestHash?: string;
    quantity?: number;
    variantIds?: string[];
  } = {},
): CheckoutCommitCommand<JsonObject, JsonObject> {
  const requestKey = `checkout_submit:v1:${id}`;
  const requestHash = options.requestHash ?? `hash_${id}`;
  const receiptHash = `receipt_${id}`;
  const response = { orderId: id, receiptToken: `proof_${id}` };
  const orderRow = order(id);
  const payload = {
    checkoutToken: `proof_${id}`,
    orderData: { ...orderRow },
    items: (options.variantIds ?? ["variant_hot"]).map((variantId) => ({
      variantId,
      quantity: options.quantity ?? 1,
    })),
  };
  return {
    requestKey,
    requestHash,
    receiptHash,
    authorityRevision: 5,
    order: orderRow,
    response,
    reservations: (options.variantIds ?? ["variant_hot"]).map((variantId) => ({
      variantId,
      pool: "regular",
      quantity: options.quantity ?? 1,
    })),
    aggregate: {
      schemaVersion: 1,
      checkout: { requestKey, requestHash, receiptHash, authorityRevision: 5, response },
      payload,
    },
  };
}

function intent(
  index: number,
  options: { customerEmail?: string | null } = {},
): CheckoutIntentCommand {
  const suffix = String(index).padStart(4, "0");
  return {
    attempt: {
      commitMode: "atomic",
      origin: "new",
      id: `coa_intent_${suffix}`,
      requestKey: `checkout_submit:v1:intent_${suffix}`,
      requestHash: `intent_hash_${suffix}`,
      orderId: `order_intent_${suffix}`,
      checkoutToken: `chk_intent_${suffix}_proof`,
      statusToken: `cst_intent_${suffix}`,
    },
    requestUrl: "https://api.example.test/api/v1/orders",
    data: {
      checkoutRequestId: `checkout_intent_${suffix}`,
      customerName: `Intent Buyer ${suffix}`,
      customerPhone: "+8801700000000",
      customerEmail: options.customerEmail ?? null,
      shippingAddress: "123 Checkout Intent Road, Dhaka",
      city: "city_1",
      zone: "zone_1",
      area: null,
      cityName: null,
      zoneName: null,
      areaName: null,
      notes: null,
      items: [{
        cartKey: `cart_${suffix}`,
        productId: "product_hot",
        variantId: "variant_hot",
        quantity: 1,
        price: 100,
        productName: "Hot product",
        variantLabel: null,
      }],
      discountAmount: null,
      discountCode: null,
      shippingCharge: 60,
      shippingMethodId: "shipping_standard",
      paymentMethod: "cod",
      inventoryPool: "regular",
    },
  };
}

function installIntentCheckoutFixtures(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO settings (id, key, value, type, category, updated_at)
    VALUES
      ('setting_currency_code', 'currency_code', 'BDT', 'string', 'currency', unixepoch()),
      ('setting_currency_symbol', 'currency_symbol', '৳', 'string', 'currency', unixepoch()),
      ('setting_currency_rate', 'usd_exchange_rate', '1', 'string', 'currency', unixepoch()),
      ('setting_phone_countries', 'allowed_countries', '{"countries":["BD"],"mode":"include"}', 'json', 'phone', unixepoch()),
      ('setting_payment_enabled', 'enabled_methods', '["cod"]', 'json', 'payment_methods', unixepoch()),
      ('setting_payment_default', 'default_method', 'cod', 'string', 'payment_methods', unixepoch());
    INSERT INTO site_settings (
      id, singleton_key, site_name, header_config, footer_config,
      guest_checkout_enabled, checkout_mode, partial_payment_enabled,
      partial_payment_amount, created_at, updated_at
    ) VALUES (
      'site_default', 'default', 'Checkout test', '{}', '{}',
      1, 'all', 0, 0, unixepoch(), unixepoch()
    );
    INSERT INTO delivery_locations (
      id, name, type, parent_id, external_ids, metadata,
      is_active, sort_order, created_at, updated_at
    ) VALUES
      ('city_1', 'Dhaka', 'city', NULL, '{}', '{}', 1, 0, unixepoch(), unixepoch()),
      ('zone_1', 'Dhanmondi', 'zone', 'city_1', '{}', '{}', 1, 0, unixepoch(), unixepoch());
    INSERT INTO shipping_methods (
      id, name, fee, is_active, sort_order, created_at, updated_at
    ) VALUES (
      'shipping_standard', 'Standard delivery', 60, 1, 0, unixepoch(), unixepoch()
    );
  `);
}

function enableMetaPurchaseFixture(database: DatabaseSync): void {
  database.exec(`
    INSERT INTO meta_conversions_settings (
      id, singleton_key, pixel_id, access_token, is_enabled, created_at, updated_at
    ) VALUES (
      'meta_default', 'default', 'pixel_test', 'encrypted_test_token', 1,
      unixepoch(), unixepoch()
    );
  `);
}

async function settleWaitUntilTasks(tasks: Promise<unknown>[]): Promise<void> {
  for (let index = 0; index < tasks.length; index += 1) {
    await tasks[index];
  }
}

function fakeCoordinatorNamespace(
  fetcher: (name: string, input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): { namespace: DurableObjectNamespace; names: string[] } {
  const names: string[] = [];
  const namespace = {
    idFromName(name: string) {
      names.push(name);
      return name;
    },
    get(id: string) {
      return {
        fetch(input: RequestInfo | URL, init?: RequestInit) {
          return fetcher(id, input, init);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  return { namespace, names };
}

describe("checkout coordinator topology", () => {
  it("keeps D1 serialized and horizontally shards concurrent providers deterministically", () => {
    expect(getCheckoutCoordinatorTopology("d1")).toEqual({
      ingressShards: 1,
      commitLanes: 1,
    });
    expect(getCheckoutCoordinatorTopology("turso")).toEqual({
      ingressShards: 16,
      commitLanes: 2,
    });
    expect(getCheckoutCoordinatorTopology("postgres")).toEqual({
      ingressShards: 16,
      commitLanes: 2,
    });

    const names = new Set(Array.from({ length: 1_024 }, (_, index) =>
      getCheckoutIngressCoordinatorName("postgres", `checkout_submit:v1:${index}`)
    ));
    expect(names.size).toBe(16);
    expect(getCheckoutIngressCoordinatorName("postgres", "stable-key"))
      .toBe(getCheckoutIngressCoordinatorName("postgres", "stable-key"));
    expect(getCheckoutIngressCoordinatorName("d1", "first"))
      .toBe(getCheckoutIngressCoordinatorName("d1", "second"));
    expect(getCheckoutCommitCoordinatorName(0)).not.toBe(
      getCheckoutCommitCoordinatorName(1),
    );
  });

  it("routes intent by idempotency key and direct commits by provider lane", async () => {
    const intentCommand = intent(900);
    const intentHarness = fakeCoordinatorNamespace(async () => Response.json({
      ok: true,
      orderId: intentCommand.attempt.orderId,
      response: { orderId: intentCommand.attempt.orderId },
      replay: false,
      postCommitPayload: null,
    }, { status: 201 }));
    await expect(submitCheckoutIntentToCoordinator(
      intentHarness.namespace,
      "postgres",
      intentCommand,
    )).resolves.toMatchObject({ ok: true, replay: false });
    expect(intentHarness.names).toEqual([
      getCheckoutIngressCoordinatorName(
        "postgres",
        intentCommand.attempt.requestKey,
      ),
    ]);

    const checkoutCommand = command("order_routed");
    const commitHarness = fakeCoordinatorNamespace(async (_name, _input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        commands: CheckoutCommitCommand<JsonObject, JsonObject>[];
      };
      return Response.json({
        ok: true,
        results: body.commands.map((candidate) => ({
          ok: true,
          orderId: candidate.order.id,
          response: candidate.response,
          replay: false,
        })),
      });
    });
    await expect(submitCheckoutCommitToCoordinator(
      commitHarness.namespace,
      "postgres",
      checkoutCommand,
    )).resolves.toMatchObject({ ok: true, orderId: "order_routed" });
    expect(commitHarness.names).toEqual([
      getCheckoutCommitCoordinatorName(
        getCheckoutCommitLane("postgres", checkoutCommand.requestHash),
      ),
    ]);
  });

  it("fails closed without retrying an overloaded commit coordinator", async () => {
    let calls = 0;
    const harness = fakeCoordinatorNamespace(async () => {
      calls += 1;
      throw Object.assign(new Error("Durable Object is overloaded"), {
        overloaded: true,
      });
    });
    await expect(submitCheckoutCommitToCoordinator(
      harness.namespace,
      "postgres",
      command("order_overloaded"),
    )).resolves.toEqual({ ok: false, code: "CHECKOUT_COMMIT_UNAVAILABLE" });
    expect(calls).toBe(1);
  });

  it("microbatches concurrent-provider commits by lane and restores result order", async () => {
    const calls: Array<{ name: string; orderIds: string[] }> = [];
    const harness = fakeCoordinatorNamespace(async (name, _input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        commands: CheckoutCommitCommand<JsonObject, JsonObject>[];
      };
      calls.push({ name, orderIds: body.commands.map((candidate) => candidate.order.id) });
      return Response.json({
        ok: true,
        results: body.commands.map((candidate) => ({
          ok: true,
          orderId: candidate.order.id,
          response: candidate.response,
          replay: false,
        })),
      });
    });
    const commands = Array.from({ length: 20 }, (_, index) =>
      command(`order_gateway_${String(index).padStart(2, "0")}`)
    );
    expect(new Set(commands.map((candidate) =>
      getCheckoutCommitLane("postgres", candidate.requestHash)
    ))).toEqual(new Set([0, 1]));

    const gateway = createRemoteCheckoutCommitGateway(
      harness.namespace,
      "postgres",
      { targetOrders: 500, targetJsonBytes: 5_000_000 },
    );
    const results = await gateway.submitBatch(commands);

    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((call) => call.name))).toEqual(new Set([
      getCheckoutCommitCoordinatorName(0),
      getCheckoutCommitCoordinatorName(1),
    ]));
    expect(results.map((result) => result.ok ? result.orderId : null))
      .toEqual(commands.map((candidate) => candidate.order.id));
  });
});

describe("production checkout coordinator engine", () => {
  let database: DatabaseSync;

  beforeEach(async () => {
    database = createCheckoutDatabase();
    database.exec(`
      PRAGMA foreign_keys = ON;
      INSERT INTO products (id, name, price, slug, is_active)
      VALUES
        ('product_hot', 'Hot product', 100, 'hot-product', 1),
        ('product_second', 'Second product', 100, 'second-product', 1);
      INSERT INTO product_variants (
        id, product_id, sku, price, stock, reserved_stock,
        stock_version, track_inventory, is_default
      ) VALUES
        ('variant_hot', 'product_hot', 'HOT-1', 100, 20, 0, 1, 1, 1),
        ('variant_second', 'product_second', 'HOT-2', 100, 20, 0, 1, 1, 1);
    `);
  });

  afterEach(() => database.close());

  it("coalesces concurrent duplicates into one order and one reservation edge", async () => {
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    const input = command("order_duplicate");
    const results = await Promise.all(
      Array.from({ length: 50 }, () => engine.submit(input)),
    );

    expect(results.every((result) => result.ok)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 1 });
    expect(database.prepare(`
      SELECT SUM(reserved_quantity) AS reserved
      FROM inventory_reservation_lanes WHERE variant_id = 'variant_hot'
    `).get()).toEqual({ reserved: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM checkout_batch_outbox").get())
      .toEqual({ count: 1 });
  });

  it("accepts a bound D1 commit microbatch and keeps projection recoverable", async () => {
    const waitUntilTasks: Promise<unknown>[] = [];
    const state = {
      waitUntil(task: Promise<unknown>) {
        waitUntilTasks.push(task);
      },
    } as unknown as DurableObjectState;
    const namespace = fakeCoordinatorNamespace(async () => {
      throw new Error("The D1 commit endpoint must not make a nested coordinator call.");
    }).namespace;
    const coordinator = new CheckoutCoordinator(state, {
      DB: sqliteD1Binding(database),
      CHECKOUT_COORDINATOR: namespace,
    } as unknown as Env);
    const input = command("order_commit_endpoint");
    const response = await coordinator.fetch(new Request(
      "https://checkout-coordinator.internal/commit-batch/0",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commands: [input] }),
      },
    ));
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      results: [{ ok: true, orderId: "order_commit_endpoint", replay: false }],
      build: "checkout-coordinator-v2",
    });
    await settleWaitUntilTasks(waitUntilTasks);
    expect(database.prepare(`
      SELECT
        checkout_projection_status AS projectionStatus,
        (SELECT status FROM checkout_batch_outbox LIMIT 1) AS batchStatus
      FROM orders
      WHERE id = 'order_commit_endpoint'
    `).get()).toEqual({ projectionStatus: "pending", batchStatus: "pending" });
  });

  it("runs the sharded intent and commit objects end to end on D1 authority", async () => {
    installIntentCheckoutFixtures(database);
    const waitUntilTasks: Promise<unknown>[] = [];
    const instances = new Map<string, CheckoutCoordinator>();
    const namespace = {
      idFromName(name: string) {
        return name;
      },
      get(id: string) {
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            let instance = instances.get(id);
            if (!instance) {
              instance = new CheckoutCoordinator({
                waitUntil(task: Promise<unknown>) {
                  waitUntilTasks.push(task);
                },
              } as unknown as DurableObjectState, env);
              instances.set(id, instance);
            }
            return instance.fetch(new Request(input, init));
          },
        };
      },
    } as unknown as DurableObjectNamespace;
    const env = {
      DB: sqliteD1Binding(database),
      CHECKOUT_COORDINATOR: namespace,
    } as unknown as Env;

    const input = intent(950);
    await expect(submitCheckoutIntentToCoordinator(namespace, "d1", input))
      .resolves.toMatchObject({
        ok: true,
        orderId: input.attempt.orderId,
        replay: false,
      });
    await settleWaitUntilTasks(waitUntilTasks);

    expect([...instances.keys()].sort()).toEqual([
      getCheckoutCommitCoordinatorName(0),
      getCheckoutIngressCoordinatorName("d1", input.attempt.requestKey),
    ].sort());
    expect(database.prepare(`
      SELECT
        checkout_projection_status AS projectionStatus,
        (SELECT status FROM checkout_batch_outbox LIMIT 1) AS batchStatus,
        (SELECT COUNT(*) FROM checkout_attempts) AS attempts,
        (SELECT COUNT(*) FROM order_items) AS items
      FROM orders
      WHERE id = ?
    `).get(input.attempt.orderId)).toEqual({
      projectionStatus: "complete",
      batchStatus: "complete",
      attempts: 1,
      items: 1,
    });
  });

  it("prepares a checkout burst from one shared authority read before atomic commits", async () => {
    installIntentCheckoutFixtures(database);
    let authorityBatchCalls = 0;
    const db = drizzleDatabase(database);
    const originalBatch = db.batch.bind(db);
    db.batch = ((statements: never) => {
      authorityBatchCalls += 1;
      return originalBatch(statements);
    }) as typeof db.batch;
    const waitUntilTasks: Promise<unknown>[] = [];
    const waitUntil = (task: Promise<unknown>) => waitUntilTasks.push(task);
    const commitEngine = new CheckoutCoordinatorEngine(
      sqliteTransport(database),
      waitUntil,
    );
    const ingress = new CheckoutIntentCoordinatorEngine(
      db,
      undefined,
      commitEngine,
      waitUntil,
    );

    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => ingress.submit(intent(index))),
    );
    const cachedResults = await Promise.all(
      Array.from({ length: 4 }, (_, index) => ingress.submit(intent(index + 12))),
    );
    await settleWaitUntilTasks(waitUntilTasks);

    expect(results.every((result) => result.ok && result.replay === false)).toBe(true);
    expect(cachedResults.every((result) => result.ok && result.replay === false)).toBe(true);
    expect(authorityBatchCalls).toBe(1);
    expect(database.prepare(`
      SELECT COUNT(*) AS orders,
             (SELECT SUM(reserved_quantity) FROM inventory_reservation_lanes
              WHERE variant_id = 'variant_hot') AS reserved
      FROM orders
    `).get()).toEqual({ orders: 16, reserved: 16 });
    expect(database.prepare(`
      SELECT
        SUM(checkout_projection_status = 'complete') AS projected,
        (SELECT COUNT(*) FROM order_notification_outbox) AS notifications,
        (SELECT COUNT(*) FROM meta_capi_purchase_outbox) AS metaPurchases
      FROM orders
    `).get()).toEqual({
      projected: 16,
      notifications: 0,
      metaPurchases: 0,
    });
  });

  it("projects a checkout burst before relaying its durable side effects", async () => {
    installIntentCheckoutFixtures(database);
    enableMetaPurchaseFixture(database);
    const waitUntilTasks: Promise<unknown>[] = [];
    const waitUntil = (task: Promise<unknown>) => waitUntilTasks.push(task);
    const sendBatch = vi.fn(async (
      _messages: Array<{ body: CheckoutSideEffectQueueMessage }>,
      _options?: { delaySeconds?: number },
    ) => undefined);
    const commitEngine = new CheckoutCoordinatorEngine(
      sqliteTransport(database),
      waitUntil,
      { sendBatch },
    );
    const ingress = new CheckoutIntentCoordinatorEngine(
      drizzleDatabase(database),
      undefined,
      commitEngine,
      waitUntil,
    );

    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) => ingress.submit(intent(index + 100, {
        customerEmail: `buyer-${index}@example.test`,
      }))),
    );
    await settleWaitUntilTasks(waitUntilTasks);

    expect(results.every((result) => result.ok && result.replay === false)).toBe(true);
    expect(database.prepare(`
      SELECT
        COUNT(*) AS orders,
        SUM(checkout_projection_status = 'complete') AS projected,
        (SELECT COUNT(*) FROM checkout_batch_outbox WHERE status = 'complete') AS batches,
        (SELECT COUNT(*) FROM order_notification_outbox WHERE status = 'pending') AS notifications,
        (SELECT COUNT(*) FROM meta_capi_purchase_outbox WHERE status = 'pending') AS metaPurchases
      FROM orders
    `).get()).toEqual({
      orders: 4,
      projected: 4,
      batches: 1,
      notifications: 4,
      metaPurchases: 4,
    });
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const [messages, options] = sendBatch.mock.calls[0]!;
    expect(options).toEqual({ delaySeconds: 5 });
    expect(messages).toHaveLength(8);
    expect(messages.map((message) => message.body.type)).toEqual([
      "order.notification",
      "meta.purchase",
      "order.notification",
      "meta.purchase",
      "order.notification",
      "meta.purchase",
      "order.notification",
      "meta.purchase",
    ]);
  });

  it("retries a transient projection failure without waiting for scheduled recovery", async () => {
    installIntentCheckoutFixtures(database);
    const waitUntilTasks: Promise<unknown>[] = [];
    const baseTransport = sqliteTransport(database);
    let projectionAttempts = 0;
    const transport: CheckoutSqlTransport = {
      ...baseTransport,
      async atomic(statements, slot) {
        const isProjection = statements.some((statement) =>
          statement.sql.includes("checkout_projection_status = 'complete'")
        );
        if (isProjection && projectionAttempts++ === 0) {
          throw new Error("transient projection failure");
        }
        await baseTransport.atomic(statements, slot);
      },
    };
    const waitUntil = (task: Promise<unknown>) => waitUntilTasks.push(task);
    const commitEngine = new CheckoutCoordinatorEngine(transport, waitUntil);
    const ingress = new CheckoutIntentCoordinatorEngine(
      drizzleDatabase(database),
      undefined,
      commitEngine,
      waitUntil,
    );

    await expect(ingress.submit(intent(150))).resolves.toMatchObject({
      ok: true,
      replay: false,
    });
    await settleWaitUntilTasks(waitUntilTasks);

    expect(projectionAttempts).toBe(2);
    expect(database.prepare(`
      SELECT
        checkout_projection_status AS projectionStatus,
        (SELECT status FROM checkout_batch_outbox LIMIT 1) AS batchStatus,
        (SELECT COUNT(*) FROM checkout_attempts) AS attempts,
        (SELECT COUNT(*) FROM order_items) AS items
      FROM orders
      LIMIT 1
    `).get()).toEqual({
      projectionStatus: "complete",
      batchStatus: "complete",
      attempts: 1,
      items: 1,
    });
  });

  it("keeps checkout successful and durable outboxes pending when queue relay fails", async () => {
    installIntentCheckoutFixtures(database);
    enableMetaPurchaseFixture(database);
    const waitUntilTasks: Promise<unknown>[] = [];
    const waitUntil = (task: Promise<unknown>) => waitUntilTasks.push(task);
    const sendBatch = vi.fn(async (
      _messages: Array<{ body: CheckoutSideEffectQueueMessage }>,
      _options?: { delaySeconds?: number },
    ) => {
      throw new Error("queue unavailable");
    });
    const commitEngine = new CheckoutCoordinatorEngine(
      sqliteTransport(database),
      waitUntil,
      { sendBatch },
    );
    const ingress = new CheckoutIntentCoordinatorEngine(
      drizzleDatabase(database),
      undefined,
      commitEngine,
      waitUntil,
    );

    await expect(ingress.submit(intent(200, {
      customerEmail: "buyer-200@example.test",
    }))).resolves.toMatchObject({
      ok: true,
      replay: false,
    });
    await settleWaitUntilTasks(waitUntilTasks);

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(database.prepare(`
      SELECT
        checkout_projection_status AS projectionStatus,
        (SELECT status FROM checkout_batch_outbox LIMIT 1) AS batchStatus,
        (SELECT status FROM order_notification_outbox LIMIT 1) AS notificationStatus,
        (SELECT status FROM meta_capi_purchase_outbox LIMIT 1) AS metaStatus
      FROM orders
      LIMIT 1
    `).get()).toEqual({
      projectionStatus: "complete",
      batchStatus: "complete",
      notificationStatus: "pending",
      metaStatus: "pending",
    });
  });

  it("bounds projection deferral by age even while ingress remains active", async () => {
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    await expect(engine.submit(command("order_projection_deadline")))
      .resolves.toMatchObject({ ok: true, replay: false });

    expect(engine.shouldFlushPendingProjections()).toBe(false);
    expect(engine.shouldFlushPendingProjections(Date.now() + 5_001)).toBe(true);
  });

  it("recovers exact replay through a fresh coordinator and rejects a changed hash", async () => {
    const firstEngine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    const input = command("order_restart");
    await expect(firstEngine.submit(input)).resolves.toMatchObject({ ok: true, replay: false });

    const restartedEngine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    await expect(restartedEngine.submit(input)).resolves.toMatchObject({ ok: true, replay: true });
    await expect(restartedEngine.submit(command("order_restart", {
      requestHash: "different_hash",
    }))).resolves.toEqual({ ok: false, code: "CHECKOUT_IDEMPOTENCY_CONFLICT" });

    expect(database.prepare(`
      SELECT COUNT(*) AS orders,
             (SELECT SUM(reserved_quantity) FROM inventory_reservation_lanes
              WHERE variant_id = 'variant_hot') AS reserved
      FROM orders
    `).get()).toEqual({ orders: 1, reserved: 1 });
  });

  it("recovers an exact Turso replay when the checkout commit response is lost", async () => {
    const harness = statefulTursoTransport(database);
    harness.loseNextCheckoutCommitResponse();
    const input = command("order_turso_response_loss");
    try {
      const firstEngine = new CheckoutCoordinatorEngine(harness.transport);
      await expect(firstEngine.submit(input)).resolves.toMatchObject({
        ok: true,
        replay: true,
      });

      const restartedEngine = new CheckoutCoordinatorEngine(harness.transport);
      await expect(restartedEngine.submit(input)).resolves.toMatchObject({
        ok: true,
        replay: true,
      });
      await expect(restartedEngine.submit(command("order_turso_response_loss", {
        requestHash: "different_hash",
      }))).resolves.toEqual({
        ok: false,
        code: "CHECKOUT_IDEMPOTENCY_CONFLICT",
      });

      expect(database.prepare(`
        SELECT COUNT(*) AS orders,
               (SELECT SUM(reserved_quantity) FROM inventory_reservation_lanes
                WHERE variant_id = 'variant_hot') AS reserved,
               (SELECT COUNT(*) FROM checkout_batch_outbox) AS outboxes
        FROM orders
      `).get()).toEqual({ orders: 1, reserved: 1, outboxes: 1 });
      expect(harness.requestedBatchModes).toContain("concurrent");
    } finally {
      harness.transport.close();
    }
  });

  it("fails a stale checkout authority revision without writing an order", async () => {
    database.prepare(`
      UPDATE checkout_authority SET revision = 6, updated_at = unixepoch()
      WHERE id = 'default'
    `).run();
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));

    await expect(engine.submit(command("order_stale_authority")))
      .resolves.toEqual({ ok: false, code: "CHECKOUT_AUTHORITY_CHANGED" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get())
      .toEqual({ count: 0 });
  });

  it("commits multi-SKU orders atomically on one lane", async () => {
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    const result = await engine.submit(command("order_multi", {
      variantIds: ["variant_hot", "variant_second"],
      quantity: 2,
    }));

    expect(result).toMatchObject({ ok: true, replay: false });
    expect(database.prepare(`
      SELECT COUNT(DISTINCT json_extract(edge.value, '$.variantId')) AS variants,
             SUM(CAST(json_extract(edge.value, '$.quantity') AS INTEGER)) AS quantity
      FROM orders AS checkout_order
      JOIN json_each(checkout_order.checkout_inventory_edges) AS edge
      WHERE checkout_order.id = 'order_multi'
    `).get()).toEqual({ variants: 2, quantity: 4 });
    expect(database.prepare(`
      SELECT SUM(reserved_quantity) AS reserved
      FROM inventory_reservation_lanes
      WHERE variant_id IN ('variant_hot', 'variant_second')
    `).get()).toEqual({ reserved: 4 });
  });

  it("uses both lanes under concurrent-writer transport and fails closed at capacity", async () => {
    const harness = statefulTursoTransport(database);
    const engine = new CheckoutCoordinatorEngine(harness.transport);
    try {
      const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
        engine.submit(command(`order_${String(index).padStart(3, "0")}`))
      ));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(database.prepare(`
        SELECT COUNT(DISTINCT lane) AS lanes, SUM(reserved_quantity) AS reserved
        FROM inventory_reservation_lanes
        WHERE variant_id = 'variant_hot' AND reserved_quantity > 0
      `).get()).toEqual({ lanes: 2, reserved: 12 });

      await expect(engine.submit(command("order_exhausted", { quantity: 9 })))
        .resolves.toEqual({ ok: false, code: "CHECKOUT_INVENTORY_UNAVAILABLE" });
      expect(database.prepare("SELECT COUNT(*) AS count FROM orders").get()).toEqual({ count: 12 });
      expect(database.prepare(`
        SELECT SUM(reserved_quantity) AS reserved
        FROM inventory_reservation_lanes WHERE variant_id = 'variant_hot'
      `).get()).toEqual({ reserved: 12 });
      expect(harness.requestedBatchModes.filter((mode) => mode === "concurrent").length)
        .toBeGreaterThanOrEqual(2);
    } finally {
      harness.transport.close();
    }
  });

  it("commits a capacity-limited D1 tail instead of waiting for an impossible full batch", async () => {
    database.prepare(`
      UPDATE product_variants SET stock = 300 WHERE id = 'variant_hot'
    `).run();
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    const results = await Promise.all(Array.from({ length: 350 }, (_, index) =>
      engine.submit(command(`order_tail_${String(index).padStart(3, "0")}`))
    ));

    expect(results.filter((result) => result.ok)).toHaveLength(300);
    expect(results.filter((result) =>
      !result.ok && result.code === "CHECKOUT_INVENTORY_UNAVAILABLE"
    )).toHaveLength(50);
    expect(database.prepare(`
      SELECT COUNT(*) AS orders,
             (SELECT SUM(reserved_quantity) FROM inventory_reservation_lanes
              WHERE variant_id = 'variant_hot') AS reserved
      FROM orders
    `).get()).toEqual({ orders: 300, reserved: 300 });
  });

  it("commits exact stock capacity without a cache side-channel", async () => {
    const engine = new CheckoutCoordinatorEngine(sqliteTransport(database));
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      engine.submit(command(`order_sold_out_${String(index).padStart(2, "0")}`))
    ));

    expect(results.every((result) => result.ok)).toBe(true);
    expect(database.prepare(`
      SELECT SUM(reserved_quantity) AS reserved
      FROM inventory_reservation_lanes
      WHERE variant_id = 'variant_hot'
    `).get()).toEqual({ reserved: 20 });
    expect(results.every((result) => !("availabilityChangedSubjects" in result)))
      .toBe(true);
  });

  it("moves only free capacity to avoid false out-of-stock from lane fragmentation", async () => {
    database.exec(`
      INSERT INTO inventory_reservation_lanes (
        variant_id, pool, lane, capacity, reserved_quantity, version,
        source_stock_version, created_at, updated_at
      ) VALUES
        ('variant_hot', 'regular', 0, 10, 8, 8, 1, unixepoch(), unixepoch()),
        ('variant_hot', 'regular', 1, 10, 8, 8, 1, unixepoch(), unixepoch());
    `);
    const harness = statefulTursoTransport(database);
    const engine = new CheckoutCoordinatorEngine(harness.transport);
    try {
      await expect(engine.submit(command("order_fragmented", { quantity: 3 })))
        .resolves.toMatchObject({ ok: true, replay: false });
      expect(database.prepare(`
        SELECT
          SUM(reserved_quantity) AS reserved,
          SUM(capacity) AS capacity,
          SUM(capacity - reserved_quantity) AS free,
          MIN(capacity - reserved_quantity) AS minFree,
          MAX(capacity - reserved_quantity) AS maxFree
        FROM inventory_reservation_lanes
        WHERE variant_id = 'variant_hot'
      `).get()).toEqual({
        reserved: 19,
        capacity: 20,
        free: 1,
        minFree: 0,
        maxFree: 1,
      });
      expect(database.prepare(`
        SELECT COUNT(*) AS orders FROM orders WHERE id = 'order_fragmented'
      `).get()).toEqual({ orders: 1 });

      await expect(engine.submit(command("order_after_fragmentation", { quantity: 2 })))
        .resolves.toEqual({ ok: false, code: "CHECKOUT_INVENTORY_UNAVAILABLE" });
    } finally {
      harness.transport.close();
    }
  });
});
