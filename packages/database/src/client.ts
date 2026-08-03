import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import {
  resolveDatabaseConfiguration,
  type DatabaseEnvironment,
  type DatabaseProvider,
} from "./provider";
import { createTursoDatabase } from "./turso-adapter";
import {
  connectNeonPostgres,
  createPostgresDatabase,
} from "./postgres-adapter";
import type { Database } from "./types";

const providerByDatabase = new WeakMap<object, DatabaseProvider>();

function createD1RequestClient(binding: D1Database): D1Database {
  if (typeof binding.withSession !== "function") return binding;

  // The first operation observes the primary. Later reads in the same request
  // may use a replica without losing sequential consistency.
  return binding.withSession("first-primary") as unknown as D1Database;
}

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
export {
  connectNeonPostgres,
  createPostgresDatabase,
  isPostgresSerializationError,
} from "./postgres-adapter";

/**
 * Compose a database client for the current request or Worker event.
 *
 * D1 remains the default. Complete Turso or PostgreSQL credentials select the
 * corresponding adapter unless DATABASE_PROVIDER explicitly pins one provider.
 */
export function getDb(env?: DatabaseEnvironment): Database {
  const config = resolveDatabaseConfiguration(env);

  if (config.provider === "turso") {
    const database = createTursoDatabase({
      url: config.url,
      authToken: config.authToken,
    }, {
      writeBatchMode: config.writeBatchMode,
    });
    providerByDatabase.set(database as object, "turso");
    return database;
  }

  if (config.provider === "postgres") {
    const database = createPostgresDatabase(config.connectionString, {
      connect: connectNeonPostgres,
    });
    providerByDatabase.set(database as object, "postgres");
    return database;
  }

  // Drizzle construction is local and cheap. Avoiding mutable isolate-global
  // state prevents one binding/provider from leaking into another request.
  const database = drizzle(createD1RequestClient(config.binding), { schema });
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
export {
  buildBatchGuard,
  isBatchGuardError,
  safeBatch,
} from "./batch-helper";
