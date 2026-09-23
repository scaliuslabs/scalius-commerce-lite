/**
 * Test-only harness: the real migrations applied to an in-memory node:sqlite
 * database, exposed through a D1-compatible binding (prepare/bind/all/first/
 * raw/run/batch with atomic batch semantics) or a stateful Turso connection.
 * Never import this from Worker code.
 */
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";

import { compileSqliteMigrationForProvider } from "../migration-artifacts";
import * as schema from "../schema";
import { createTursoDatabase } from "../turso-adapter";
import type { Database } from "../types";

type SqliteProvider = "d1" | "turso";
type Row = Record<string, SQLOutputValue>;

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
const compiledMigrations = new Map<string, string>();
const migratedImages = new Map<string, Uint8Array>();

/** node:sqlite serialize/deserialize (Node 24.x); older typings omit them. */
type SerializableSqlite = DatabaseSync & {
  serialize?: () => Uint8Array;
  deserialize?: (image: Uint8Array) => void;
};

/**
 * Numbered migrations compiled for the provider as one script (cached per
 * process). `beforeMigration` stops before that file, for upgrade tests.
 */
export function compiledMigrationSql(provider: SqliteProvider = "d1", beforeMigration?: string): string {
  const cacheKey = `${provider}:${beforeMigration ?? ""}`;
  const cached = compiledMigrations.get(cacheKey);
  if (cached !== undefined) return cached;
  const sql = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => beforeMigration === undefined || name < beforeMigration)
    .sort()
    .map((name) => compileSqliteMigrationForProvider(
      readFileSync(`${migrationDirectory}/${name}`, "utf8"),
      provider,
    ))
    .join("\n");
  compiledMigrations.set(cacheKey, sql);
  return sql;
}

export interface MigratedSqliteOptions {
  provider?: SqliteProvider;
  /** Foreign-key enforcement. Defaults to ON, matching D1 (and node:sqlite's own default). */
  foreignKeys?: boolean;
  /** Apply only migrations whose file name sorts before this one (e.g. "0065_"). */
  beforeMigration?: string;
}

/**
 * An in-memory SQLite database with the real schema applied. Migrations run
 * once per provider (and cut-off) per process (~300 ms); later databases restore that image.
 */
