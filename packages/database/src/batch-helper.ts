// packages/database/src/batch-helper.ts
// Type-safe wrapper around D1's db.batch().

import type { Database } from "./types";

/**
 * Type-safe wrapper around D1's db.batch() that centralises the `as any` cast.
 * Drizzle's D1 batch() has an overly narrow tuple type that doesn't accept
 * dynamically-built statement arrays. This wrapper contains the single cast.
 */
export function safeBatch<T extends readonly unknown[]>(
  db: Database,
  statements: T,
): Promise<any[]> {
  return (db as any).batch(statements as any);
}
