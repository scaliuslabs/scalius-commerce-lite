/**
 * Test-only harness for the opt-in native PostgreSQL suites
 * (`*.postgres-native.test.ts`). Point `SCALIUS_TEST_POSTGRES_URL` at a
 * disposable server; every call to `createNativePostgres()` creates its own
 * database there and `closeNativePostgres()` (an `afterAll`) drops them, so a
 * suite never assumes a schema or rows that another suite left behind.
 *
 * A database is the canonical PostgreSQL schema (DDL only) plus the rows the
 * migrations seed. The seed is read from a pristine, fully migrated SQLite
 * database and loaded between the table DDL and the indexes and triggers, so a
 * new migration that seeds a row reaches every suite without an edit here, and
 * the load needs no superuser (no trigger or constraint switch-off).
 *
 * Never import this from Worker code.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { Client, types } from "pg";

import { connectPostgres, createPostgresDatabase } from "../postgres-adapter";
import type { Database } from "../types";
import { createMigratedSqlite } from "./sqlite-d1";

/** The disposable server's URL, or undefined (the suites then skip). */
export function nativePostgresUrl(): string | undefined {
  return process.env.SCALIUS_TEST_POSTGRES_URL?.trim() || undefined;
}

export interface NativePostgres {
  /** The application's database, through the production adapter. */
  db: Database;
  /** A raw session on the same database; `bigint` columns read as numbers. */
  client: Client;
  /** This database's own connection URL. */
  url: string;
  name: string;
}

export interface NativePostgresOptions {
  /** A short word in the database name, to tell leftovers apart. */
  label: string;
  /** Load the rows the migrations seed (default). `false`: the bare schema. */
  seed?: boolean;
}

/**
 * The migration runner's own bookkeeping. The canonical schema is created, not
 * migrated, so a copy of its ledger would describe a history this database
 * never had.
 */
const NOT_SEEDED = new Set(["scalius_schema_migrations"]);

const parseBigint = ((oid: number, format?: "text" | "binary") =>
  oid === 20 ? Number : types.getTypeParser(oid, format)) as typeof types.getTypeParser;

/**
 * The schema compiler is a script, outside the package's type graph (its
 * own types target tsx, not the Worker): it is loaded by a computed specifier,
 * so a Worker typecheck never follows it.
 */
const SCHEMA_SCRIPT = "../../scripts/postgres-schema";
interface CanonicalSchema {
  /** The tables: load the seed after this and before `postDataSql`. */
  preDataSql: string;
  /** The indexes and triggers. */
  postDataSql: string;
}
let canonicalSchema: Promise<CanonicalSchema> | null = null;
const open: Array<() => Promise<void>> = [];

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

/** Tables with rows in the migrated SQLite database, parents before the tables that reference them. */
function seededTables(sqlite: DatabaseSync): Array<{ name: string; rows: Array<Record<string, SQLOutputValue>> }> {
  const names = (sqlite.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE 'd1_%' AND name NOT LIKE '_cf_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map((row) => row.name).filter((name) => !NOT_SEEDED.has(name));
  const withRows = new Map<string, Array<Record<string, SQLOutputValue>>>();
  for (const name of names) {
    const rows = sqlite.prepare(`SELECT * FROM ${quote(name)}`).all() as Array<Record<string, SQLOutputValue>>;
    if (rows.length > 0) withRows.set(name, rows);
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    const parents = sqlite.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all() as Array<{ table: string }>;
    for (const { table } of parents) if (withRows.has(table)) visit(table);
    ordered.push(name);
  };
  for (const name of withRows.keys()) visit(name);
  return ordered.map((name) => ({ name, rows: withRows.get(name)! }));
}

async function loadMigrationSeed(client: Client): Promise<void> {
  const present = new Set((await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()",
  )).rows.map((row) => row.table_name as string));
  for (const { name, rows } of seededTables(createMigratedSqlite({ provider: "turso" }))) {
    if (!present.has(name)) continue;
    for (const row of rows) {
      const columns = Object.keys(row);
      await client.query(
        `INSERT INTO ${quote(name)} (${columns.map(quote).join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
        columns.map((column) => {
          const value = row[column];
          return typeof value === "bigint" ? value.toString() : value;
        }),
      );
    }
  }
}

/** A fresh database on the disposable server: the canonical schema and the migration seed. */
export async function createNativePostgres(options: NativePostgresOptions): Promise<NativePostgres> {
  const serverUrl = nativePostgresUrl();
  if (!serverUrl) throw new Error("SCALIUS_TEST_POSTGRES_URL is not set.");
  canonicalSchema ??= (import(/* @vite-ignore */ SCHEMA_SCRIPT) as Promise<{
    compileCanonicalPostgresSchema(): Promise<CanonicalSchema>;
  }>).then((script) => script.compileCanonicalPostgresSchema());
  const schema = await canonicalSchema;

  const name = `scalius_${options.label.replace(/[^a-z0-9]/gi, "_")}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Client({ connectionString: serverUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString(), types: { getTypeParser: parseBigint } });
  open.push(async () => {
    await client.end().catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });
  await client.connect();
  await client.query(schema.preDataSql);
  if (options.seed !== false) await loadMigrationSeed(client);
  await client.query(schema.postDataSql);
  return { db: createPostgresDatabase(url.toString(), { connect: connectPostgres }), client, url: url.toString(), name };
}

/** Drops every database this process created. Call it from `afterAll`. */
export async function closeNativePostgres(): Promise<void> {
  for (const close of open.splice(0).reverse()) await close();
}
