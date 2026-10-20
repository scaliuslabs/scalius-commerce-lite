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
import { createHash, type Hash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";

import { compileSqliteMigrationForProvider } from "../migration-artifacts";
import { observeD1Prepare } from "../read-observer";
import * as schema from "../schema";
import { createTursoDatabase } from "../turso-adapter";
import type { Database } from "../types";

type SqliteProvider = "d1" | "turso";
type Row = Record<string, SQLOutputValue>;

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");
/**
 * Migrated images shared by test processes, keyed by the digest of the script
 * that built them. The key is content-addressed, so one machine-wide directory
 * serves every checkout and agent worktree: a new worktree starts warm.
 * `SCALIUS_TEST_IMAGE_CACHE` overrides it; the checkout's node_modules/.cache
 * is the fallback when the user cache cannot be written.
 */
const localImageCacheDirectory = join(dirname(fileURLToPath(import.meta.url)), "../../node_modules/.cache/scalius-migrated-sqlite");
let imageCacheDirectoryPath: string | undefined;

export function migratedImageCacheDirectory(): string {
  if (imageCacheDirectoryPath) return imageCacheDirectoryPath;
  const userCacheRoot = process.platform === "darwin"
    ? join(homedir(), "Library", "Caches")
    : process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const userCache = process.env.SCALIUS_TEST_IMAGE_CACHE || join(userCacheRoot, "scalius-migrated-sqlite");
  try {
    mkdirSync(userCache, { recursive: true });
    imageCacheDirectoryPath = userCache;
  } catch {
    imageCacheDirectoryPath = localImageCacheDirectory;
  }
  return imageCacheDirectoryPath;
}
const compiledMigrations = new Map<string, string>();
const migratedImages = new Map<string, Uint8Array>();

/** node:sqlite serialize/deserialize (Node 24.x); older typings omit them. */
type SerializableSqlite = DatabaseSync & {
  serialize?: () => Uint8Array;
  deserialize?: (image: Uint8Array) => void;
};

/**
 * Numbered migrations compiled for the provider as one script (cached per
 * process). `beforeMigration` stops before that file and `fromMigration`
 * starts at one, so upgrade tests can seed old rows between the two.
 */
export function compiledMigrationSql(
  provider: SqliteProvider = "d1",
  beforeMigration?: string,
  fromMigration?: string,
): string {
  const cacheKey = `${provider}:${beforeMigration ?? ""}:${fromMigration ?? ""}`;
  const cached = compiledMigrations.get(cacheKey);
  if (cached !== undefined) return cached;
  const sql = readdirSync(migrationDirectory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .filter((name) => beforeMigration === undefined || name < beforeMigration)
    .filter((name) => fromMigration === undefined || name >= fromMigration)
    .sort()
    .map((name) => compileSqliteMigrationForProvider(
      readFileSync(`${migrationDirectory}/${name}`, "utf8"),
      provider,
    ))
    .join("\n");
  compiledMigrations.set(cacheKey, sql);
  return sql;
}

/**
 * Applying every migration takes seconds (each DDL statement re-reads a
 * schema of thousands of triggers), so test files would each pay it in their
 * first test. The image is the same for the same script: a process reuses the
 * image another one built. A changed migration changes the digest.
 */
function imageFile(provider: SqliteProvider, beforeMigration: string | undefined): string {
  const digest = createHash("sha256")
    .update(`${process.version}\n${compiledMigrationSql(provider, beforeMigration)}`)
    .digest("hex");
  return imageFileForDigest(digest);
}

function imageFileForDigest(digest: string): string {
  return join(migratedImageCacheDirectory(), `${digest}.sqlite`);
}

function readImageFile(provider: SqliteProvider, beforeMigration: string | undefined): Uint8Array | undefined {
  try {
    return new Uint8Array(readFileSync(imageFile(provider, beforeMigration)));
  } catch {
    return undefined;
  }
}

function writeImageFile(provider: SqliteProvider, beforeMigration: string | undefined, image: Uint8Array): void {
  writeImageFileAt(imageFile(provider, beforeMigration), image);
}

function writeImageFileAt(file: string, image: Uint8Array): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write then rename: a process reading at the same time sees the whole image or none.
    const partial = `${file}.${process.pid}.${Date.now()}.partial`;
    writeFileSync(partial, image);
    renameSync(partial, file);
  } catch {
    // A read-only checkout still works: each process builds its own image.
  }
}

