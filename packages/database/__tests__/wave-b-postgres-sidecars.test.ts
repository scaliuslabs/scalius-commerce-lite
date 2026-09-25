// PostgreSQL sidecar parity for the Wave B migrations (0093-0096): a pre-0093
// schema upgraded by the sidecars must equal the fresh schema compiled from
// the canonical SQLite chain (columns, constraints, indexes, triggers, trigger
// functions and the calendar `unixepoch` compat function), and the upgraded
// store must enforce the same guards and compute the same warranty expiry as
// SQLite (W3).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. Each test
// creates and drops its own databases there.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const migrationsDirectory = join(import.meta.dirname, "../migrations/postgres");
const WAVE_B_SIDECARS = ["0093_reviews", "0094_digital_goods", "0095_gift_cards", "0096_warranty"] as const;

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_wave_b_${randomUUID().replaceAll("-", "")}`;
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

async function applySidecars(client: Client): Promise<void> {
  for (const name of WAVE_B_SIDECARS) {
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
        OR (p.pronamespace = 'public'::regnamespace AND p.proname = 'unixepoch')
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

describe.runIf(postgresUrl)("Wave B PostgreSQL sidecars", () => {
  it("upgrade a pre-0093 schema to exactly the fresh schema", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema(),
      compileCanonicalPostgresSchema({ beforeMigration: "0093_" }),
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
      "product_reviews_line_eligible",
      "product_reviews_stats_add_update",
      "orders_delivered_review_request",
      "digital_licence_keys_transition",
      "gift_card_transactions_balance_guard",
      "gift_cards_balance_projection_guard",
      "order_fulfillment_lines_warranty_insert",
      "order_fulfillments_warranty_void",
    ]));
  }, 180_000);

  it("enforce the review, gift-card and warranty guards and match SQLite's warranty expiry", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0093_" });
    const client = await database(before.sql);
    await client.query("SET session_replication_role = replica"); // seed without parents
    await client.query(`
      INSERT INTO orders (id, customer_name, customer_phone, shipping_address, city, zone, status, updated_at)
      VALUES ('ord_1', 'Buyer', '01700000000', 'House 1', 'c', 'z', 'confirmed', 1790000000);
      INSERT INTO order_items (id, order_id, product_id, variant_id, quantity, unit_price_minor)
      VALUES ('item_a', 'ord_1', 'prod_1', 'var_1', 2, 10000);
    `);
    await client.query("SET session_replication_role = origin");
    await applySidecars(client);
    // Foreign keys are deferred to commit and this transaction rolls back, so
    // rows may omit their parents while every trigger still fires.
    await client.query("BEGIN");

    // R1 + R3 + the review request.
    const review = (id: string, rating: number) => `
      INSERT INTO product_reviews (id, product_id, variant_id, order_id, order_item_id, reviewer_key, author_type,
        author_display_name, rating, status, published_at)
      VALUES ('${id}', 'prod_1', 'var_1', 'ord_1', 'item_a', 'cus_1', 'customer', 'Rahim K.', ${rating}, 'published', 1790000000)`;
    await rejects(client, review("rev_pg_000000001", 4), /fulfilled line of a delivered order/);
    await client.query(`
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type, created_at)
      VALUES ('ful_1', 'ord_1', 'ship', 'send', 'admin', 1790000000);
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fln_1', 'ful_1', 'ord_1', 'item_a', 1);
      UPDATE orders SET status = 'delivered' WHERE id = 'ord_1';
    `);
    expect((await client.query("SELECT order_id, status FROM order_review_requests")).rows)
      .toEqual([{ order_id: "ord_1", status: "scheduled" }]);
    await client.query(review("rev_pg_000000001", 4));
    await client.query("UPDATE product_reviews SET rating = 2 WHERE id = 'rev_pg_000000001'");
    expect((await client.query(`
      SELECT review_count, rating_sum, count_2, count_4, rating_avg_centi, rating_rank_milli FROM product_review_stats
    `)).rows).toEqual([{
      review_count: 1, rating_sum: 2, count_2: 1, count_4: 0,
      rating_avg_centi: 200, rating_rank_milli: Math.floor(((2 + 15) * 1000) / 6),
    }]);
    await client.query("UPDATE product_reviews SET status = 'withdrawn' WHERE id = 'rev_pg_000000001'");
    expect((await client.query("SELECT review_count, rating_avg_centi, rating_rank_milli FROM product_review_stats")).rows)
      .toEqual([{ review_count: 0, rating_avg_centi: null, rating_rank_milli: null }]);

    // G1.
    await client.query(`
      INSERT INTO gift_cards (id, code_hash, code_ciphertext, code_last4, currency_code, initial_amount_minor, source)
      VALUES ('gc_pg_000001', 'h', 'c', '7K2Q', 'BDT', 1000, 'manual');
      INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type)
      VALUES ('gct_pg_0000001', 'gc_pg_000001', 'issue', 1000, 1000, 'issue:1', 'system');
    `);
    await rejects(client, `
      INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type)
      VALUES ('gct_pg_0000002', 'gc_pg_000001', 'redeem', -1001, -1, 'redeem:1', 'system')
    `, /gift card balance/);
    await rejects(client, "UPDATE gift_cards SET balance_minor = 5", /only through transactions/);
    await client.query("UPDATE gift_cards SET status = 'disabled'");
    await rejects(client, `
      INSERT INTO gift_card_transactions (id, gift_card_id, kind, amount_minor, balance_after_minor, idempotency_key, actor_type)
      VALUES ('gct_pg_0000003', 'gc_pg_000001', 'redeem', -10, 990, 'redeem:2', 'system')
    `, /gift card unavailable/);
    expect((await client.query("SELECT balance_minor FROM gift_cards")).rows).toEqual([{ balance_minor: 1000 }]);

    // W1-W3: the trigger's expiry equals SQLite's for month-end and leap-day starts.
    const sqlite = new DatabaseSync(":memory:");
    const starts = ["2024-01-31T10:30:00Z", "2024-02-29T00:00:00Z", "2025-12-31T23:59:59Z", "2026-03-31T12:00:00Z"]
      .map((iso) => Date.parse(iso) / 1000);
    const durations: Array<[number, string]> = [[1, "months"], [13, "months"], [1, "years"], [45, "days"], [120, "months"]];
    for (const start of starts) {
      for (const [value, unit] of durations) {
        const modifier = `+${value} ${unit}`;
        const expected = Number((sqlite.prepare("SELECT unixepoch(?, 'unixepoch', ?) AS at").get(start, modifier) as { at: number }).at);
        const actual = (await client.query("SELECT unixepoch($1::bigint, 'unixepoch', $2) AS at", [start, modifier])).rows[0].at;
        expect([start, modifier, actual]).toEqual([start, modifier, expected]);
      }
    }
    await client.query(`
      INSERT INTO warranty_policies (id, name, provider, duration_value, duration_unit, replacement_days, current_revision_id)
      VALUES ('wrp_pg_000001', '1 month', 'store', 1, 'months', 7, 'wrr_pg_000001');
      INSERT INTO warranty_policy_revisions (id, policy_id, revision, name, provider, duration_value, duration_unit, replacement_days)
      VALUES ('wrr_pg_000001', 'wrp_pg_000001', 1, '1 month', 'store', 1, 'months', 7);
      INSERT INTO order_items (id, order_id, product_id, quantity, unit_price_minor, warranty_revision_id)
      VALUES ('item_w', 'ord_1', 'prod_1', 1, 5000, 'wrr_pg_000001');
      INSERT INTO order_fulfillments (id, order_id, kind, request_key, actor_type, created_at)
      VALUES ('ful_w', 'ord_1', 'ship', 'send-w', 'admin', ${starts[0]});
      INSERT INTO order_fulfillment_lines (id, fulfillment_id, order_id, order_item_id, quantity)
      VALUES ('fln_w', 'ful_w', 'ord_1', 'item_w', 1);
    `);
    expect((await client.query("SELECT id, starts_at, expires_at, replacement_until FROM order_item_warranties")).rows).toEqual([{
      id: "wty_fln_w", starts_at: starts[0],
      expires_at: Date.parse("2024-03-02T10:30:00Z") / 1000, replacement_until: starts[0]! + 7 * 86_400,
    }]);
    await rejects(client, "UPDATE warranty_policy_revisions SET duration_value = 2", /immutable/);
    await rejects(client, "UPDATE order_items SET warranty_revision_id = NULL WHERE id = 'item_w'", /frozen at commit/);
    await client.query("UPDATE order_fulfillments SET status = 'voided', voided_at = 1790000001 WHERE id = 'ful_w'");
    expect((await client.query("SELECT voided_at FROM order_item_warranties")).rows).toEqual([{ voided_at: 1_790_000_001 }]);
    await client.query("ROLLBACK");
  }, 180_000);
});
