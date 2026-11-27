/**
 * Test-only: a store as a released version left it, frozen as a data dump,
 * and the upgrade a later release applies to it.
 *
 * The dump holds data only: every table whose rows differ from the release's
 * own migrated schema (the chain up to and including its last migration, which
 * is immutable), with Wrangler's `d1_migrations` ledger as a D1 store has it.
 * Loading restores that schema from the chain, suspends the triggers (their
 * derived rows are in the dump already), inserts the rows and puts the
 * triggers back in their original order. The text is deterministic for a
 * deterministic build, diffable and small; a SQLite image would be megabytes
 * of schema and change with SQLite's version.
 *
 * `applyD1MigrationTail` then does what `wrangler d1 migrations apply` does:
 * each file not in `d1_migrations`, in order, all or nothing, then its ledger
 * row. Never import this from Worker code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { compileSqliteMigrationForProvider } from "../migration-artifacts";
import { D1_MIGRATIONS_LEDGER_DDL } from "../migration-plan";
import { applyD1Limits, createMigratedSqlite } from "./sqlite-d1";

export const RELEASE_STORE_DUMP_CONTRACT = "scalius-release-store/v1";
const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

export function migrationFiles(directory = migrationDirectory): string[] {
  return readdirSync(directory).filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name)).sort();
}

/** The cut-off that builds a schema through `lastMigration` (`0226_x` -> `0227`). */
function cutOffAfter(lastMigration: string): string {
  return String(Number(lastMigration.slice(0, 4)) + 1).padStart(4, "0");
}

/** The release's schema with no store data: the chain through `lastMigration`, plus Wrangler's ledger listing it. */
export function createReleaseSchema(lastMigration: string): DatabaseSync {
  const files = migrationFiles();
  if (!files.includes(`${lastMigration}.sql`)) throw new Error(`${lastMigration} is not a migration of this chain.`);
  const sqlite = createMigratedSqlite({ beforeMigration: cutOffAfter(lastMigration) });
  sqlite.exec(D1_MIGRATIONS_LEDGER_DDL);
  const insert = sqlite.prepare("INSERT INTO d1_migrations (name, applied_at) VALUES (?, '2026-01-01 00:00:00')");
  for (const file of files.filter((name) => name <= `${lastMigration}.sql`)) insert.run(file);
  return sqlite;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll("\"", "\"\"")}"`;
}

function literal(value: SQLOutputValue): string {
  if (value === null) return "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Cannot dump the number ${value}.`);
    // Integers arrive as bigint (readBigInts); a number is a REAL: keep it one.
    const text = String(value);
    return /[.eE]/.test(text) ? text : `${text}.0`;
  }
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  return `X'${Buffer.from(value).toString("hex")}'`;
}

/** Ordinary tables (a virtual table's rows live in its shadow tables, dumped as tables). */
function dumpedTables(sqlite: DatabaseSync): string[] {
  return (sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'
    AND (name = 'sqlite_sequence' OR name NOT LIKE 'sqlite\\_%' ESCAPE '\\')
    AND coalesce(sql, '') NOT LIKE 'CREATE VIRTUAL TABLE%' ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
}

/** A table's stable row order: rowid, or a WITHOUT ROWID table's primary key. */
function rowOrder(sqlite: DatabaseSync, table: string): string {
  const { sql } = sqlite.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string | null };
  if (!/WITHOUT\s+ROWID\s*$/i.test(sql ?? "")) return "rowid";
  const key = (sqlite.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string; pk: number }>)
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk);
  return key.map((column) => quoteIdentifier(column.name)).join(", ");
}

