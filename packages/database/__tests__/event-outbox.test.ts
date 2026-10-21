// Migration 0103 (COMMERCE-HOOKS H2, H3): the order channel columns and the
// event outbox triggers. The checked-in SQL carries every generated trigger
// verbatim for both dialects, every topic fires from its domain write with
// facts that parse against the public catalog, a rolled-back write leaves no
// event, and the triggers run on the real Turso engine too.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EVENT_TOPICS, EVENT_TOPIC_RESOURCE, parseEventFacts, type EventTopic } from "../../shared/src/events";
import { ORDER_CHANNELS } from "../../shared/src/order-channel";
import {
  EVENT_TRIGGER_MIGRATIONS,
  EVENT_TRIGGER_SPECS,
  eventOutboxPostgresStatements,
  eventOutboxPostgresTrigger,
  eventOutboxSqliteStatements,
  generateEventOutboxTriggers,
  supersededEventOutboxPostgresStatements,
  supersededEventOutboxSqliteStatements,
} from "../scripts/event-outbox-triggers";
import { safeBatch } from "../src/batch-helper";
import { ORDER_CHANNEL_VALUES, orders } from "../src/schema";
import {
  compiledMigrationSql,
  createMigratedSqlite,
  createSqliteD1Database,
} from "../src/testing/sqlite-d1";
import { freshTursoEngineStore } from "./turso-engine";

const BREAKPOINT = "--> statement-breakpoint";
const MIGRATION = "0103_order_channel_event_outbox";
const migrationsDirectory = join(import.meta.dirname, "../migrations");

type EventRow = { id: string; topic: string; resource_type: string; resource_id: string; data: string; status: string };

function events(sqlite: DatabaseSync): EventRow[] {
  return sqlite.prepare("SELECT id, topic, resource_type, resource_id, data, status FROM event_outbox ORDER BY rowid").all() as EventRow[];
}

function topics(sqlite: DatabaseSync): string[] {
  return events(sqlite).map((row) => row.topic);
}

function clear(sqlite: DatabaseSync): void {
  sqlite.exec("DELETE FROM event_outbox");
}