export function createMigratedSqlite(options: MigratedSqliteOptions = {}): DatabaseSync {
  const provider = options.provider ?? "d1";
  const imageKey = `${provider}:${options.beforeMigration ?? ""}`;
  const sqlite: SerializableSqlite = new DatabaseSync(":memory:");
  const image = migratedImages.get(imageKey);
  if (image && sqlite.deserialize) {
    sqlite.deserialize(image);
  } else {
    sqlite.exec(compiledMigrationSql(provider, options.beforeMigration));
    if (sqlite.serialize) migratedImages.set(imageKey, sqlite.serialize());
  }
  // Table-rebuild migrations toggle the pragma themselves; set it last.
  sqlite.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`);
  return sqlite;
}

type BindValue = SQLInputValue | boolean;

/** D1 and Turso bind JS booleans as 1/0; node:sqlite rejects them. */
function sqliteValues(values: readonly BindValue[]): SQLInputValue[] {
  return values.map((value) => typeof value === "boolean" ? Number(value) : value);
}

export interface SqliteD1Result {
  results: Row[];
  success: true;
  meta: { changes: number; last_row_id: number };
}

export interface SqliteD1Statement {
  readonly query: string;
  readonly values: readonly SQLInputValue[];
  bind(...values: BindValue[]): SqliteD1Statement;
  all(): Promise<SqliteD1Result>;
  run(): Promise<SqliteD1Result>;
  raw(): Promise<SQLOutputValue[][]>;
  first(column?: string): Promise<unknown>;
  /** Synchronous execution used inside an atomic batch. */
  execute(): SqliteD1Result;
}

export interface SqliteD1Hooks {
  /** Runs for every executed statement (outside and inside batches). */
  onQuery?: (query: string, values: readonly SQLInputValue[]) => void;
  /**
   * Runs before a batch opens its transaction. Race tests use it to commit a
   * competing write between the caller's reads and its guarded batch.
   */
  beforeBatch?: (sqlite: DatabaseSync, statements: readonly SqliteD1Statement[]) => void | Promise<void>;
}

function execute(
  sqlite: DatabaseSync,
  query: string,
  values: readonly SQLInputValue[],
  hooks: SqliteD1Hooks,
): SqliteD1Result {
  hooks.onQuery?.(query, values);
  const statement = sqlite.prepare(query);
  if (statement.columns().length === 0) {
    const result = statement.run(...values);
    return {
      results: [],
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
  const results = statement.all(...values) as Row[];
  return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
}

function statement(
  sqlite: DatabaseSync,
  query: string,
  values: readonly SQLInputValue[],
  hooks: SqliteD1Hooks,
): SqliteD1Statement {
  return {
    query,
    values,
    bind: (...next) => statement(sqlite, query, sqliteValues(next), hooks),
    all: async () => execute(sqlite, query, values, hooks),
    run: async () => execute(sqlite, query, values, hooks),
    raw: async () => {
      hooks.onQuery?.(query, values);
      const prepared = sqlite.prepare(query);
      prepared.setReturnArrays(true);
      return prepared.all(...values) as unknown as SQLOutputValue[][];
    },
    first: async (column) => {
      const row = execute(sqlite, query, values, hooks).results[0];
      return column ? row?.[column] ?? null : row ?? null;
    },
    execute: () => execute(sqlite, query, values, hooks),
  };
}

/** Run `work` inside BEGIN IMMEDIATE; roll back on any error. */
export function sqliteTransaction<T>(sqlite: DatabaseSync, work: () => T): T {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
    throw error;
  }
}

/** A D1Database binding over node:sqlite. `batch` is all-or-nothing like D1. */
export function createSqliteD1Binding(sqlite: DatabaseSync, hooks: SqliteD1Hooks = {}): D1Database {
  const binding = {
    prepare: (query: string) => statement(sqlite, query, [], hooks),
    async batch(statements: SqliteD1Statement[]) {
      await hooks.beforeBatch?.(sqlite, statements);
      return sqliteTransaction(sqlite, () => statements.map((entry) => entry.execute()));
    },
    async exec(query: string) {
      sqlite.exec(query);
      return { count: 1, duration: 0 };
    },
  };
  return binding as unknown as D1Database;
}

export interface SqliteTursoHooks {
  onBatch?: (mode: string | undefined, statementCount: number) => void;
  writeBatchMode?: "immediate" | "concurrent";
}

/**
 * A Turso Database over node:sqlite using the real Turso adapter. The fake
 * connection preserves raw rows, read/write transaction modes, and rollback;
 * it deliberately does not emulate MVCC scheduling.
 */
export function createSqliteTursoDatabase(sqlite: DatabaseSync, hooks: SqliteTursoHooks = {}): Database {
  return createTursoDatabase(
    { url: "turso://sqlite-test.turso.io", authToken: "test" },
    {
      connect: () => ({
        async batch(statements, options) {
          hooks.onBatch?.(options?.mode, statements.length);
          const run = () => statements.map((entry) => {
            const sql = typeof entry === "string" ? entry : entry.sql;
            const args = typeof entry === "string" || entry.args === undefined ? [] : entry.args;
            if (!Array.isArray(args)) throw new Error("The SQLite Turso harness accepts positional arguments only.");
            const values = sqliteValues(args as BindValue[]);
            const prepared = sqlite.prepare(sql);
            if (prepared.columns().length === 0) {
              const result = prepared.run(...values);
              return { rows: [], rowsAffected: Number(result.changes) };
            }
            prepared.setReturnArrays(true);
            return { rows: prepared.all(...values) as unknown[], rowsAffected: 0 };
          });
          if (options?.mode === undefined) return run();
          sqlite.exec(options.mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
          try {
            const results = run();
            sqlite.exec("COMMIT");
            return results;
          } catch (error) {
            if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      writeBatchMode: hooks.writeBatchMode ?? "concurrent",
    },
  );
}

export interface SqliteTestDatabase {
  sqlite: DatabaseSync;
  binding: D1Database;
  db: Database;
}

/** Migrated in-memory SQLite + D1 binding + Drizzle client with the full schema. */
export function createSqliteD1Database(
  options: MigratedSqliteOptions & SqliteD1Hooks & { sqlite?: DatabaseSync } = {},
): SqliteTestDatabase {
  const sqlite = options.sqlite ?? createMigratedSqlite(options);
  const binding = createSqliteD1Binding(sqlite, options);
  return { sqlite, binding, db: drizzle(binding, { schema }) as unknown as Database };
}
