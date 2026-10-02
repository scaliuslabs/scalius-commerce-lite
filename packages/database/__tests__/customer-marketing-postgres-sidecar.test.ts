// PostgreSQL sidecar for 0108_customer_marketing, on the upgrade path a real
// PostgreSQL store follows (the fresh 0103 schema plus every later sidecar):
// outbox rows survive the CHECK swap, order statistics are backfilled and
// maintained by the triggers, and consent changes write the audit row and
// the event. (A fresh-schema parity check needs the canonical compiler to
// create the unique indexes composite foreign keys reference (0104) before
// the tables that use them; it cannot compile any schema from 0104 on yet.)
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecars = ["0104_custom_fields", "0105_plugin_runtime", "0106_theme_document_v6", "0107_plugin_platform", "0108_customer_marketing"]
  .map((name) => join(import.meta.dirname, `../migrations/postgres/${name}.sql`));

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_cm_${randomUUID().replaceAll("-", "")}`;
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

async function applySidecar(client: Client, file: string): Promise<void> {
  const sql = readFileSync(file, "utf8");
  await client.query("BEGIN");
  try {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

describe.runIf(postgresUrl)("0108 customers & marketing PostgreSQL sidecar", () => {
  it("keeps outbox rows, backfills statistics and runs the consent and statistics triggers", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0104_" });
    const client = await database(before.sql);
    for (const file of sidecars.slice(0, -1)) await applySidecar(client, file);
    await client.query(`
      INSERT INTO customers (id, name, phone) VALUES ('cust_a', 'A', '+8801711111111'), ('cust_b', 'B', '+8801722222222');
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, customer_id, paid_amount_minor, created_at)
      VALUES ('ord_1', 'A', '+8801711111111', 'House', 'c', 'z', 'pending', 'cust_a', 5000, 1700000000),
             ('ord_2', 'A', '+8801711111111', 'House', 'c', 'z', 'incomplete', 'cust_a', 0, 1710000000);
      INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, order_id, audience, notification_type, source, payload)
      VALUES ('nob_1', 'k1', 'order', 'ord_1', 'ord_1', 'customer', 'order_created', 'checkout', '{}');
    `);
    await applySidecar(client, sidecars.at(-1)!);
    expect((await client.query("SELECT id FROM notification_outbox")).rows).toEqual([{ id: "nob_1" }]);
    expect((await client.query("SELECT customer_id, orders_count, total_spent_minor, first_order_at, last_order_at FROM customer_order_stats")).rows)
      .toEqual([{ customer_id: "cust_a", orders_count: 1, total_spent_minor: 5000, first_order_at: 1700000000, last_order_at: 1700000000 }]);

    await client.query("BEGIN");
    await client.query(`INSERT INTO notification_outbox (id, dedupe_key, subject_type, subject_id, audience, notification_type, source, payload)
      VALUES ('nob_2', 'k2', 'customer', 'cust_a', 'customer', 'marketing_opt_in', 'newsletter', '{}')`);
    await client.query("UPDATE orders SET status = 'pending', paid_amount_minor = 700 WHERE id = 'ord_2'");
    await client.query("UPDATE orders SET customer_id = 'cust_b' WHERE id = 'ord_1'");
    expect((await client.query("SELECT customer_id, orders_count, total_spent_minor FROM customer_order_stats ORDER BY customer_id")).rows).toEqual([
      { customer_id: "cust_a", orders_count: 1, total_spent_minor: 700 },
      { customer_id: "cust_b", orders_count: 1, total_spent_minor: 5000 },
    ]);
    await client.query(`INSERT INTO customer_marketing_consents (customer_id, channel, state, contact, source, actor, subscribed_at)
      VALUES ('cust_a', 'sms', 'subscribed', '+8801711111111', 'checkout', 'buyer', 1)`);
    await client.query(`UPDATE customer_marketing_consents SET state = 'unsubscribed', unsubscribed_at = 2, source = 'link'
      WHERE customer_id = 'cust_a' AND channel = 'sms'`);
    expect((await client.query("SELECT id, previous_state, state FROM customer_marketing_consent_events ORDER BY id")).rows).toEqual([
      { id: "mce_cust_a_sms_1", previous_state: null, state: "subscribed" },
      { id: "mce_cust_a_sms_2", previous_state: "subscribed", state: "unsubscribed" },
    ]);
    // Ids of one millisecond differ only in random hex: compare without order.
    const events = (await client.query("SELECT data FROM event_outbox WHERE topic = 'customer.consent_changed'")).rows as Array<{ data: string }>;
    expect(events).toHaveLength(2);
    expect(events.map((row) => JSON.parse(row.data))).toEqual(expect.arrayContaining([
      { customerId: "cust_a", channel: "sms", previousState: null, state: "subscribed", source: "checkout" },
      { customerId: "cust_a", channel: "sms", previousState: "subscribed", state: "unsubscribed", source: "link" },
    ]));
    await client.query("ROLLBACK");
  }, 240_000);
});
