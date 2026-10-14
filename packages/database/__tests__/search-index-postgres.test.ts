// PostgreSQL side of migration 0152 (the search index). Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server.
// - The sidecar upgrades an 0151 store to exactly the fresh schema, and its
//   backfill stores what the triggers store for the same rows.
// - PostgreSQL stores the same terms and counts as SQLite (Turso) does.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { createMigratedSqlite } from "../src/testing/sqlite-d1";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_search_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  await client.query(schemaSql);
  cleanups.push(async () => {
    await client.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return client;
}

async function catalog(client: Client) {
  const query = async (sql: string) => (await client.query(sql)).rows;
  return {
    columns: await query(`SELECT table_name, column_name, data_type, collation_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'scalius_schema_migrations' ORDER BY 1, 2`),
    indexes: await query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2"),
    triggers: await query("SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2"),
    functions: await query("SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p WHERE p.pronamespace = 'scalius_compat'::regnamespace ORDER BY 1, 2"),
  };
}

const ROWS = [
  "INSERT INTO products (id, name, price_minor, slug, description) VALUES ('p1', 'Café T-Shirt (Men''s)', 100, 'p1', 'জামা প্রোডাক্ট… ৳৫০০ — 100% cotton')",
  "INSERT INTO products (id, name, price_minor, slug, description) VALUES ('p2', 'র‍্যাব ক্যাপ', 100, 'p2', NULL)",
  "INSERT INTO customers (id, name, phone, email) VALUES ('c1', 'Rahim Uddin', '+8801712345678', 'rahim.uddin@example.com')",
  "INSERT INTO categories (id, name, slug, status, description) VALUES ('cat1', 'Bags & Wallets', 'bags', 'published', 'Leather “premium”')",
  "INSERT INTO pages (id, title, slug, content) VALUES ('pg1', 'Return Policy', 'returns', '<p>Returns within 7 days.</p>')",
];
const TERMS = "SELECT source, doc_id, col, term, tf FROM search_fts_terms ORDER BY 1, 2, 3, 4";

describe.runIf(postgresUrl)("0152 search index on PostgreSQL", { timeout: 300_000 }, () => {
  it("upgrades an 0151 store to exactly the fresh schema and backfills what the triggers store", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema(),
      compileCanonicalPostgresSchema({ beforeMigration: "0152_" }),
    ]);
    expect(fresh.derivedTables).toBe(1);
    expect(before.derivedTables).toBe(0);
    const freshClient = await database(fresh.sql);
    const upgraded = await database(before.sql);
    for (const row of ROWS) {
      await freshClient.query(row);
      await upgraded.query(row);
    }
    await upgraded.query("BEGIN");
    for (const statement of readFileSync(new URL("../migrations/postgres/0152_search_index.sql", import.meta.url), "utf8").split("--> statement-breakpoint")) {
      if (statement.trim() && !/scalius_schema_migrations/.test(statement)) await upgraded.query(statement);
    }
    await upgraded.query("COMMIT");
    const [expected, actual] = await Promise.all([catalog(freshClient), catalog(upgraded)]);
    expect(actual).toEqual(expected);
    const statistics = "SELECT attstattarget FROM pg_attribute WHERE attrelid = 'search_fts_terms'::regclass AND attname = 'term'";
    for (const client of [freshClient, upgraded]) expect((await client.query(statistics)).rows).toEqual([{ attstattarget: 10000 }]);
    expect((await upgraded.query(TERMS)).rows).toEqual((await freshClient.query(TERMS)).rows);
    expect((await upgraded.query("SELECT term FROM search_fts_terms WHERE doc_id = 'p1' AND col = 1 ORDER BY term")).rows.map((row) => row.term))
      .toEqual(["100", "cotton", "জামা", "প্রোডাক্ট", "৫০০"]);
  });

  it("stores the terms SQLite stores", async () => {
    const client = await database((await compileCanonicalPostgresSchema()).sql);
    const sqlite = createMigratedSqlite({ provider: "turso" });
    for (const row of ROWS) {
      await client.query(row);
      sqlite.exec(row);
    }
    await client.query("UPDATE products SET name = 'Blue Shirt' WHERE id = 'p2'");
    sqlite.exec("UPDATE products SET name = 'Blue Shirt' WHERE id = 'p2'");
    await client.query("DELETE FROM pages WHERE id = 'pg1'");
    sqlite.exec("DELETE FROM pages WHERE id = 'pg1'");
    const normalize = (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, col: Number(row.col), tf: Number(row.tf) }));
    expect(normalize((await client.query(TERMS)).rows)).toEqual(normalize(sqlite.prepare(TERMS).all() as Array<Record<string, unknown>>));
    sqlite.close();
  });
});
