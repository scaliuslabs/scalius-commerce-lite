import * as schema from "./schema";
import { drizzleD1 } from "./drizzle-clients";
import {
  registerDatabaseProvider,
  registeredDatabaseProvider,
  resolveDatabaseConfiguration,
  type DatabaseEnvironment,
  type DatabaseProvider,
} from "./provider";
import { createTursoDatabase } from "./turso-adapter";
import {
  connectNeonPostgres,
  connectNativePostgres,
  createPostgresDatabase,
} from "./postgres-adapter";
import { observeD1Prepare, observeD1Statement } from "./read-observer";
import type { Database } from "./types";

type D1SessionFactory = (
  constraintOrBookmark?: string,
) => Pick<D1Database, "prepare" | "batch">;

function createD1RequestClient(binding: D1Database): D1Database {
  const candidate = Reflect.get(binding, "withSession") as unknown;
  // Every statement, batches included, is prepared through `prepare`, which
  // reports it to the request's read observer (read-observer.ts).
  if (typeof candidate !== "function") return observeD1Prepare(binding);
  const withSession = candidate as D1SessionFactory;

  // The first operation observes the primary. Later reads in the same request
  // may use a replica without losing sequential consistency.
  const session = withSession.call(binding, "first-primary");
  const prepare = (query: string) => observeD1Statement(query, (sql) => session.prepare(sql));
  const batch = session.batch.bind(session);
  return new Proxy(binding, {
    get(target, property, receiver) {
      if (property === "prepare") return prepare;
      if (property === "batch") return batch;
      return Reflect.get(target, property, receiver);
    },
  });
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
  connectNativePostgres,
  createPostgresDatabase,
  isPostgresSerializationError,
} from "./postgres-adapter";
export { connectPostgres } from "./postgres-adapter";

/**
 * Compose a database client for the current request or Worker event.
 *
 * D1 remains the default. Complete Turso or PostgreSQL credentials select the
 * corresponding adapter unless DATABASE_PROVIDER explicitly pins one provider.
 */
export function getDb(env?: DatabaseEnvironment): Database {
  const config = resolveDatabaseConfiguration(env);

  if (config.provider === "turso") {
    return createTursoDatabase({
      url: config.url,
      authToken: config.authToken,
    }, {
      writeBatchMode: config.writeBatchMode,
    });
  }

  if (config.provider === "postgres") {
    return createPostgresDatabase(config.connectionString, {
      connect: config.transport === "neon-http"
        ? connectNeonPostgres
        : connectNativePostgres,
    });
  }

  // A client per call, so no binding or provider outlives its request; only
  // the code-derived relational schema is shared (drizzle-clients.ts).
  return registerDatabaseProvider(drizzleD1(createD1RequestClient(config.binding)), "d1");
}

/**
 * Read immutable provider metadata for a composed database client. Unregistered
 * test doubles retain the D1/FTS5 behavior used by existing unit tests.
 */
export function getDatabaseProviderForClient(
  database: Database,
): DatabaseProvider {
  return registeredDatabaseProvider(database as object);
}

export { schema };
export {
  buildBatchGuard,
  chunkForD1,
  chunkRowsForD1,
  D1_ID_CHUNK_SIZE,
  isBatchGuardError,
  safeBatch,
} from "./batch-helper";
