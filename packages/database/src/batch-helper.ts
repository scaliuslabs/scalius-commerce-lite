// packages/database/src/batch-helper.ts
// Type-safe wrapper around D1's db.batch().

import { AsyncLocalStorage } from "node:async_hooks";
import type { Database } from "./types";
import type { BatchItem, BatchResponse } from "drizzle-orm/batch";
import { eq, sql, type SQL } from "drizzle-orm";
import { cacheClock } from "./schema/system";

type SQLiteBatchItem = BatchItem<"sqlite">;
type DynamicBatchDatabase = Database & {
  batch<T extends readonly SQLiteBatchItem[]>(
    statements: T,
  ): Promise<BatchResponse<T>>;
};

const BATCH_GUARD_MARKER = /^[A-Z_][A-Z0-9_]*$/;

const coarseCacheClock = new AsyncLocalStorage<true>();
const WRITE_STATEMENT = /^\s*(?:WITH\b[\s\S]*?\b)?(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;

function writes(statement: SQLiteBatchItem): boolean {
  try {
    const query = (statement as unknown as { toSQL?: () => { sql: string } }).toSQL?.();
    // A statement whose text cannot be read is treated as a write (coarse is never wrong, only coarser).
    return query ? WRITE_STATEMENT.test(query.sql) : true;
  } catch {
    return true;
  }
}

/**
 * Runs `work` with every write batch it sends through `safeBatch` in coarse
 * cache-clock mode (migration 0100): inside such a batch each cache
 * dependency trigger advances only `store`, once per fire, instead of each
 * row's keys. A bulk change of thousands of products (bulk runs) then writes
 * a few clock rows per chunk instead of about 17 dependency rows a product;
 * every public entry depends on `store`, so it is coarser, never stale. The
 * flag is set and cleared inside each batch's own transaction, so no other
 * write sees it. Read-only batches are sent as they are.
 */
export function withCoarseCacheClock<T>(work: () => Promise<T>): Promise<T> {
  return coarseCacheClock.run(true, work);
}

/**
 * Type-safe wrapper around D1's db.batch() that centralises the dynamic batch cast.
 * Drizzle's D1 batch() has an overly narrow tuple type that doesn't accept
 * dynamically-built statement arrays. This wrapper contains the single cast.
 */
export function safeBatch<T extends readonly SQLiteBatchItem[]>(
  db: Database,
  statements: T,
): Promise<BatchResponse<T>> {
  const batch = db as DynamicBatchDatabase;
  if (!coarseCacheClock.getStore() || !statements.some(writes)) return batch.batch(statements);
  const coarse = (value: number) => db.update(cacheClock).set({ coarse: value }).where(eq(cacheClock.id, 1)) as unknown as SQLiteBatchItem;
  return batch.batch([coarse(1), ...statements, coarse(0)] as unknown as T)
    .then((results) => (results as unknown as unknown[]).slice(1, -1) as unknown as BatchResponse<T>);
}

/**
 * Builds a parameterized, provider-neutral guard for an atomic batch.
 * The success and failure branches are both numeric so PostgreSQL can resolve
 * the CASE type before execution. A false condition uses SQLite's invalid JSON
 * path sentinel, which the PostgreSQL compiler rewrites to the typed VOLATILE
 * `scalius_compat.fail_bigint()` function. Callers provide only the boolean
 * domain predicate; dialect-sensitive failure construction stays here.
 */
export function buildBatchGuard(
  db: Database,
  successCondition: SQL,
  failureMarker: string,
): SQLiteBatchItem {
  if (!BATCH_GUARD_MARKER.test(failureMarker)) {
    throw new Error("Batch guard failure markers must be uppercase identifiers.");
  }
  const failureSentinel = sql.raw(
    `json_extract('{}', '${failureMarker}')`,
  );
  return db
    .select({
      batchGuard: sql`CASE WHEN ${successCondition} THEN 1 ELSE ${failureSentinel} END`,
    })
    .from(sql`(SELECT 1) AS batch_guard_source`);
}

/**
 * Recognizes the deliberately raised guard error across provider transports.
 * D1/TursoDB expose the invalid-path marker; PostgreSQL's typed raising
 * function uses the same marker as its exception message.
 */
export function isBatchGuardError(
  error: unknown,
  failureMarker: string,
): boolean {
  if (!BATCH_GUARD_MARKER.test(failureMarker)) return false;

  const text = collectBatchErrorText(error);
  if (text.includes(failureMarker)) return true;
  return /malformed json/i.test(text);
}

function collectBatchErrorText(error: unknown, depth = 0): string {
  if (depth > 5 || error === null || error === undefined) return "";
  if (typeof error !== "object") return String(error);

  const candidate = error as {
    name?: unknown;
    message?: unknown;
    detail?: unknown;
    hint?: unknown;
    cause?: unknown;
  };
  return [
    candidate.name,
    candidate.message,
    candidate.detail,
    candidate.hint,
    collectBatchErrorText(candidate.cause, depth + 1),
  ].filter((value): value is string => typeof value === "string" && value.length > 0)
    .join(" ");
}

// D1 accepts at most 100 bound parameters per statement. Keep one slot in
// reserve for future surrounding predicates/expressions and size multi-row
// inserts from their conservative per-row parameter count.
const D1_SAFE_BOUND_PARAMETER_LIMIT = 99;

/**
 * The most ids one statement binds in an `IN (...)` list: room under D1's 100
 * bound parameters for the rest of the statement.
 */
export const D1_ID_CHUNK_SIZE = 90;

/**
 * Consecutive slices of at most `size` values (default {@link D1_ID_CHUNK_SIZE}):
 * the one way core splits id lists for bounded reads and rows for bounded
 * writes. Callers run the slices' statements sequentially or in bounded waves.
 */
export function chunkForD1<T>(values: readonly T[], size: number = D1_ID_CHUNK_SIZE): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) {
    throw new RangeError("chunk size must be a positive integer");
  }
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
}

/** Rows of a multi-row insert, as many per statement as their bound parameters allow. */
export function chunkRowsForD1<T>(
  rows: readonly T[],
  parametersPerRow: number,
): T[][] {
  if (!Number.isSafeInteger(parametersPerRow) || parametersPerRow < 1) {
    throw new RangeError("parametersPerRow must be a positive integer");
  }
  return chunkForD1(rows, Math.max(1, Math.floor(D1_SAFE_BOUND_PARAMETER_LIMIT / parametersPerRow)));
}
