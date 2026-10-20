/**
 * Test-only: a fresh store on the local Turso engine (`@tursodatabase/database`),
 * installed the way the Turso schema runner installs one (the current schema,
 * seed rows and ledger in one transaction, scripts/upgrade-provider-schema.ts),
 * and the application's Database over it through the production Turso adapter.
 *
 * Never import this from Worker code.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { connect } from "@tursodatabase/database";

import { searchIndexRebuildStatements } from "../search-index";
import { migratedImageCacheDirectory } from "./sqlite-d1";
import { createTursoDatabase } from "../turso-adapter";
import type { Database } from "../types";

export type TursoEngineDatabase = Awaited<ReturnType<typeof connect>>;
type All = (sql: string, ...params: unknown[]) => Promise<unknown[]>;

/** The schema runner's connection surface over a local Turso engine database. */
export function tursoEngineConnection(database: TursoEngineDatabase) {
  // The engine prepares synchronously; its typings declare a promise.
  const all: All = async (sql, ...params) => await (await database.prepare(sql)).all(...params as never[]) as unknown[];
  return {
    all,
    transactionAsync<T>(callback: (transaction: { all: All; batch(statements: string[]): Promise<unknown> }) => Promise<T>) {
      return {
        async immediate() {
          await database.exec("BEGIN IMMEDIATE");
          try {
            const result = await callback({
              all,
              async batch(statements) {
                for (const statement of statements) await database.exec(statement);
                return [];
              },
            });
            await database.exec("COMMIT");
            return result;
          } catch (error) {
            await database.exec("ROLLBACK");
            throw error;
          }
        },
      };
    },
    async close() {
      await database.close();
    },
  };
}

/**
 * The runner is a script, outside the package's type graph (its own types
 * target tsx, not the Worker): it is loaded by a computed specifier.
 */
const RUNNER_SCRIPT = "../../scripts/upgrade-provider-schema";

interface SchemaRunner {
  applyTursoSchemaUpgrades(connection: ReturnType<typeof tursoEngineConnection>, artifacts: unknown): Promise<unknown>;
  loadSchemaUpgradeArtifacts(): Promise<unknown>;
}

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
/** Inputs of an installed store besides the artifacts: the runner's own code and the engine. */
const TEMPLATE_INPUTS = ["../../scripts/upgrade-provider-schema.ts", "../../scripts/sqlite-provider-schema.ts", "../migration-artifacts.ts"]
  .map((path) => join(moduleDirectory, path));
const ENGINE_PACKAGE = join(moduleDirectory, "../../node_modules/@tursodatabase/database/package.json");

/**
 * The installed store as files, built once per schema and engine by the
 * runner on the engine itself, in the shared migrated-image cache. Installing
 * takes the engine one to two minutes (thousands of triggers); a copy of the
 * files it wrote opens in milliseconds and is the same store.
 */
async function installedStoreTemplate(runner: SchemaRunner, artifacts: unknown): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(artifacts));
  for (const file of [...TEMPLATE_INPUTS, ENGINE_PACKAGE]) hash.update(readFileSync(file));
  const directory = join(migratedImageCacheDirectory(), `turso-engine-${hash.digest("hex")}`);
  const lock = `${directory}.lock`;
  for (;;) {
    if (existsSync(join(directory, "store.db"))) {
      const now = new Date();
      // Touched on use: the cache prune keeps it (pruneMigratedImageCache).
      try {
        utimesSync(directory, now, now);
      } catch {
        // A read-only cache still serves the copy.
      }
      return directory;
    }
    try {
      mkdirSync(lock);
    } catch {
      // Another process is installing it; take over a lock left by a dead one.
      const age = Date.now() - (statSync(lock, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
      if (age > 15 * 60_000) rmSync(lock, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
      continue;
    }
    try {
      if (existsSync(join(directory, "store.db"))) return directory;
      const building = mkdtempSync(`${directory}.building-`);
      const database = await connect(join(building, "store.db"));
      await runner.applyTursoSchemaUpgrades(tursoEngineConnection(database), artifacts);
      await database.close();
      renameSync(building, directory);
      return directory;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** A fresh, current store on the Turso engine (at `path`, or a private temporary file). */
export async function freshTursoEngineStore(path = ":memory:"): Promise<TursoEngineDatabase> {
  const runner = await import(/* @vite-ignore */ RUNNER_SCRIPT) as SchemaRunner;
  const template = await installedStoreTemplate(runner, await runner.loadSchemaUpgradeArtifacts());
  const temporary = path === ":memory:" ? mkdtempSync(join(tmpdir(), "scalius-turso-engine-")) : undefined;
  const target = temporary ? join(temporary, "store.db") : path;
  // The main file and its write-ahead log: the engine leaves both.
  for (const name of readdirSync(template)) copyFileSync(join(template, name), `${target}${name.slice("store.db".length)}`);
  const database = await connect(target);
  if (temporary) {
    const close = database.close.bind(database);
    database.close = async () => {
      await close();
      rmSync(temporary, { recursive: true, force: true });
    };
  }
  // Foreign keys are a connection setting on SQLite engines; enforce them as D1 does.
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}

const SCHEMA_SCRIPT = "../../scripts/sqlite-provider-schema";

/**
 * A Turso engine store holding a copy of `source` (a Turso-schema SQLite
 * database, see createMigratedSqlite): its schema and rows, installed as the
 * runner installs a fresh store, then its search index rebuilt by the engine.
 * For fixtures that need writes the local engine does not run.
 */
export async function tursoEngineStoreFrom(source: DatabaseSync, path = ":memory:"): Promise<TursoEngineDatabase> {
  const schema = await import(/* @vite-ignore */ SCHEMA_SCRIPT) as { sqliteSchemaStatements(database: DatabaseSync): string[] };
  const database = await connect(path);
  await tursoEngineConnection(database).transactionAsync((transaction) =>
    transaction.batch([...schema.sqliteSchemaStatements(source), ...searchIndexRebuildStatements("sqlite")])).immediate();
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}

/** The application's Database over a Turso engine database, through the production adapter. */
export function createTursoEngineDatabase(engine: TursoEngineDatabase): Database {
  return createTursoDatabase(
    { url: "turso://engine-test.turso.io", authToken: "test" },
    {
      connect: () => ({
        async batch(statements, options) {
          const run = async () => {
            const results = [];
            for (const entry of statements) {
              const sql = typeof entry === "string" ? entry : entry.sql;
              const args = typeof entry === "string" || entry.args === undefined ? [] : entry.args;
              if (!Array.isArray(args)) throw new Error("The Turso engine harness accepts positional arguments only.");
              const prepared = await engine.prepare(sql);
              if (!prepared.reader) {
                const result = await prepared.run(...args as never[]);
                results.push({ rows: [], rowsAffected: Number(result.changes) });
              } else {
                const rows = await prepared.raw(true).all(...args as never[]) as unknown[];
                results.push({ columns: prepared.columns().map((column: { name: string }) => column.name), rows, rowsAffected: 0 });
              }
            }
            return results;
          };
          if (options?.mode === undefined) return run();
          await engine.exec(options.mode === "read" ? "BEGIN" : "BEGIN IMMEDIATE");
          try {
            const results = await run();
            await engine.exec("COMMIT");
            return results;
          } catch (error) {
            if (engine.inTransaction) await engine.exec("ROLLBACK");
            throw error;
          }
        },
      }),
      writeBatchMode: "immediate",
    },
  );
}
