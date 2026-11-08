// Customer erasure and buyer uploads: the files of the erased customer's
// orders become `delete_file` tasks (`upload:<id>`, a repeat is a no-op) and
// their rows go, in the erasure batch. The drain deletes the objects; the
// erase result counts them as pending until it has.
import type { Database } from "@scalius/database/client";
import { buyerUploads, customerErasureTasks } from "@scalius/database/schema";
import { sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

type SQLiteBatchItem = BatchItem<"sqlite">;

/**
 * `theirOrder(column)` is true when the column names one of the customer's
 * orders (the erasure scope's order set, read inside the statement).
 */
export function buyerUploadErasureStatements(
    db: Database,
    subjectId: string,
    theirOrder: (column: typeof buyerUploads.orderId) => SQL,
): SQLiteBatchItem[] {
    return [
        db.insert(customerErasureTasks).select(sql`
            SELECT 'upload:' || ${buyerUploads.id}, ${subjectId}, 'delete_file', NULL, ${buyerUploads.r2Key},
              0, unixepoch(), NULL, unixepoch()
            FROM ${buyerUploads}
            WHERE ${buyerUploads.orderId} IS NOT NULL AND ${theirOrder(buyerUploads.orderId)}
        `).onConflictDoNothing() as unknown as SQLiteBatchItem,
        db.delete(buyerUploads).where(sql`${buyerUploads.orderId} IS NOT NULL AND ${theirOrder(buyerUploads.orderId)}`) as unknown as SQLiteBatchItem,
    ];
}