function insertOrder(sqlite: DatabaseSync, id: string, values: Partial<Record<string, string>> = {}): void {
  const row: Record<string, string> = {
    id,
    customer_name: "Rahim Uddin",
    customer_phone: "+8801711111111",
    shipping_address: "House 1",
    city: "city_1",
    zone: "zone_1",
    status: "pending",
    ...values,
  };
  const columns = Object.keys(row);
  sqlite.prepare(`INSERT INTO orders (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

function insertProduct(sqlite: DatabaseSync, id: string): void {
  sqlite.prepare("INSERT INTO products (id, name, slug) VALUES (?, ?, ?)").run(id, `Product ${id}`, `product-${id}`);
  sqlite.prepare("INSERT INTO product_variants (id, product_id, sku, is_default) VALUES (?, ?, ?, 1)").run(`${id}_v1`, id, `SKU-${id}`);
}

describe(`${MIGRATION} files`, () => {
  const sqliteFile = readFileSync(join(migrationsDirectory, `${MIGRATION}.sql`), "utf8");

  it.each([MIGRATION, ...new Set(Object.values(EVENT_TRIGGER_MIGRATIONS))])("%s carries its generated triggers verbatim, for D1/Turso and PostgreSQL", (migration) => {
    const read = (dir: string) => readFileSync(join(migrationsDirectory, dir, `${migration}.sql`), "utf8")
      .split(BREAKPOINT).map((statement) => statement.trim());
    const sqliteStatements = read("");
    const postgresStatements = read("postgres");
    expect(eventOutboxSqliteStatements(migration).length + supersededEventOutboxSqliteStatements(migration).length).toBeGreaterThan(0);
    for (const statement of eventOutboxSqliteStatements(migration)) {
      expect(sqliteStatements.some((candidate) => candidate.includes(statement)), statement.split("\n")[0]).toBe(true);
    }
    for (const statement of eventOutboxPostgresStatements(migration)) {
      expect(postgresStatements.some((candidate) => candidate.includes(statement)), statement.split("\n")[0]).toBe(true);
    }
    // Earlier forms a later migration re-created stay verbatim where they were installed.
    for (const statement of supersededEventOutboxSqliteStatements(migration)) {
      expect(sqliteStatements.some((candidate) => candidate.includes(statement)), statement.split("\n")[0]).toBe(true);
    }
    for (const statement of supersededEventOutboxPostgresStatements(migration)) {
      expect(postgresStatements.some((candidate) => candidate.includes(statement)), statement.split("\n")[0]).toBe(true);
    }
  });

  it("marks the 0103 trigger block", () => {
    expect(sqliteFile).toContain("-- >>> H2H3 order channel and event outbox: triggers and backfill");
    expect(sqliteFile).toContain("-- <<< H2H3");
  });

  it("keeps every SQLite trigger body one statement with no CASE (remote D1 rule)", () => {
    for (const trigger of generateEventOutboxTriggers()) {
      const body = trigger.sqlite.slice(trigger.sqlite.indexOf("BEGIN") + 5, trigger.sqlite.lastIndexOf("END"));
      expect(body.trim().split(";").filter((part) => part.trim()).length, trigger.name).toBe(1);
      expect(trigger.sqlite, trigger.name).not.toMatch(/\bCASE\b/i);
      expect(eventOutboxPostgresTrigger(trigger.name)).toBe(`${trigger.postgres};`);
    }
  });

  it("covers every topic of the catalog and matches each topic's resource", () => {
    expect([...new Set(EVENT_TRIGGER_SPECS.map((spec) => spec.topic))].sort()).toEqual(
      EVENT_TOPICS.filter((topic) => !["customer.redact_requested", "customer.data_requested"].includes(topic)).sort(),
    );
  });

  it("keeps the schema's order channel vocabulary equal to the shared one", () => {
    expect([...ORDER_CHANNEL_VALUES]).toEqual([...ORDER_CHANNELS]);
  });
});

describe(`${MIGRATION} triggers (D1)`, () => {
  let sqlite: DatabaseSync;

  beforeEach(() => {
    sqlite = createMigratedSqlite();
    sqlite.exec("INSERT INTO event_demand (filter) VALUES ('order.*'), ('return.*'), ('product.*'), ('variant.*'), ('purchase_order.*'), ('inventory_transfer.*'), ('customer.*')");
  });
  afterEach(() => sqlite.close());

  function expectReadableFacts(): void {
    for (const row of events(sqlite)) {
      const topic = row.topic as EventTopic;
      expect(EVENT_TOPICS).toContain(topic);
      expect(row.resource_type).toBe(EVENT_TOPIC_RESOURCE[topic]);
      expect(parseEventFacts(topic, row.data), `${row.topic} ${row.data}`).not.toBeNull();
      expect(row.id).toMatch(/^evt_\d{13}[0-9a-f]{12}$/);
      expect(row.status).toBe("pending");
    }
  }

  it("orders: created, updated, paid and cancelled, with incomplete orders silent until they become real", () => {
    insertOrder(sqlite, "ord_1");
    expect(topics(sqlite)).toEqual(["order.created"]);
    expect(JSON.parse(events(sqlite)[0]!.data)).toEqual({
      orderId: "ord_1",
      status: "pending",
      paymentStatus: "unpaid",
      channel: "online_store",
    });

    clear(sqlite);
    sqlite.exec("UPDATE orders SET status = 'confirmed' WHERE id = 'ord_1'");
    expect(topics(sqlite)).toEqual(["order.updated"]);
    expect(JSON.parse(events(sqlite)[0]!.data)).toMatchObject({ previousStatus: "pending", status: "confirmed" });

    clear(sqlite);
    sqlite.exec("UPDATE orders SET payment_status = 'paid', paid_amount_minor = 1000 WHERE id = 'ord_1'");
    expect(topics(sqlite).sort()).toEqual(["order.paid", "order.updated"]);

    clear(sqlite);
    // Bookkeeping columns are not an order update.
    sqlite.exec("UPDATE orders SET inventory_action = 'reserved', version = version + 1, updated_at = updated_at + 1 WHERE id = 'ord_1'");
    expect(topics(sqlite)).toEqual([]);

    sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_1'");
    expect(topics(sqlite).sort()).toEqual(["order.cancelled", "order.updated"]);
    expect(JSON.parse(events(sqlite).find((row) => row.topic === "order.cancelled")!.data)).toEqual({
      orderId: "ord_1",
      previousStatus: "confirmed",
    });

    clear(sqlite);
    insertOrder(sqlite, "ord_online", { status: "incomplete" });
    sqlite.exec("UPDATE orders SET payment_status = 'failed' WHERE id = 'ord_online'");
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec("UPDATE orders SET status = 'pending', payment_status = 'paid' WHERE id = 'ord_online'");
    expect(topics(sqlite).sort()).toEqual(["order.created", "order.paid"]);

    clear(sqlite);
    insertOrder(sqlite, "ord_abandoned", { status: "incomplete" });
    sqlite.exec("UPDATE orders SET status = 'cancelled' WHERE id = 'ord_abandoned'");
    expect(topics(sqlite)).toEqual([]);

    insertOrder(sqlite, "ord_gift_card_paid", { payment_status: "paid" });
    expect(topics(sqlite).sort()).toEqual(["order.created", "order.paid"]);
    expectReadableFacts();
  });

  it("fulfilments, refunds and returns", () => {
    insertOrder(sqlite, "ord_2", { status: "confirmed" });
    insertProduct(sqlite, "prod_ful");
    sqlite.exec(`INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor)
      VALUES ('item_b', 'ord_2', 'prod_ful', 'prod_ful_v1', 3, 500), ('item_a', 'ord_2', 'prod_ful', 'prod_ful_v1', 1, 500)`);
    clear(sqlite);
    // The lines follow their fulfilment in the batch and amend its event (0172).
    sqlite.exec(`INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type, location_id)
      VALUES ('ful_1', 'ord_2', 'ship', 'req_1', 'admin', 'loc_default');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fl_b', 'ful_1', 'ord_2', 'item_b', 2), ('fl_a', 'ful_1', 'ord_2', 'item_a', 1)`);
    expect(topics(sqlite)).toEqual(["order.fulfilled"]);
    expect(JSON.parse(events(sqlite)[0]!.data)).toEqual({
      orderId: "ord_2",
      fulfillmentId: "ful_1",
      kind: "ship",
      locationId: "loc_default",
      lines: [
        { orderItemId: "item_a", variantId: "prod_ful_v1", quantity: 1 },
        { orderItemId: "item_b", variantId: "prod_ful_v1", quantity: 2 },
      ],
    });
    expect(events(sqlite)[0]!.resource_id).toBe("ord_2");

    clear(sqlite);
    sqlite.exec(`INSERT INTO order_payments (id, order_id, amount_minor, payment_method, payment_type, status)
      VALUES ('pay_1', 'ord_2', 1000, 'cod', 'full', 'confirmed')`);
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec(`INSERT INTO order_payments (id, order_id, amount_minor, payment_method, payment_type, status)
      VALUES ('ref_1', 'ord_2', 400, 'cod', 'refund', 'pending')`);
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec("UPDATE order_payments SET status = 'refunded' WHERE id = 'ref_1'");
    sqlite.exec(`INSERT INTO order_payments (id, order_id, amount_minor, payment_method, payment_type, status)
      VALUES ('ref_2', 'ord_2', 100, 'cod', 'refund', 'refunded')`);
    expect(events(sqlite).map((row) => [row.topic, JSON.parse(row.data).paymentId])).toEqual([
      ["order.refunded", "ref_1"],
      ["order.refunded", "ref_2"],
    ]);

    clear(sqlite);
    sqlite.exec(`INSERT INTO order_returns (id, order_id, reason, actor_type) VALUES ('ret_1', 'ord_2', 'Wrong size', 'admin')`);
    sqlite.exec("UPDATE order_returns SET status = 'approved' WHERE id = 'ret_1'");
    sqlite.exec("UPDATE order_returns SET notes = 'Called the customer' WHERE id = 'ret_1'");
    expect(events(sqlite).map((row) => JSON.parse(row.data))).toEqual([
      { returnId: "ret_1", orderId: "ord_2", previousStatus: null, status: "requested" },
      { returnId: "ret_1", orderId: "ord_2", previousStatus: "requested", status: "approved" },
    ]);
    expectReadableFacts();
  });

  it("products: created, updated by revision or tax class, trashed, restored and permanently deleted", () => {
    insertProduct(sqlite, "p1");
    // A new product is published to every sales channel (0122).
    expect(topics(sqlite).filter((topic) => topic !== "product.publication_changed")).toEqual(["product.created"]);

    clear(sqlite);
    sqlite.exec("UPDATE products SET name = 'Draft name' WHERE id = 'p1'");
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec("UPDATE products SET aggregate_revision = aggregate_revision + 1 WHERE id = 'p1'");
    sqlite.exec("UPDATE products SET tax_classification_version = tax_classification_version + 1 WHERE id = 'p1'");
    expect(events(sqlite).map((row) => [row.topic, JSON.parse(row.data).revision])).toEqual([
      ["product.updated", 2],
      ["product.updated", 2],
    ]);

    clear(sqlite);
    sqlite.exec("UPDATE products SET deleted_at = unixepoch(), aggregate_revision = aggregate_revision + 1 WHERE id = 'p1'");
    expect(events(sqlite).map((row) => [row.topic, JSON.parse(row.data).deletion])).toEqual([["product.deleted", "trashed"]]);

    clear(sqlite);
    sqlite.exec("UPDATE products SET deleted_at = NULL, aggregate_revision = aggregate_revision + 1 WHERE id = 'p1'");
    expect(topics(sqlite)).toEqual(["product.updated"]);

    clear(sqlite);
    sqlite.exec("DELETE FROM product_variants WHERE product_id = 'p1'");
    sqlite.exec("DELETE FROM products WHERE id = 'p1'");
    expect(events(sqlite).filter((row) => row.topic !== "product.publication_changed")
      .map((row) => [row.topic, row.resource_id, JSON.parse(row.data).deletion])).toEqual([
      ["product.deleted", "p1", "permanent"],
    ]);
    expectReadableFacts();
  });

  it("product publications: published to every channel, unpublished, republished and removed with the product", () => {
    insertProduct(sqlite, "p9");
    const publications = () => events(sqlite)
      .filter((row) => row.topic === "product.publication_changed")
      .map((row) => {
        const facts = JSON.parse(row.data) as { productId: string; channelId: string; state: string };
        return `${row.resource_id} ${facts.channelId} ${facts.state}`;
      })
      .sort();
    expect(publications()).toEqual([
      "p9 sc_agents published",
      "p9 sc_google published",
      "p9 sc_meta published",
      "p9 sc_online_store published",
    ]);

    clear(sqlite);
    sqlite.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'p9' AND channel_id = 'sc_meta'");
    // Unpublishing what is unpublished, or touching the date only, is no event.
    sqlite.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() + 1 WHERE product_id = 'p9' AND channel_id = 'sc_meta'");
    sqlite.exec("UPDATE product_channel_publications SET published_at = published_at WHERE product_id = 'p9'");
    expect(publications()).toEqual(["p9 sc_meta unpublished"]);

    clear(sqlite);
    sqlite.exec("UPDATE product_channel_publications SET unpublished_at = NULL, published_at = unixepoch() WHERE product_id = 'p9' AND channel_id = 'sc_meta'");
    expect(publications()).toEqual(["p9 sc_meta published"]);

    clear(sqlite);
    sqlite.exec("UPDATE product_channel_publications SET unpublished_at = unixepoch() WHERE product_id = 'p9' AND channel_id = 'sc_google'");
    clear(sqlite);
    sqlite.exec("DELETE FROM product_variants WHERE product_id = 'p9'");
    sqlite.exec("DELETE FROM products WHERE id = 'p9'");
    // Only the channels it was published to report it gone.
    expect(publications()).toEqual([
      "p9 sc_agents unpublished",
      "p9 sc_meta unpublished",
      "p9 sc_online_store unpublished",
    ]);
    expectReadableFacts();
  });

  it("inventory: on-hand movements at a location emit level changes; reservations do not; a compensating delete reverses", () => {
    insertProduct(sqlite, "p2");
    clear(sqlite);
    const movement = (id: string, values: Record<string, string | number | null>) => {
      const row = {
        id,
        variant_id: "p2_v1",
        quantity: 0,
        previous_stock: 0,
        new_stock: 0,
        ledger_version: 2,
        pool: "regular",
        stock_version_before: 1,
        stock_version_after: 2,
        stock_delta: 0,
        previous_reserved_stock: 0,
        new_reserved_stock: 0,
        reserved_stock_delta: 0,
        previous_preorder_stock: 0,
        new_preorder_stock: 0,
        preorder_stock_delta: 0,
        ...values,
      };
      const columns = Object.keys(row);
      sqlite.prepare(`INSERT INTO inventory_movements (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
        .run(...(Object.values(row) as Array<string | number | null>));
    };
    movement("mov_in", { type: "adjusted", quantity: 5, new_stock: 5, stock_delta: 5, location_id: "loc_default" });
    movement("mov_hold", {
      type: "reserved",
      quantity: 2,
      previous_stock: 5,
      new_stock: 5,
      stock_version_before: 2,
      stock_version_after: 3,
      new_reserved_stock: 2,
      reserved_stock_delta: 2,
    });
    expect(events(sqlite).map((row) => JSON.parse(row.data))).toEqual([{
      variantId: "p2_v1",
      productId: "p2",
      locationId: "loc_default",
      quantityDelta: 5,
      movementId: "mov_in",
      movementType: "adjusted",
    }]);

    clear(sqlite);
    sqlite.exec("DELETE FROM inventory_movements WHERE id = 'mov_hold'");
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec("DELETE FROM inventory_movements WHERE id = 'mov_in'");
    expect(events(sqlite).map((row) => JSON.parse(row.data))).toEqual([{
      variantId: "p2_v1",
      productId: "p2",
      locationId: "loc_default",
      quantityDelta: -5,
      movementId: "mov_in",
      movementType: "reversal",
    }]);
    expectReadableFacts();
  });

  it("customers: created, profile updates only (not order counters or sign-in times)", () => {
    sqlite.exec("INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801722222222')");
    expect(topics(sqlite)).toEqual(["customer.created"]);
    clear(sqlite);
    sqlite.exec("UPDATE customers SET total_orders = total_orders + 1, last_order_at = unixepoch(), updated_at = unixepoch() WHERE id = 'cust_1'");
    sqlite.exec("UPDATE customers SET last_authenticated_at = unixepoch() WHERE id = 'cust_1'");
    expect(topics(sqlite)).toEqual([]);
    sqlite.exec("UPDATE customers SET email = 'karim@example.test' WHERE id = 'cust_1'");
    expect(events(sqlite).map((row) => JSON.parse(row.data))).toEqual([{ customerId: "cust_1" }]);
    expectReadableFacts();
  });

  it("orders: channel is enforced and immutable", () => {
    insertOrder(sqlite, "ord_admin", { channel: "admin", channel_source: "facebook" });
    expect(sqlite.prepare("SELECT channel, channel_source FROM orders WHERE id = 'ord_admin'").get()).toEqual({
      channel: "admin",
      channel_source: "facebook",
    });
    expect(JSON.parse(events(sqlite).find((row) => row.resource_id === "ord_admin")!.data).channel).toBe("admin");
    expect(() => insertOrder(sqlite, "ord_bad", { channel: "marketplace" })).toThrow(/orders_channel_check/);
    expect(() => insertOrder(sqlite, "ord_upper", { channel_source: "Facebook" })).toThrow(/orders_channel_source_shape/);
    expect(() => insertOrder(sqlite, "ord_long", { channel_source: "x".repeat(65) })).toThrow(/orders_channel_source_shape/);
    expect(() => sqlite.exec("UPDATE orders SET channel = 'online_store' WHERE id = 'ord_admin'")).toThrow(/order channel is immutable/);
    sqlite.exec("UPDATE orders SET channel_source = 'instagram' WHERE id = 'ord_admin'");
  });
});

describe(`${MIGRATION} transactions`, () => {
  it("rolls the event back with the write when the batch fails", async () => {
    const { sqlite, db } = createSqliteD1Database();
    try {
      sqlite.exec(`INSERT INTO webhook_subscriptions (id, url, topics, api_version, secret_ciphertext, secret_hint)
        VALUES ('whs_transaction', 'https://hooks.example.test/orders', '["order.*"]', '2026-10', 'enc:test', 'test')`);
      const order = {
        id: "ord_tx",
        customerName: "Rahim",
        customerPhone: "+8801711111111",
        shippingAddress: "House 1",
        city: "city_1",
        zone: "zone_1",
        status: "pending",
      };
      await expect(safeBatch(db, [
        db.insert(orders).values(order),
        db.insert(orders).values(order), // primary-key conflict aborts the batch
      ])).rejects.toThrow();
      expect(sqlite.prepare("SELECT count(*) AS n FROM orders").get()).toEqual({ n: 0 });
      expect(sqlite.prepare("SELECT count(*) AS n FROM event_outbox").get()).toEqual({ n: 0 });

      await safeBatch(db, [db.insert(orders).values(order), db.update(orders).set({ status: "confirmed" }).where(eq(orders.id, "ord_tx"))]);
      expect(events(sqlite).map((row) => row.topic)).toEqual(["order.created", "order.updated"]);
    } finally {
      sqlite.close();
    }
  });
});

describe(`${MIGRATION} backfill`, () => {
  it("names admin-created and agent-created orders and leaves the rest online_store", () => {
    const sqlite = createMigratedSqlite({ beforeMigration: `${MIGRATION}.sql` });
    try {
      for (const id of ["ord_web", "ord_admin", "ord_agent"]) {
        sqlite.prepare(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
          VALUES (?, 'A', '+8801711111111', 'House', 'city', 'zone')`).run(id);
      }
      sqlite.exec(`INSERT INTO admin_order_create_attempts (id, request_key_hash, request_hash, order_id, status)
        VALUES ('att_1', 'key', 'hash', 'ord_admin', 'committed')`);
      sqlite.exec("PRAGMA foreign_keys = OFF");
      sqlite.exec(`INSERT INTO agent_storefront_order_grants (context_id, order_id, authority_kind, expires_at)
        VALUES ('ctx_1', 'ord_agent', 'created', unixepoch() + 3600)`);
      sqlite.exec("PRAGMA foreign_keys = ON");
      sqlite.exec(compiledMigrationSql("d1", undefined, `${MIGRATION}.sql`).split(BREAKPOINT).filter((statement) => statement.trim()).join(";\n"));
      expect(sqlite.prepare("SELECT id, channel FROM orders ORDER BY id").all()).toEqual([
        { id: "ord_admin", channel: "admin" },
        { id: "ord_agent", channel: "agent" },
        { id: "ord_web", channel: "online_store" },
      ]);
      // The backfill runs before the event triggers exist.
      expect(sqlite.prepare("SELECT count(*) AS n FROM event_outbox").get()).toEqual({ n: 0 });
    } finally {
      sqlite.close();
    }
  }, 60_000);
});

describe(`${MIGRATION} on the Turso engine`, () => {
  it("applies every 0103 statement and fires the triggers", async () => {
    const database = await freshTursoEngineStore();
    await database.exec("INSERT INTO event_demand (filter) VALUES ('order.*')");
    await database.exec(`INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status)
      VALUES ('ord_t', 'A', '+8801711111111', 'House', 'city', 'zone', 'pending')`);
    await database.exec("UPDATE orders SET payment_status = 'paid' WHERE id = 'ord_t'");
    const rows = await database.prepare("SELECT id, topic, data FROM event_outbox ORDER BY topic").all() as Array<{ id: string; topic: string; data: string }>;
    expect(rows.map((row) => row.topic)).toEqual(["order.created", "order.paid", "order.updated"]);
    for (const row of rows) {
      expect(row.id).toMatch(/^evt_\d{13}[0-9a-f]{12}$/);
      expect(parseEventFacts(row.topic as EventTopic, row.data)).not.toBeNull();
    }
    await database.close();
  }, 120_000);
});
