import { sql } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import { handleFromText, nextFreeHandle, type HandleResource } from "@scalius/shared/handle";

const TAKEN_HANDLE_LOOKUP_LIMIT = 1000;
const INSERT_ATTEMPTS = 3;

export interface DerivedHandleTarget {
    db: Database;
    table: SQLiteTable;
    /** The handle column; its unique index covers soft-deleted rows too. */
    column: SQLiteColumn;
    /** Handles the storefront keeps for itself, e.g. `cart` for pages. */
    isReserved?: (handle: string) => boolean;
    /** The insert failed on this column's unique index. */
    isHandleConflict: (error: unknown) => boolean;
}

/**
 * Inserts a row whose handle the merchant didn't type: the handle reads as
 * `text` (see `@scalius/shared/handle`), and a taken or reserved one gets the
 * lowest free `-2`, `-3`… suffix. A concurrent create that wins the same
 * handle fails the insert on the unique index; that handle is then counted as
 * taken and the insert retried, three attempts in all.
 */
export async function insertWithDerivedHandle<T>(
    target: DerivedHandleTarget,
    text: string,
    resource: HandleResource,
    insert: (handle: string) => Promise<T>,
): Promise<T> {
    const base = handleFromText(text, resource);
    const rows = await target.db
        .select({ handle: target.column })
        .from(target.table)
        .where(sql`${target.column} = ${base} OR ${target.column} LIKE ${`${base}-%`}`)
        .limit(TAKEN_HANDLE_LOOKUP_LIMIT);
    const taken = new Set(rows.map((row) => String(row.handle)));
    for (let attempt = 1; ; attempt += 1) {
        let handle = nextFreeHandle(base, taken);
        while (target.isReserved?.(handle)) {
            taken.add(handle);
            handle = nextFreeHandle(base, taken);
        }
        try {
            return await insert(handle);
        } catch (error) {
            if (attempt >= INSERT_ATTEMPTS || !target.isHandleConflict(error)) throw error;
            taken.add(handle);
        }
    }
}
