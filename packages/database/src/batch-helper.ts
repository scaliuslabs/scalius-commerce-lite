// packages/database/src/batch-helper.ts
// Type-safe wrapper around D1's db.batch().

import type { Database } from "./types";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";

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
