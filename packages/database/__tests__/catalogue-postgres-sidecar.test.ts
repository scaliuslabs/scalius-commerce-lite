// PostgreSQL sidecar parity for 0088_catalogue_schema: an 0087 schema upgraded
// by the sidecar must equal the fresh schema compiled from the canonical
// SQLite chain (columns, constraints, indexes, triggers and trigger
// functions), backfill like SQLite, and enforce the same tree guards.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

// Opt-in: point SCALIUS_TEST_POSTGRES_URL at a disposable server. Each test
// creates and drops its own databases there.
const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const sidecar = join(import.meta.dirname, "../migrations/postgres/0088_catalogue_schema.sql");

const openClients: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const close of openClients.splice(0)) await close();
});

async function database(schemaSql: string): Promise<Client> {
  const name = `scalius_catalogue_${randomUUID().replaceAll("-", "")}`;
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
    throw new Error(`0088_catalogue_schema: ${(error as Error).message}`);
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

describe.runIf(postgresUrl)("0088 catalogue schema PostgreSQL sidecar", () => {
  it("upgrades an 0087 schema to exactly the fresh 0088 schema", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema(),
      compileCanonicalPostgresSchema({ beforeMigration: "0088_" }),
    ]);
    const freshDatabase = await database(fresh.sql);
    const upgraded = await database(before.sql);
    await applySidecar(upgraded);

    const [expected, actual] = await Promise.all([catalog(freshDatabase), catalog(upgraded)]);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.triggers).toEqual(expected.triggers);
    expect(actual.functions).toEqual(expected.functions);
    expect(actual.triggers.map((row) => row.tgname)).toEqual(expect.arrayContaining([
      "categories_tree_move_reshape",
      "product_attribute_values_type_insert_guard",
      "product_rich_content_mirror_insert",
      "product_bundles_checkout_authority_update",
    ]));
  }, 120_000);

  it("backfills and maintains the tree, the typed values and the content mirror", async () => {
    const before = await compileCanonicalPostgresSchema({ beforeMigration: "0088_" });
    const client = await database(before.sql);
    await client.query(`
      INSERT INTO categories (id, name, slug) VALUES ('cat_a', 'A', 'a'), ('cat_b', 'B', 'b');
      INSERT INTO products (id, name, slug) VALUES ('prod_1', 'Tee', 'tee');
      INSERT INTO product_rich_content (id, product_id, title, content, sort_order)
        VALUES ('prc_1', 'prod_1', 'Care', '<p>Cold</p>', 2);
    `);
    await applySidecar(client);
    expect((await client.query("SELECT id, depth, path FROM categories ORDER BY id")).rows).toEqual([
      { id: "cat_a", depth: 0, path: "/cat_a/" },
      { id: "cat_b", depth: 0, path: "/cat_b/" },
    ]);
    expect((await client.query(
      "SELECT id, position, type, settings::jsonb ->> 'title' AS title FROM product_content_blocks",
    )).rows).toEqual([{ id: "pcb_prc_1", position: 2, type: "rich-text", title: "Care" }]);

    await client.query("BEGIN");
    await client.query(`
      INSERT INTO categories (id, name, slug, parent_id) VALUES ('cat_c', 'C', 'c', 'cat_b');
      INSERT INTO categories (id, name, slug, parent_id) VALUES ('cat_d', 'D', 'd', 'cat_c');
      UPDATE categories SET parent_id = 'cat_a' WHERE id = 'cat_b';
    `);
    expect((await client.query("SELECT id, depth, path FROM categories ORDER BY id")).rows).toEqual([
      { id: "cat_a", depth: 0, path: "/cat_a/" },
      { id: "cat_b", depth: 1, path: "/cat_a/cat_b/" },
      { id: "cat_c", depth: 2, path: "/cat_a/cat_b/cat_c/" },
      { id: "cat_d", depth: 3, path: "/cat_a/cat_b/cat_c/cat_d/" },
    ]);
    expect((await client.query(
      "SELECT ancestor_id || '>' || descendant_id || ':' || depth AS link FROM category_closure ORDER BY 1",
    )).rows.map((row) => row.link)).toEqual([
      "cat_a>cat_a:0", "cat_a>cat_b:1", "cat_a>cat_c:2", "cat_a>cat_d:3",
      "cat_b>cat_b:0", "cat_b>cat_c:1", "cat_b>cat_d:2",
      "cat_c>cat_c:0", "cat_c>cat_d:1",
      "cat_d>cat_d:0",
    ]);
    await rejects(client, "UPDATE categories SET parent_id = 'cat_d' WHERE id = 'cat_a'", /under itself or its descendants/);
    await rejects(client, "INSERT INTO categories (id, name, slug, parent_id) VALUES ('cat_e', 'E', 'e', 'cat_d')", /four levels/);
    await rejects(client, "UPDATE categories SET path = '/x/' WHERE id = 'cat_b'", /maintained by the tree triggers/);

    await client.query(`
      INSERT INTO product_attributes (id, name, slug, value_type) VALUES ('attr_enum', 'Brand', 'brand', 'enum');
      INSERT INTO attribute_values (id, attribute_id, value, normalized_value) VALUES ('atv_asus0001', 'attr_enum', 'ASUS', 'asus');
      INSERT INTO product_attribute_values (id, product_id, attribute_id, value, value_id)
        VALUES ('v_1', 'prod_1', 'attr_enum', 'ASUS', 'atv_asus0001');
    `);
    await rejects(client, `INSERT INTO product_attribute_values (id, product_id, attribute_id, value)
      VALUES ('v_2', 'prod_1', 'attr_enum', 'Dell')`, /does not match the attribute type/);
    await client.query("UPDATE product_rich_content SET title = 'Care guide', sort_order = 5 WHERE id = 'prc_1'");
    expect((await client.query(
      "SELECT position, settings::jsonb ->> 'title' AS title FROM product_content_blocks WHERE id = 'pcb_prc_1'",
    )).rows).toEqual([{ position: 5, title: "Care guide" }]);
    await client.query("ROLLBACK");
  }, 120_000);
});
