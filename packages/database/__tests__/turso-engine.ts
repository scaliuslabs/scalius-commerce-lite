/**
 * A fresh store on the local Turso engine (`@tursodatabase/database`),
 * installed the way the Turso schema runner installs one: the current schema,
 * seed rows and ledger in one transaction (scripts/upgrade-provider-schema.ts).
 */
import { connect } from "@tursodatabase/database";

import {
  applyTursoSchemaUpgrades,
  loadSchemaUpgradeArtifacts,
  type TursoSchemaConnection,
} from "../scripts/upgrade-provider-schema";

type EngineDatabase = Awaited<ReturnType<typeof connect>>;

/** The runner's connection surface over a local Turso engine database. */
export function tursoEngineConnection(database: EngineDatabase): TursoSchemaConnection {
  const all = async (sql: string, ...params: unknown[]) => await database.prepare(sql).all(...params as never[]) as unknown[];
  return {
    all,
    transactionAsync<T>(callback: (transaction: { all: typeof all; batch(statements: string[]): Promise<unknown> }) => Promise<T>) {
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

/** A fresh, current store on the Turso engine. */
export async function freshTursoEngineStore(path = ":memory:"): Promise<EngineDatabase> {
  const database = await connect(path);
  await applyTursoSchemaUpgrades(tursoEngineConnection(database), await loadSchemaUpgradeArtifacts());
  // Foreign keys are a connection setting on SQLite engines; enforce them as D1 does.
  await database.exec("PRAGMA foreign_keys = ON");
  return database;
}