function fileExists(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export interface MigratedImageTarget {
  provider?: SqliteProvider;
  beforeMigration?: string;
}

/**
 * Builds every image the tests will ask for in one pass per provider: the
 * migrations are applied in order once and the database is snapshotted at
 * each `beforeMigration` cut-off on the way, instead of each cut-off
 * replaying its own prefix in whichever test process asks first (several at
 * once, inside a test's time limit). Images already cached are touched, so
 * the prune keeps them, and skipped. A digest here equals `imageFile()`'s:
 * the same compiled files, joined the same way.
 */
export function prebuildMigratedImages(targets: readonly MigratedImageTarget[]): { built: number; cached: number } {
  let built = 0;
  let cached = 0;
  const files = readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
  for (const provider of new Set(targets.map((target) => target.provider ?? "d1"))) {
    // "￿" sorts after every file name: no cut-off is the whole chain.
    const cutOffs = [...new Set(targets
      .filter((target) => (target.provider ?? "d1") === provider)
      .map((target) => target.beforeMigration ?? "￿"))].sort();
    const compiled = files.map((name) => compileSqliteMigrationForProvider(readFileSync(join(migrationDirectory, name), "utf8"), provider));
    // One running hash over the joined script; a copy at each cut-off is that prefix's digest.
    const hash: Hash = createHash("sha256").update(`${process.version}\n`);
    const plan: Array<{ applied: number; file: string }> = [];
    let next = 0;
    for (let index = 0; index <= files.length; index += 1) {
      while (next < cutOffs.length && (index === files.length || files[index] >= cutOffs[next])) {
        const file = imageFileForDigest(hash.copy().digest("hex"));
        if (!plan.some((step) => step.file === file)) plan.push({ applied: index, file });
        next += 1;
      }
      if (index < files.length) hash.update(index === 0 ? compiled[index] : `\n${compiled[index]}`);
    }
    const missing = plan.filter((step) => {
      if (!fileExists(step.file)) return true;
      const now = new Date();
      try {
        utimesSync(step.file, now, now);
      } catch {
        // Touching only protects the image from the prune.
      }
      cached += 1;
      return false;
    });
    if (missing.length === 0) continue;
    const sqlite: SerializableSqlite = new DatabaseSync(":memory:");
    try {
      if (!sqlite.serialize) continue;
      let applied = 0;
      for (const step of missing) {
        for (; applied < step.applied; applied += 1) sqlite.exec(compiled[applied]);
        writeImageFileAt(step.file, sqlite.serialize());
        built += 1;
      }
    } finally {
      sqlite.close();
    }
  }
  return { built, cached };
}

/**
 * Removes images and Turso engine store templates (turso-engine.ts) unused
 * for `maxAgeDays`, and abandoned partial writes, from the shared cache.
 */
export function pruneMigratedImageCache(maxAgeDays = 14): number {
  const directory = migratedImageCacheDirectory();
  const now = Date.now();
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(directory);
  } catch {
    return 0;
  }
  for (const name of names) {
    const file = join(directory, name);
    try {
      const age = now - statSync(file).mtimeMs;
      const abandoned = name.endsWith(".partial") || name.includes(".building-");
      const unused = name.endsWith(".sqlite") || /^turso-engine-[0-9a-f]+$/.test(name);
      if (abandoned ? age > 3_600_000 : unused && age > maxAgeDays * 86_400_000) {
        rmSync(file, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Another process removed or renamed it.
    }
  }
  return removed;
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
 * once per provider (and cut-off) for every test process (the image is shared
 * through a file); later databases restore that image.
 */
export function createMigratedSqlite(options: MigratedSqliteOptions = {}): DatabaseSync {
  const provider = options.provider ?? "d1";
  const imageKey = `${provider}:${options.beforeMigration ?? ""}`;
  const sqlite: SerializableSqlite = new DatabaseSync(":memory:");
  const image = migratedImages.get(imageKey) ?? (sqlite.deserialize ? readImageFile(provider, options.beforeMigration) : undefined);
  if (image && sqlite.deserialize) {
    sqlite.deserialize(image);
    migratedImages.set(imageKey, image);
  } else {
    sqlite.exec(compiledMigrationSql(provider, options.beforeMigration));
    if (sqlite.serialize) {
      const built = sqlite.serialize();
      migratedImages.set(imageKey, built);
      writeImageFile(provider, options.beforeMigration, built);
    }
  }
  // Table-rebuild migrations toggle the pragma themselves; set it last.
  sqlite.exec(`PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`);
  applyD1Limits(sqlite);
  return sqlite;
}

/**
 * The SQLite limits Cloudflare D1 enforces (https://developers.cloudflare.com/d1/platform/limits/),
 * each confirmed against D1 and workerd. Local SQLite allows far more, so a
 * statement over one of them passes here and fails only on D1. `column` also
 * bounds an index, a GROUP BY/ORDER BY list and an UPDATE's SET terms. (The
 * documented 32 function arguments is not enforced: D1 runs a 40-argument call.)
 */
export const D1_SQLITE_LIMITS = {
  /** Columns per table and per result set ("too many columns in result set"). */
  column: 100,
  /** LIKE/GLOB pattern bytes, bound values included ("LIKE or GLOB pattern too complex"). */
  likePatternLength: 50,
  /** SQL statement text bytes ("statement too long"). */
  sqlLength: 100_000,
  /** Terms of a compound SELECT ("too many terms in compound SELECT"). */
  compoundSelect: 5,
} as const;

/**
 * Make a node:sqlite database refuse what D1 refuses. Set after the
 * migrations, which D1 applies through its own statement path.
 */
export function applyD1Limits(sqlite: DatabaseSync): void {
  Object.assign((sqlite as unknown as { limits: Record<string, number> }).limits, D1_SQLITE_LIMITS);
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

/** Cloudflare D1 rejects a statement with more than 100 bound parameters. */
export const D1_MAX_BOUND_PARAMETERS = 100;

function assertD1ParameterLimit(values: readonly SQLInputValue[]): void {
  if (values.length > D1_MAX_BOUND_PARAMETERS) {
    throw new Error(`D1_ERROR: too many SQL variables (${values.length} bound; D1 allows ${D1_MAX_BOUND_PARAMETERS})`);
  }
}

function execute(
  sqlite: DatabaseSync,
  query: string,
  values: readonly SQLInputValue[],
  hooks: SqliteD1Hooks,
): SqliteD1Result {
  assertD1ParameterLimit(values);
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
      assertD1ParameterLimit(values);
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

type Statement = ReturnType<D1Database["prepare"]>;

/**
 * Models Hyperdrive's default query cache (tests of the read-freshness probe): a read is answered from the first
 * result for the same SQL text and parameters; writes go to the database.
 */
export function withSimulatedQueryCache(binding: D1Database): D1Database {
  const cache = new Map<string, unknown>();
  const cached = (statement: Statement, query: string, values: unknown[]): Statement => {
    if (!/^\s*select\b/i.test(query)) return statement;
    const key = `${query}\u0000${JSON.stringify(values)}`;
    const remember = <T>(method: "all" | "raw" | "first", run: () => Promise<T>) => async () => {
      const entry = `${method}\u0000${key}`;
      if (!cache.has(entry)) cache.set(entry, await run());
      return cache.get(entry) as T;
    };
    return {
      ...statement,
      bind: (...next: unknown[]) => cached(statement.bind(...next), query, next),
      all: remember("all", () => statement.all()),
      raw: remember("raw", () => statement.raw()),
      first: remember("first", () => statement.first()),
    } as Statement;
  };
  return {
    ...binding,
    prepare: (query: string) => cached(binding.prepare(query), query, []),
    batch: binding.batch.bind(binding),
  } as D1Database;
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
            return { columns: prepared.columns().map((column) => column.name), rows: prepared.all(...values) as unknown[], rowsAffected: 0 };
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
  // Observed like the production D1 request client, so read capture works in tests.
  return { sqlite, binding, db: drizzle(observeD1Prepare(binding), { schema }) as unknown as Database };
}
