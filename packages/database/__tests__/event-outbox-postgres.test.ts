// PostgreSQL parity for 0103_order_channel_event_outbox: an 0102 schema
// upgraded by the sidecar equals the fresh schema compiled from the canonical
// SQLite chain (columns, constraints, indexes, triggers, trigger functions),
// the backfill names admin and agent orders, and the generated event triggers
// write catalog-valid facts with JSON numbers, inside the writer's transaction.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { parseEventFacts, type EventTopic } from "../../shared/src/events";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecar = join(import.meta.dirname, "../migrations/postgres/0103_order_channel_event_outbox.sql");

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_events_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({
    connectionString: url.toString(),
    types: {
      getTypeParser: ((oid: number, format?: "text" | "binary") =>
        oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser,
    },
  });
  await client.connect();
  await client.query(schemaSql);
  openClients.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function applySidecar(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of readFileSync(sidecar, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`0103_order_channel_event_outbox: ${(error as Error).message}`);
  }
}

async function catalog(client: Client) {
  const query = async (sql: string) => (await client.query(sql)).rows;
  return {
    columns: await query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'scalius_schema_migrations'
      ORDER BY table_name, column_name
    `),
    constraints: await query(`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2, 3
    `),
    indexes: await query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY tablename, indexname
    `),
    triggers: await query(`
      SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2
    `),
    functions: await query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p WHERE p.pronamespace = 'scalius_compat'::regnamespace ORDER BY p.proname, 2
    `),
  };
}

describe.runIf(postgresUrl)("0103 order channel and event outbox on PostgreSQL", () => {
  it("upgrades an 0102 schema to exactly the fresh 0103 schema and backfills the channel", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema({ beforeMigration: "0104_" }),
      compileCanonicalPostgresSchema({ beforeMigration: "0103_" }),
    ]);
    const freshDatabase = await database(fresh.sql);
    const upgraded = await database(before.sql);
    await upgraded.query(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone)
        VALUES ('ord_web', 'A', '+8801711111111', 'House', 'city', 'zone'),
               ('ord_admin', 'A', '+8801711111111', 'House', 'city', 'zone');
      INSERT INTO admin_order_create_attempts (id, request_key_hash, request_hash, order_id, status)
        VALUES ('att_1', 'key', 'hash', 'ord_admin', 'committed');
    `);
    await applySidecar(upgraded);

    const [expected, actual] = await Promise.all([catalog(freshDatabase), catalog(upgraded)]);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.triggers).toEqual(expected.triggers);
    expect(actual.functions).toEqual(expected.functions);
    expect((await upgraded.query("SELECT id, channel FROM orders ORDER BY id")).rows).toEqual([
      { id: "ord_admin", channel: "admin" },
      { id: "ord_web", channel: "online_store" },
    ]);
    expect((await upgraded.query("SELECT count(*)::int AS n FROM event_outbox")).rows).toEqual([{ n: 0 }]);
  }, 180_000);

  it("writes catalog-valid events with typed facts, and rolls them back with the write", async () => {
    const fresh = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(fresh.sql);
    // The fresh schema has no data rows: add the default location the 0102 data step creates.
    await client.query(`
      INSERT INTO inventory_locations (id, name, code, kind, is_default, status, position, version)
        VALUES ('loc_default', 'Main location', 'MAIN', 'warehouse', 1, 'active', 0, 1);
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, channel, channel_source)
        VALUES ('ord_1', 'A', '+8801711111111', 'House', 'city', 'zone', 'admin', 'walk_in');
      UPDATE orders SET status = 'confirmed', payment_status = 'paid' WHERE id = 'ord_1';
      INSERT INTO products (id, name, slug) VALUES ('p1', 'Tee', 'tee');
      INSERT INTO product_variants (id, product_id, sku, is_default) VALUES ('p1_v1', 'p1', 'TEE-1', 1);
      INSERT INTO inventory_movements (id, variant_id, type, quantity, previous_stock, new_stock, ledger_version, pool,
        stock_version_before, stock_version_after, stock_delta, previous_reserved_stock, new_reserved_stock,
        reserved_stock_delta, previous_preorder_stock, new_preorder_stock, preorder_stock_delta, location_id)
        VALUES ('mov_1', 'p1_v1', 'adjusted', 4, 0, 4, 2, 'regular', 1, 2, 4, 0, 0, 0, 0, 0, 0, 'loc_default');
      INSERT INTO customers (id, name, phone) VALUES ('cust_1', 'Karim', '+8801722222222');
    `);
    const rows = (await client.query("SELECT id, topic, data FROM event_outbox ORDER BY topic, id")).rows as Array<{ id: string; topic: string; data: string }>;
    expect(rows.map((row) => row.topic)).toEqual([
      "customer.created",
      "variant.inventory_changed",
      "order.created",
      "order.paid",
      "order.updated",
      "product.created",
    ]);
    for (const row of rows) {
      expect(row.id).toMatch(/^evt_\d{13}[0-9a-f]{12}$/);
      expect(parseEventFacts(row.topic as EventTopic, row.data), row.data).not.toBeNull();
    }
    expect(JSON.parse(rows.find((row) => row.topic === "variant.inventory_changed")!.data)).toMatchObject({
      quantityDelta: 4,
      productId: "p1",
      locationId: "loc_default",
    });
    expect(JSON.parse(rows.find((row) => row.topic === "order.created")!.data)).toMatchObject({ channel: "admin" });
    await expect(client.query("UPDATE orders SET channel = 'online_store' WHERE id = 'ord_1'")).rejects.toThrow(/immutable/);

    await client.query("BEGIN");
    await client.query("INSERT INTO customers (id, name, phone) VALUES ('cust_2', 'Rahim', '+8801733333333')");
    await client.query("ROLLBACK");
    expect((await client.query("SELECT count(*)::int AS n FROM event_outbox WHERE resource_id = 'cust_2'")).rows).toEqual([{ n: 0 }]);
  }, 180_000);
});