function rowsOf(sqlite: DatabaseSync, table: string): { columns: string[]; rows: SQLOutputValue[][] } {
  const statement = sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)} ORDER BY ${rowOrder(sqlite, table)}`);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);
  const rows = statement.all() as unknown as SQLOutputValue[][];
  return { columns: statement.columns().map((column) => column.name), rows };
}

function sameRows(left: SQLOutputValue[][], right: SQLOutputValue[][]): boolean {
  if (left.length !== right.length) return false;
  return left.every((row, index) => row.every((value, column) => literal(value) === literal(right[index]![column]!)));
}

export interface ReleaseStoreHeader {
  release: string;
  lastMigration: string;
  builtBy: string;
}

/**
 * The store's data as SQL: each table whose rows differ from the release's
 * empty schema, cleared and refilled, in name order and rowid order.
 */
export function dumpReleaseStore(store: DatabaseSync, header: ReleaseStoreHeader): string {
  const pristine = createReleaseSchema(header.lastMigration);
  try {
    const lines = [
      `-- ${RELEASE_STORE_DUMP_CONTRACT}`,
      `-- release: ${header.release}`,
      `-- schema: ${header.lastMigration}`,
      `-- built by: ${header.builtBy}`,
      "-- Data only: load with loadReleaseStore (packages/database/src/testing/release-image.ts). Do not edit by hand.",
    ];
    const pristineTables = new Set(dumpedTables(pristine));
    for (const table of dumpedTables(store)) {
      if (!pristineTables.has(table)) throw new Error(`${table} is not in the ${header.lastMigration} schema: the store was built on another schema.`);
      const current = rowsOf(store, table);
      if (sameRows(current.rows, rowsOf(pristine, table).rows)) continue;
      lines.push("", `DELETE FROM ${quoteIdentifier(table)};`);
      const columns = current.columns.map(quoteIdentifier).join(", ");
      for (const row of current.rows) {
        lines.push(`INSERT INTO ${quoteIdentifier(table)} (${columns}) VALUES (${row.map(literal).join(", ")});`);
      }
    }
    return `${lines.join("\n")}\n`;
  } finally {
    pristine.close();
  }
}

export function parseReleaseStoreHeader(dump: string): ReleaseStoreHeader {
  const field = (name: string) => new RegExp(`^-- ${name}: (.+)$`, "m").exec(dump)?.[1]?.trim();
  if (!dump.startsWith(`-- ${RELEASE_STORE_DUMP_CONTRACT}\n`)) throw new Error("Not a release store dump.");
  const release = field("release");
  const lastMigration = field("schema");
  const builtBy = field("built by");
  if (!release || !lastMigration || !builtBy) throw new Error("The release store dump has no release, schema or builder line.");
  return { release, lastMigration, builtBy };
}

/** The dumped store on its release's schema, as a D1 store at that release holds it. */
export function loadReleaseStore(dump: string): { sqlite: DatabaseSync; header: ReleaseStoreHeader } {
  const header = parseReleaseStoreHeader(dump);
  const sqlite = createReleaseSchema(header.lastMigration);
  // A row's values are inline literals here, where the store bound them: lift
  // the statement-length limit while loading (applyD1Limits puts it back).
  (sqlite as unknown as { limits: Record<string, number> }).limits.sqlLength = 1_000_000_000;
  const triggers = sqlite.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY rowid").all() as Array<{ name: string; sql: string }>;
  // FTS5 shadow tables hold the search index rows: writable only outside defensive mode.
  const defensive = sqlite as DatabaseSync & { enableDefensive(active: boolean): void };
  defensive.enableDefensive(false);
  sqlite.exec("PRAGMA foreign_keys = OFF");
  sqlite.exec("BEGIN");
  try {
    for (const { name } of triggers) sqlite.exec(`DROP TRIGGER ${quoteIdentifier(name)}`);
    sqlite.exec(dump);
    for (const { sql } of triggers) sqlite.exec(sql);
    sqlite.exec("COMMIT");
  } catch (error) {
    sqlite.exec("ROLLBACK");
    sqlite.close();
    throw error;
  }
  defensive.enableDefensive(true);
  sqlite.exec("PRAGMA foreign_keys = ON");
  const broken = sqlite.prepare("PRAGMA foreign_key_check").all();
  if (broken.length > 0) {
    sqlite.close();
    throw new Error(`The release store breaks ${broken.length} foreign key(s): ${JSON.stringify(broken.slice(0, 3))}`);
  }
  applyD1Limits(sqlite);
  return { sqlite, header };
}

/**
 * What `wrangler d1 migrations apply` does to the store: every migration file
 * not in `d1_migrations`, in order, each with its ledger row in one
 * transaction. The applied names must be an exact prefix of the chain.
 * Returns the files applied.
 */
export function applyD1MigrationTail(sqlite: DatabaseSync, { directory = migrationDirectory }: { directory?: string } = {}): string[] {
  const files = migrationFiles(directory);
  const applied = (sqlite.prepare("SELECT name FROM d1_migrations ORDER BY id").all() as Array<{ name: string }>).map((row) => row.name);
  applied.forEach((name, index) => {
    if (files[index] !== name) throw new Error(`d1_migrations diverges from the chain at row ${index + 1}: ${name}`);
  });
  const pending = files.slice(applied.length);
  for (const file of pending) {
    const sql = compileSqliteMigrationForProvider(readFileSync(join(directory, file), "utf8"), "d1");
    sqlite.exec("BEGIN");
    try {
      sqlite.exec(sql);
      sqlite.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(file);
      sqlite.exec("COMMIT");
    } catch (error) {
      sqlite.exec("ROLLBACK");
      throw new Error(`${file} failed on the release store: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return pending;
}
