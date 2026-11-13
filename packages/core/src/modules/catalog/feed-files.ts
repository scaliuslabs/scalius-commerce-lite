// Catalogue feed files (`@scalius/shared/catalog-feed-files`): the stored,
// append-only list of file starts (one settings row), what a file request
// reads from it, and adding the next file. The last file's size is read from
// the buyer state's newest index (one row per product, `is_public` first): one
// ordered range per `is_public` value, at most a file plus one row each, so no
// read here walks the catalogue.
import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import {
    FEED_FILE_NEARLY_FULL_SHARE,
    feedFileRange,
    mergeAscending,
    nextFeedFileStart,
    parseFeedFileStarts,
    type FeedFileRange,
} from "@scalius/shared/catalog-feed-files";
import { ValidationError } from "@scalius/core/errors";
import { buyerState } from "./buyer-state";
import { deps } from "./declare-deps";

/** The settings row that holds the file starts (`set:catalog_feed:file_starts`). */
export const FEED_FILES_SETTINGS_CATEGORY = "catalog_feed";
export const FEED_FILES_SETTINGS_KEY = "file_starts";

async function readStoredStarts(db: Database): Promise<{ starts: number[]; stored: string | null }> {
    const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, FEED_FILES_SETTINGS_CATEGORY), eq(settings.key, FEED_FILES_SETTINGS_KEY)))
        .get();
    return { starts: parseFeedFileStarts(row?.value), stored: row?.value ?? null };
}

/** Every file's start, ascending from 0. A public read depends on the one settings row. */
export async function getFeedFileStarts(db: Database): Promise<number[]> {
    const { starts } = await readStoredStarts(db);
    deps.settings(FEED_FILES_SETTINGS_CATEGORY, FEED_FILES_SETTINGS_KEY);
    return starts;
}

/** The file `from` starts, or null when no stored start is `from`: a URL never listed reads nothing more. */
export async function getFeedFile(db: Database, from: number): Promise<(FeedFileRange & { last: boolean }) | null> {
    const range = feedFileRange(await getFeedFileStarts(db), from);
    return range ? { ...range, last: range.to === null } : null;
}

/** Creation seconds of the first `limit` product rows (any state) created at or after `from`, ascending. */
async function readCreatedSeconds(db: Database, from: number, limit: number): Promise<number[]> {
    const range = (isPublic: boolean) => db
        .select({ createdAt: sql<number>`CAST(${buyerState.productCreatedAt} AS INTEGER)` })
        .from(buyerState)
        .where(and(eq(buyerState.isPublic, isPublic), gte(buyerState.productCreatedAt, sql`${from}`)))
        .orderBy(asc(buyerState.productCreatedAt))
        .limit(limit)
        .all();
    const [hidden, listed] = await Promise.all([range(false), range(true)]);
    return mergeAscending(hidden.map((row) => Number(row.createdAt)), listed.map((row) => Number(row.createdAt))).slice(0, limit);
}

export interface FeedFilesOverview {
    /** Product rows one file lists (the plan's `feedProductsPerRequest`). */
    perFile: number;
    files: Array<FeedFileRange & { number: number }>;
    /** The last file: its product rows in any state (at most `perFile + 1` counted). */
    last: { rows: number; nearlyFull: boolean; overfull: boolean };
}

/**
 * Every file for the dashboard: the stored starts, and how full the last
 * file is. Three statements and at most `2 × (perFile + 1)` index rows,
 * whatever the catalogue's size.
 */
export async function listFeedFiles(db: Database, perFile: number): Promise<FeedFilesOverview> {
    const { starts } = await readStoredStarts(db);
    const rows = (await readCreatedSeconds(db, starts.at(-1)!, perFile + 1)).length;
    return {
        perFile,
        files: starts.map((from, index) => ({ number: index + 1, from, to: starts[index + 1] ?? null })),
        last: {
            rows,
            nearlyFull: rows >= Math.ceil(perFile * FEED_FILE_NEARLY_FULL_SHARE),
            overfull: rows > perFile,
        },
    };
}

/**
 * Add the next file, once the last is nearly full. `expectedFiles` is the
 * number of files the merchant saw: a repeated or concurrent request finds
 * the list grown and adds nothing. The write is one guarded statement (an
 * upsert that replaces the stored list only while it is still the list this
 * request read), so two requests can never both append.
 */
export async function addFeedFile(
    db: Database,
    perFile: number,
    expectedFiles: number,
    now = Math.floor(Date.now() / 1000),
): Promise<FeedFilesOverview & { added: boolean }> {
    const { starts, stored } = await readStoredStarts(db);
    if (starts.length !== expectedFiles) return { ...(await listFeedFiles(db, perFile)), added: false };
    const lastFile = await readCreatedSeconds(db, starts.at(-1)!, perFile + 1);
    if (lastFile.length < Math.ceil(perFile * FEED_FILE_NEARLY_FULL_SHARE)) {
        throw new ValidationError("The newest feed file has room for more products: add the next file when it is nearly full.");
    }
    const next = JSON.stringify([...starts, nextFeedFileStart(starts, lastFile, perFile, now)]);
    const written = await db.insert(settings)
        .values({
            id: `${FEED_FILES_SETTINGS_CATEGORY}:${FEED_FILES_SETTINGS_KEY}`,
            key: FEED_FILES_SETTINGS_KEY,
            value: next,
            type: "json",
            category: FEED_FILES_SETTINGS_CATEGORY,
        })
        .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value: sql`excluded.value`, updatedAt: sql`unixepoch()` },
            setWhere: sql`${settings.value} = ${stored ?? ""}`,
        })
        .returning({ value: settings.value });
    return { ...(await listFeedFiles(db, perFile)), added: written.length > 0 };
}
