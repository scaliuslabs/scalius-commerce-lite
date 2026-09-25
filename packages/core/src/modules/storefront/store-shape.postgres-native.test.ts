// PostgreSQL parity for the store shape: the one bounded statement reads the
// same facts from the canonical PostgreSQL schema as from D1. Opt-in: point
// SCALIUS_TEST_POSTGRES_URL at a disposable server; the test creates and
// drops its own database.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { connectPostgres, createPostgresDatabase } from "@scalius/database/postgres-adapter";
import { rebuildCatalogProjections } from "../products/catalog-projections";
import { readStoreShape } from "./store-shape";
import { STORE_SHAPE_EXPECTED, STORE_SHAPE_PRODUCTS, STORE_SHAPE_TREE } from "./store-shape.fixture";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

function canonicalPostgresSchemaSql(): string {
  const databaseDir = fileURLToPath(new URL("../../../../database/", import.meta.url));
  const out = join(mkdtempSync(join(tmpdir(), "scalius-pg-schema-")), "schema.sql");
  const tsx = fileURLToPath(new URL("../../../../../apps/api/node_modules/.bin/tsx", import.meta.url));
  execFileSync(tsx, ["scripts/postgres-schema.ts", "--out", out], { cwd: databaseDir });
  return readFileSync(out, "utf8");
}

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe.skipIf(!postgresUrl)("store shape on PostgreSQL", () => {
  it("reads the same facts as D1", async () => {
    const name = `scalius_store_shape_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: postgresUrl });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(postgresUrl!);
    url.pathname = `/${name}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    cleanups.push(async () => {
      await client.end();
      await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);
      await admin.end();
    });
    await client.query(canonicalPostgresSchemaSql());
    const db = createPostgresDatabase(url.toString(), { connect: connectPostgres });

    await expect(readStoreShape(db)).resolves.toMatchObject({ topCategoryCount: 0, categoryDepth: 0, categoryGroups: 0, brandCount: 0 });
    for (const statement of [...STORE_SHAPE_TREE, ...STORE_SHAPE_PRODUCTS]) await client.query(statement);
    await rebuildCatalogProjections(db);
    await expect(readStoreShape(db)).resolves.toMatchObject(STORE_SHAPE_EXPECTED);

    await client.query("UPDATE categories SET status = 'published' WHERE id = 'A2'");
    await client.query(`INSERT INTO product_attributes (id, name, slug, key_spec) VALUES ('attr_cpu', 'Processor', 'processor', 1)`);
    await client.query(`INSERT INTO product_attribute_values (id, product_id, attribute_id, value) VALUES ('pav_f', 'p_f', 'attr_cpu', 'M4')`);
    await expect(readStoreShape(db)).resolves.toMatchObject({ categoryDepth: 4, hasKeySpecs: true });
  });
});
