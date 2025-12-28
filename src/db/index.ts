//src/db/index.ts
// Load environment variables first (for local development)
import "dotenv/config";

import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client/web";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema>;

// Create database client with environment variables
function createDatabaseClient(env: any): Database {
  if (!env.TURSO_DATABASE_URL) {
    throw new Error("TURSO_DATABASE_URL is not set");
  }

  if (!env.TURSO_AUTH_TOKEN) {
    throw new Error("TURSO_AUTH_TOKEN is not set");
  }

  const turso = createClient({
    url: env.TURSO_DATABASE_URL,
    authToken: env.TURSO_AUTH_TOKEN,
  });

  return drizzle(turso, { schema });
}

// Cached database instance - shared across requests within the same Worker isolate
let cachedDb: Database | null = null;

/**
 * Get database instance with singleton caching per Worker isolate.
 *
 * - First request in an isolate: Creates and caches the DB client
 * - Subsequent requests: Reuses the cached client (no TLS handshake overhead)
 *
 * This is critical for performance - creating a new libSQL client per request
 * causes 1-4 second delays due to TLS handshake with Turso.
 *
 * @param env - Cloudflare Workers environment bindings (optional for local dev)
 */
export function getDb(env?: Env | NodeJS.ProcessEnv): Database {
  // Return cached instance if available (fast path for warm requests)
  if (cachedDb) {
    return cachedDb;
  }

  // First request in this isolate - create and cache the client
  if (env && "TURSO_DATABASE_URL" in env && env.TURSO_DATABASE_URL) {
    cachedDb = createDatabaseClient(env);
    return cachedDb;
  }

  // Fallback for local development: use process.env
  cachedDb = createDatabaseClient(process.env);
  return cachedDb;
}

// Legacy export for backward compatibility (local dev scripts, migrations, etc.)
// WARNING: Do NOT use this in API routes - use getDb(env) instead
export const db = getDb();

// Export factory function and types
export { createDatabaseClient };
export { schema };
