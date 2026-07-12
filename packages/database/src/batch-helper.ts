// packages/database/src/batch-helper.ts
// Type-safe wrapper around D1's db.batch().

import type { Database } from "./types";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { sql, type SQL } from "drizzle-orm";

type SQLiteBatchItem = BatchItem<"sqlite">;
type DynamicBatchDatabase = Database & {
  batch<T extends readonly SQLiteBatchItem[]>(
    statements: T,
  ): Promise<BatchResponse<T>>;
};

/**
 * Type-safe wrapper around D1's db.batch() that centralises the dynamic batch cast.
 * Drizzle's D1 batch() has an overly narrow tuple type that doesn't accept
 * dynamically-built statement arrays. This wrapper contains the single cast.
 */
export function safeBatch<T extends readonly SQLiteBatchItem[]>(
  db: Database,
  statements: T,
): Promise<BatchResponse<T>> {
  return (db as DynamicBatchDatabase).batch(statements);
}

/**
 * Builds a parameterized guard that is safe inside Drizzle's D1 batch().
 * `db.run(sql`...`)` produces SQLiteRaw, whose parameterized form has no
 * prepared `stmt` in Drizzle 0.45's D1 batch implementation.
 */
export function buildBatchGuard(db: Database, expression: SQL): SQLiteBatchItem {
  return db
    .select({ batchGuard: expression })
    .from(sql`(SELECT 1) AS batch_guard_source`);
}
