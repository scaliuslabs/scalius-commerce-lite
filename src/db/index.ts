// src/db/index.ts
// Cloudflare D1 database adapter – replaces libSQL/Turso

import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";

export type Database = DrizzleD1Database<typeof schema>;

// Module-level singleton – set once per isolate on the first request.
// D1 bindings are stable handles to the same underlying database across
// requests, so sharing a single Drizzle instance is safe and free
// (unlike Turso, D1 has no per-connection TLS handshake cost).
let _db: Database | null = null;

/**
 * Initialise (or return the cached) Drizzle database instance.
 *
 * @param env - Cloudflare Workers env object containing `env.DB: D1Database`
 */
export function getDb(env?: { DB?: D1Database } | any): Database {
  if (_db) return _db;

  const d1 = env?.DB as D1Database | undefined;
  if (!d1) {
    throw new Error(
      "D1 database binding (env.DB) is not available. " +
        "Make sure the DB binding is configured in wrangler.jsonc and " +
        "the Astro middleware has initialised the database context.",
    );
  }

  _db = drizzle(d1, { schema });
  return _db;
}

/**
 * Legacy proxy export – resolves to the module-level Drizzle instance.
 *
 * Existing Astro pages / API routes / lib files that do
 *   `import { db } from "@/db"`
 * continue to work without modification, provided the Astro middleware
 * (src/middleware.ts) calls `getDb(env)` before any page handler runs.
 */
export const db = new Proxy({} as Database, {
  get(_target, prop) {
    if (!_db) {
      throw new Error(
        "Database accessed before initialisation. " +
          "Ensure the Astro middleware has run getDb(env) for this request.",
      );
    }
    return (_db as any)[prop];
  },
});

export { schema };
