// Catalogue feed files (`@scalius/shared/catalog-feed-files`): where each
// file of the Google and Meta feeds starts and ends. A file counts every
// product row by its creation second, so the reads go to the buyer state's
// newest index (one row per product, `is_public` first): one ordered range per
// `is_public` value, merged here. Neither read sorts the catalogue.
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import {
    chainFeedFiles,
    feedFileEnd,
    mergeAscending,
    type FeedFile,
    type FeedFileRange,
} from "@scalius/shared/catalog-feed-files";
import { buyerState } from "./buyer-state";
import { deps } from "./declare-deps";

/**
 * Every product row (any state) is in exactly one file: a product insert,
 * delete or creation-time change moves a file's end. The products table's key
 * covers each; a buyer-state row is written in the same batch as its product.
 */
function declareFeedFileRows(): void {
    deps.table("products");
}

/** Creation seconds of product rows created at or after `from`, ascending; at most `limit` of each `is_public` value. */
async function readCreatedSeconds(db: Database, from: number, limit: number | null): Promise<number[]> {
    const range = (isPublic: boolean) => {
        const query = db
            .select({ createdAt: sql<number>`CAST(${buyerState.productCreatedAt} AS INTEGER)` })
            .from(buyerState)
            .where(and(eq(buyerState.isPublic, isPublic), gte(buyerState.productCreatedAt, sql`${from}`)))
            .orderBy(asc(buyerState.productCreatedAt));
        return (limit === null ? query : query.limit(limit)).all();
    };
    const [hidden, listed] = await Promise.all([range(false), range(true)]);
    return mergeAscending(hidden.map((row) => Number(row.createdAt)), listed.map((row) => Number(row.createdAt)));
}

/**
 * The file that starts at `from`: it ends where its `perFile + 1`-th product
 * row was created. The last file (null end) is read up to the second after its
 * newest row, so one request lists what existed when it started.
 */
export async function getFeedFileWindow(
    db: Database,
    from: number,
    perFile: number,
): Promise<FeedFileRange & { last: boolean }> {
    const seconds = await readCreatedSeconds(db, from, perFile + 1);
    declareFeedFileRows();
    const to = feedFileEnd(seconds, perFile);
    if (to !== null) return { from, to, last: false };
    return { from, to: seconds.length > 0 ? seconds.at(-1)! + 1 : from, last: true };
}

/**
 * Every file of the feeds, for the dashboard. A catalogue within one file
 * costs the same two bounded reads as a file request; a larger one reads every
 * product row's creation second once.
 */
export async function listFeedFiles(db: Database, perFile: number): Promise<{ perFile: number; files: FeedFile[] }> {
    const probe = await readCreatedSeconds(db, 0, perFile + 1);
    const seconds = feedFileEnd(probe, perFile) === null ? probe : await readCreatedSeconds(db, 0, null);
    return { perFile, files: chainFeedFiles(seconds, perFile) };
}
