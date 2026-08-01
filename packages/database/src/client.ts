import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import {
  resolveDatabaseConfiguration,
  type DatabaseEnvironment,
  type DatabaseProvider,
} from "./provider";
import { createTursoDatabase } from "./turso-adapter";
import type { Database } from "./types";

const providerByDatabase = new WeakMap<object, DatabaseProvider>();

export type { Database } from "./types";
export type {
  DatabaseConfiguration,
  DatabaseEnvironment,
  DatabaseProvider,
} from "./provider";
export {
  getDatabaseProviderCapabilities,
  resolveDatabaseConfiguration,
} from "./provider";
export { createTursoDatabase, isTursoConflictError } from "./turso-adapter";

/**
 * Compose a database client for the current request or Worker event.
 *
 * D1 remains the default. Installing both Turso secrets selects the Turso
 * adapter unless DATABASE_PROVIDER explicitly pins D1 for rollback.
 */
export function getDb(env?: DatabaseEnvironment): Database {
  const config = resolveDatabaseConfiguration(env);

  if (config.provider === "turso") {
    const database = createTursoDatabase({
      url: config.url,
      authToken: config.authToken,
    });
    providerByDatabase.set(database as object, "turso");
    return database;
  }

  // Drizzle construction is local and cheap. Avoiding mutable isolate-global
  // state prevents one binding/provider from leaking into another request.
  const database = drizzle(config.binding, { schema });
  providerByDatabase.set(database as object, "d1");
  return database;
}

/**
 * Read immutable provider metadata for a composed database client. Unregistered
 * test doubles retain the D1/FTS5 behavior used by existing unit tests.
 */
export function getDatabaseProviderForClient(
  database: Database,
): DatabaseProvider {
  return providerByDatabase.get(database as object) ?? "d1";
}

export { schema };
export { buildBatchGuard, safeBatch } from "./batch-helper";
