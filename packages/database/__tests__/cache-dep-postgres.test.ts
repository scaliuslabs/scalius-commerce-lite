// PostgreSQL side of migration 0093. Opt-in: point SCALIUS_TEST_POSTGRES_URL
// at a disposable server; each test creates and drops its own databases.
// - The sidecar upgrades an 0092 schema to exactly the fresh schema compiled
//   from the SQLite chain (tables, triggers and trigger functions).
// - The deferred constraint triggers advance the same keys as SQLite.
// - Concurrent writers commit in clock order: a reader that reads the clock
//   first and data after always sees every write whose keys are <= that clock.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client, types } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { CACHE_DEP_MIGRATION_PATHS } from "../scripts/cache-dep-triggers";
import { compileCanonicalPostgresSchema } from "../scripts/postgres-schema";
import { runCacheDepScenario } from "./cache-dep-scenario";

const postgresUrl = process.env.SCALIUS_TEST_POSTGRES_URL?.trim();

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const parseBigint = ((oid: number, format?: "text" | "binary") =>
  oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser;

async function database(schemaSql: string): Promise<{ client: Client; connect(): Promise<Client> }> {
  const name = `scalius_cachedep_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: postgresUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(postgresUrl!);
  url.pathname = `/${name}`;
  const clients: Client[] = [];
  const connect = async () => {
    const client = new Client({ connectionString: url.toString(), types: { getTypeParser: parseBigint } });
    await client.connect();
    clients.push(client);
    return client;
  };
  const client = await connect();
  await client.query(schemaSql);
  cleanups.push(async () => {
    for (const each of clients) await each.end();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });
  return { client, connect };
}

async function applySidecar(client: Client): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of readFileSync(CACHE_DEP_MIGRATION_PATHS.postgres, "utf8").split("--> statement-breakpoint")) {
      if (statement.trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw new Error(`0093_cache_dependencies: ${(error as Error).message}`);
  }
}

async function catalog(client: Client) {
  const query = async (sql: string) => (await client.query(sql)).rows;
  return {
    columns: await query(`
      SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'scalius_schema_migrations' ORDER BY table_name, column_name`),
    constraints: await query(`
      SELECT conrelid::regclass::text AS table_name, conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2, 3`),
    indexes: await query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2"),
    triggers: await query(`
      SELECT tgrelid::regclass::text AS table_name, tgname, pg_get_triggerdef(oid) AS definition
      FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1, 2`),
    functions: await query(`
      SELECT p.proname, pg_get_functiondef(p.oid) AS definition FROM pg_proc p
      WHERE p.pronamespace = 'scalius_compat'::regnamespace ORDER BY p.proname, 2`),
  };
}

describe.runIf(postgresUrl)("0093 cache dependencies on PostgreSQL", () => {
  it("upgrades an 0092 schema to exactly the fresh 0093 schema", async () => {
    const [fresh, before] = await Promise.all([
      compileCanonicalPostgresSchema(),
      compileCanonicalPostgresSchema({ beforeMigration: "0093_" }),
    ]);
    const freshDatabase = await database(fresh.sql);
    const upgraded = await database(before.sql);
    await applySidecar(upgraded.client);
    const [expected, actual] = await Promise.all([catalog(freshDatabase.client), catalog(upgraded.client)]);
    expect(actual.columns).toEqual(expected.columns);
    expect(actual.constraints).toEqual(expected.constraints);
    expect(actual.indexes).toEqual(expected.indexes);
    expect(actual.triggers).toEqual(expected.triggers);
    expect(actual.functions).toEqual(expected.functions);
    expect(actual.triggers.filter((row) => String(row.tgname).startsWith("cdep_")).length).toBeGreaterThan(100);
    expect(actual.triggers.some((row) => String(row.tgname).startsWith("cache_dep_clock"))).toBe(false);
    expect((await upgraded.client.query("SELECT id, seq, floor, coarse FROM cache_clock")).rows)
      .toEqual([{ id: 1, seq: 0, floor: 0, coarse: 0 }]);
  }, 180_000);

  it("advances exactly the registry's keys", async () => {
    const { client } = await database((await compileCanonicalPostgresSchema()).sql);
    await runCacheDepScenario({
      exec: async (sql) => { await client.query(sql); },
      rows: async (sql) => (await client.query(sql)).rows,
    });
  }, 180_000);

  it("commits in clock order under concurrent writers", async () => {
    const { client, connect } = await database((await compileCanonicalPostgresSchema()).sql);
    await client.query("INSERT INTO settings (id, key, value, type, category) VALUES ('set_shared', 'document', 'x', 'text', 'shared')");
    const writers = await Promise.all(Array.from({ length: 6 }, () => connect()));
    const reader = await connect();
    let running = true;
    const samples: Array<{ s0: number; pages: number }> = [];
    const read = (async () => {
      while (running) {
        // READ COMMITTED: the clock first, then data in a later statement.
        const s0 = Number((await reader.query("SELECT COALESCE((SELECT seq FROM cache_clock WHERE id = 1), 0) AS seq")).rows[0].seq);
        const pages = Number((await reader.query("SELECT count(*)::bigint AS n FROM pages")).rows[0].n);
        samples.push({ s0, pages });
      }
    })();
    await Promise.all(writers.map(async (writer, w) => {
      for (let index = 0; index < 20; index += 1) {
        await writer.query("BEGIN");
        await writer.query(`INSERT INTO pages (id, title, slug, content) VALUES ('pg_${w}_${index}', 'P', 'p-${w}-${index}', 'x')`);
        // Both a write before the bump and one after it hold row locks the others need.
        await writer.query(`UPDATE settings SET value = '${w}-${index}' WHERE id = 'set_shared'`).catch(() => undefined);
        await writer.query("COMMIT");
      }
    }));
    running = false;
    await read;
    const keys = (await client.query("SELECT dep, seq FROM cache_dep WHERE dep LIKE 'pg:pg\\_%'")).rows
      .map((row) => Number(row.seq)).sort((a, b) => a - b);
    expect(keys).toHaveLength(120);
    expect(new Set(keys).size).toBe(120);
    expect(samples.length).toBeGreaterThan(10);
    for (const sample of samples) {
      const committedAtOrBefore = keys.filter((seq) => seq <= sample.s0).length;
      expect(sample.pages).toBeGreaterThanOrEqual(committedAtOrBefore);
    }
  }, 180_000);
});
