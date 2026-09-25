// PostgreSQL sidecar parity for the Wave A migrations (0083-0088): an 0082
// schema upgraded by the sidecars must equal the fresh schema compiled from
// the canonical SQLite chain (columns, constraints, indexes, triggers and
// trigger functions), and the upgrade must backfill the fulfilment ledger and
// enforce the same guards as SQLite.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. Each test
// creates and drops its own databases there.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const migrationsDirectory = join(import.meta.dirname, "../migrations/postgres");
const WAVE_A_SIDECARS = [
  "0083_order_line_fulfilment",
  "0084_line_item_properties",
  "0085_conversations",
  "0086_notification_outbox",
  "0087_on_sale_indexes",
  "0088_wave_a_contract",
] as const;

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_wave_a_${randomUUID().replaceAll("-", "")}`;
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

async function applySidecars(client: Client, names: readonly string[] = WAVE_A_SIDECARS): Promise<void> {
  for (const name of names) {
    const sql = readFileSync(join(migrationsDirectory, `${name}.sql`), "utf8");
    await client.query("BEGIN");
    try {
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`${name}: ${(error as Error).message}`);
    }
  }
}

/** Everything the migrations define, in a column-order-independent form. */
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
      FROM pg_constraint
      WHERE connamespace = 'public'::regnamespace
      ORDER BY 1, 2, 3
    `),
    indexes: await query(`
      SELECT tablename, indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public'
      ORDER BY tablename, indexname
    `),
    triggers: await query(`
      SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal
      ORDER BY 1, 2
    `),
    functions: await query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      WHERE p.pronamespace = 'scalius_compat'::regnamespace
      ORDER BY p.proname, 2
    `),
  };
}

async function rejects(client: Client, sql: string, pattern: RegExp): Promise<void> {
  await client.query("SAVEPOINT guard");
  try {
    await expect(client.query(sql)).rejects.toThrow(pattern);
  } finally {
    await client.query("ROLLBACK TO SAVEPOINT guard");
  }
}

describe.runIf(postgresUrl)("Wave A PostgreSQL sidecars", () => {
  it("upgrade an 0082 schema to exactly the fresh schema", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema(),
      compileCanonicalPostgresSchema({ beforeMigration: "0083_" }),
    ]);
    const freshDatabase = await database(fresh.sql);
    const upgraded = await database(before.sql);
    await applySidecars(upgraded);

    const [expected, actual] = await Promise.all([catalog(freshDatabase), catalog(upgraded)]);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.triggers).toEqual(expected.triggers);
    expect(actual.functions).toEqual(expected.functions);
    expect(actual.triggers.map((row) => row.tgname)).toEqual(expect.arrayContaining([
      "order_fulfillment_lines_project_insert",
      "order_fulfillments_project_void",
      "orders_shipping_address_required_insert",
      "conversation_messages_seq_insert",
    ]));
  }, 120_000);

  it("backfill the ledger and enforce the ledger, address, snapshot and sequence guards", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0083_" });
    const client = await database(before.sql);
    await client.query("SET session_replication_role = replica"); // seed without parents
    await client.query(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, updated_at)
      VALUES ('ord_1', 'Buyer', '01700000000', 'House 1', 'c', 'z', 1790000000);
      INSERT INTO order_items (id, order_id, product_id, quantity, shipped_quantity, unit_price_minor, fulfillment_status)
      VALUES ('item_a', 'ord_1', 'prod_1', 3, 1, 10000, 'pending'),
             ('item_b', 'ord_1', 'prod_1', 1, 0, 5000, 'pending');
    `);
    await client.query("SET session_replication_role = origin");
    await applySidecars(client);

    expect((await client.query(
      "SELECT order_item_id, quantity FROM order_fulfillment_lines ORDER BY order_item_id",
    )).rows).toEqual([{ order_item_id: "item_a", quantity: 1 }]);
    expect((await client.query(
      "SELECT id, fulfilled_quantity, fulfillment_type, base_unit_price_minor FROM order_items ORDER BY id",
    )).rows).toEqual([
      { id: "item_a", fulfilled_quantity: 1, fulfillment_type: "ship", base_unit_price_minor: 10_000 },
      { id: "item_b", fulfilled_quantity: 0, fulfillment_type: "ship", base_unit_price_minor: 5_000 },
    ]);

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type)
      VALUES ('ful_1', 'ord_1', 'ship', 'send-rest', 'admin');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fln_1', 'ful_1', 'ord_1', 'item_a', 2);
    `);
    expect((await client.query("SELECT fulfilled_quantity FROM order_items WHERE id = 'item_a'")).rows)
      .toEqual([{ fulfilled_quantity: 3 }]);
    await rejects(client, `
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fln_over', 'ful_1', 'ord_1', 'item_b', 2)
    `, /exceeds the unfulfilled line quantity/);
    await rejects(client, "UPDATE order_fulfillment_lines SET quantity = 1", /immutable/);
    await rejects(client, "UPDATE order_fulfillments SET kind = 'pickup'", /active to voided/);
    await rejects(client, "UPDATE order_items SET fulfillment_type = 'pickup' WHERE id = 'item_b'", /immutable/);
    await client.query("UPDATE order_fulfillments SET status = 'voided', voided_at = 1 WHERE id = 'ful_1'");
    expect((await client.query("SELECT fulfilled_quantity FROM order_items WHERE id = 'item_a'")).rows)
      .toEqual([{ fulfilled_quantity: 1 }]);

    await rejects(client, `
      INSERT INTO orders (id, customer_name, customer_phone) VALUES ('ord_no_address', 'Buyer', '01700000000')
    `, /shipping address required/);
    await client.query(`
      INSERT INTO orders (id, customer_name, customer_phone, requires_shipping, shipping_method_kind, pickup_address)
      VALUES ('ord_pickup', 'Buyer', '01700000000', 0, 'pickup', 'Shop 4')
    `);
    await rejects(client, "UPDATE orders SET requires_shipping = 1 WHERE id = 'ord_pickup'", /shipping address required/);

    await client.query(`
      INSERT INTO order_items (id, order_id, product_id, quantity, properties, properties_price_minor)
      VALUES ('item_custom', 'ord_1', 'prod_1', 1, '[{"key":"engraving"}]', 20000)
    `);
    await rejects(client, "UPDATE order_items SET properties = '[]' WHERE id = 'item_custom'", /immutable/);

    await client.query(`
      INSERT INTO conversations (id, subject_type, order_id) VALUES ('cnv_order00001', 'order', 'ord_1');
      UPDATE conversations SET last_seq = 1 WHERE id = 'cnv_order00001';
      INSERT INTO conversation_messages (id, conversation_id, seq, kind, author_type, body)
      VALUES ('msg_00000001', 'cnv_order00001', 1, 'message', 'guest_receipt', 'Where is my parcel?');
    `);
    await rejects(client, `
      INSERT INTO conversation_messages (id, conversation_id, seq, kind, author_type, body)
      VALUES ('msg_00000002', 'cnv_order00001', 2, 'message', 'guest_receipt', 'Hello?')
    `, /must equal the conversation sequence/);
    await rejects(client, "UPDATE conversations SET last_seq = 3 WHERE id = 'cnv_order00001'", /one message at a time/);
    await rejects(client, "DELETE FROM conversation_messages", /append-only/);
    await client.query("ROLLBACK");
  }, 120_000);

  it("0088: record the previous API's unrecorded sends, bound returns by the ledger and drop the replaced tables", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0088_" });
    const client = await database(before.sql);
    await client.query("SET session_replication_role = replica"); // seed without parents
    await client.query(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, updated_at)
      VALUES ('ord_1', 'Buyer', '01700000000', 'House 1', 'c', 'z', 1790100000);
      INSERT INTO products (id, name, slug) VALUES ('prod_1', 'Kurta', 'kurta');
      INSERT INTO order_items (id, order_id, product_id, quantity, shipped_quantity, unit_price_minor, fulfillment_status)
      VALUES ('item_gap', 'ord_1', 'prod_1', 3, 2, 10000, 'pending'),
             ('item_back', 'ord_1', 'prod_1', 2, 2, 10000, 'shipped');
    `);
    await client.query("SET session_replication_role = origin");
    await client.query(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type)
      VALUES ('ful_mig_ord_1', 'ord_1', 'ship', 'migration:0083', 'system');
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fln_mig_item_back', 'ful_mig_ord_1', 'ord_1', 'item_back', 2);
      UPDATE order_fulfillments SET status = 'voided', voided_at = 1 WHERE id = 'ful_mig_ord_1';
    `);
    await applySidecars(client, ["0088_wave_a_contract"]);

    expect((await client.query(
      "SELECT id, fulfillment_id, order_item_id, quantity FROM order_fulfillment_lines WHERE id LIKE 'fln_mig2_%'",
    )).rows).toEqual([{ id: "fln_mig2_item_gap", fulfillment_id: "ful_mig2_ord_1", order_item_id: "item_gap", quantity: 2 }]);
    expect((await client.query("SELECT id, fulfilled_quantity FROM order_items ORDER BY id")).rows).toEqual([
      { id: "item_back", fulfilled_quantity: 0 },
      { id: "item_gap", fulfilled_quantity: 2 },
    ]);
    expect((await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN (
        'order_notification_delivery_receipts', 'order_notification_outbox', 'order_support_request_events', '_wave_a_contract_gap'
      )
    `)).rows).toEqual([]);

    await client.query("BEGIN");
    await client.query("INSERT INTO order_returns (id, order_id, reason, actor_type) VALUES ('ret_1', 'ord_1', 'damaged', 'admin')");
    // item_back still says shipped, but the ledger says nothing is out.
    await rejects(client, `
      INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, requested_quantity, inventory_tracked)
      VALUES ('rl_back', 'ret_1', 'ord_1', 'item_back', 1, 0)
    `, /shipped item|exceeds fulfilled item quantity/);
    await rejects(client, `
      INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, requested_quantity, inventory_tracked)
      VALUES ('rl_over', 'ret_1', 'ord_1', 'item_gap', 3, 0)
    `, /exceeds fulfilled item quantity/);
    await client.query(`
      INSERT INTO order_return_lines (id, return_id, order_id, order_item_id, requested_quantity, inventory_tracked)
      VALUES ('rl_ok', 'ret_1', 'ord_1', 'item_gap', 2, 0)
    `);
    await client.query("ROLLBACK");
  }, 120_000);
});
