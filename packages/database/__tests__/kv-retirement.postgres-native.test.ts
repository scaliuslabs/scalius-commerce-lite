// PostgreSQL sidecar for 0147_kv_retirement on the upgrade path: it creates
// `system_kv`, gives every consumed scanner claim a session expiry six hours
// after its consumption, and leaves the schema equal to a fresh one. Opt-in:
// point SCALIUS_TEST_POSTGRES_URL at a disposable server.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";

const server = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();
const cleanup: Array<() => Promise<void>> = [];
afterAll(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function database(sql: string) {
  const name = `scalius_kv_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: server }); await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(server!); url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  cleanup.push(async () => { await client.end(); await admin.query(`DROP DATABASE ${name} WITH (FORCE)`); await admin.end(); });
  await client.connect(); await client.query(sql); return client;
}

async function catalog(client: Client) {
  const queries = [
    "SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_schema='public' ORDER BY 1,2",
    "SELECT conrelid::regclass::text AS table_name,conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2,3",
    "SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1,2",
  ];
  const result = []; for (const query of queries) result.push((await client.query(query)).rows); return result;
}

describe.runIf(server)("0147 KV retirement on native PostgreSQL", () => {
  it("backfills scanner session expiry and equals a fresh schema", async () => {
    const upgraded = await database((await compileCanonicalPostgresSchema({ beforeMigration: "0147_" })).sql);
    await upgraded.query(`
      INSERT INTO "user"(id,name,email,email_verified,role) VALUES ('admin_1','Admin','admin@shop.test',1,'admin');
      INSERT INTO scanner_token_claims(token_hash,admin_id,admin_name,consumed_at,consumed_session_hash,expires_at)
        VALUES ('hash_consumed','admin_1','Warehouse',1000,'session_hash',1900),
               ('hash_open','admin_1','Warehouse',NULL,NULL,1900);
    `);
    const migration = readFileSync(join(import.meta.dirname, "../migrations/postgres/0147_kv_retirement.sql"), "utf8");
    await upgraded.query("BEGIN");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await upgraded.query(statement);
    await upgraded.query("COMMIT");

    expect((await upgraded.query("SELECT token_hash, session_expires_at::integer AS expires FROM scanner_token_claims ORDER BY 1")).rows)
      .toEqual([{ token_hash: "hash_consumed", expires: 1000 + 21600 }, { token_hash: "hash_open", expires: null }]);
    await upgraded.query("INSERT INTO system_kv(key,value,expires_at) VALUES ('oauth:grant:u:g','{}',NULL)");
    await expect(upgraded.query("INSERT INTO system_kv(key,value) VALUES ('','x')")).rejects.toThrow(/system_kv_key_length/);

    // The fresh schema as of the migration under test: later migrations change it again.
    const fresh = await database((await compileCanonicalPostgresSchema({ beforeMigration: "0148_" })).sql);
    expect(await catalog(upgraded)).toEqual(await catalog(fresh));
  }, 180_000);
});
