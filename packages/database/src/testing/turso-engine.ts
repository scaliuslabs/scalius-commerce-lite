/**
 * Test-only: a fresh store on the local Turso engine (`@tursodatabase/database`),
 * installed the way the Turso schema runner installs one (the current schema,
 * seed rows and ledger in one transaction, scripts/upgrade-provider-schema.ts),
 * and the application's Database over it through the production Turso adapter.
 *
 * Never import this from Worker code.
 */
import type { DatabaseSync } from "node:sqlite";
import { connect } from "@tursodatabase/database";

import { searchIndexRebuildStatements } from "../search-index";
import { createTursoDatabase } from "../turso-adapter";
import type { Database } from "../types";

export type TursoEngineDatabase = Awaited<ReturnType<typeof connect>>;
type All = (sql: string, ...params: unknown[]) => Promise<unknown[]>;

/** The schema runner's connection surface over a local Turso engine database. */
export function tursoEngineConnection(database: TursoEngineDatabase) {
  const all: All = async (sql, ...params) => await database.prepare(sql).all(...params as never[]) as unknown[];
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

/** A fresh, current store on the Turso engine. */
export async function freshTursoEngineStore(path = ":memory:"): Promise<TursoEngineDatabase> {
  const runner = await import(/* @vite-ignore */ RUNNER_SCRIPT) as {
    applyTursoSchemaUpgrades(connection: ReturnType<typeof tursoEngineConnection>, artifacts: unknown): Promise<unknown>;
    loadSchemaUpgradeArtifacts(): Promise<unknown>;
  };
  const database = await connect(path);
  await runner.applyTursoSchemaUpgrades(tursoEngineConnection(database), await runner.loadSchemaUpgradeArtifacts());
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
              const prepared = engine.prepare(sql);
              if (!prepared.reader) {
                const result = await prepared.run(...args as never[]);
                results.push({ rows: [], rowsAffected: Number(result.changes) });
              } else {
                const rows = await prepared.raw(true).all(...args as never[]) as unknown[];
                results.push({ columns: prepared.columns().map((column) => column.name), rows, rowsAffected: 0 });
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
