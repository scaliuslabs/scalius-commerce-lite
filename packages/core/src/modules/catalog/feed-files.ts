// Catalogue feed files (`@scalius/shared/catalog-feed-files`): the stored
// starts (one settings row, the public reads' dependency), what a file
// request reads from them, and the scheduled maintenance that adds a start
// inside any file holding more product rows than a file lists.
//
// A file's size is read from the buyer state's newest index (one row per
// product, `is_public` first): one ordered range per `is_public` value, at most
// a file plus one row each, so no read here walks the catalogue. The
// maintenance's own bookkeeping lives in `system_kv` (private, no public
// read depends on it): the plan size the files were checked for, the next
// file to check while it checks every file, the newest file's row count and
// the database second it was counted at, and how many links the merchant has
// been shown.
import { and, asc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { settings } from "@scalius/database/schema";
import {
    feedFileRange,
    feedFileSplit,
    mergeAscending,
    parseFeedFilesState,
    serializeFeedFilesState,
    withFeedFileStart,
    type FeedFileRange,
    type FeedFilesState,
} from "@scalius/shared/catalog-feed-files";
import { getSystemKvMany, putSystemKv, deleteSystemKv } from "../../utils/system-kv";
import { buyerState } from "./buyer-state";
import { deps } from "./declare-deps";

/** The settings row that holds the file starts (`set:catalog_feed:file_starts`). */
export const FEED_FILES_SETTINGS_CATEGORY = "catalog_feed";
export const FEED_FILES_SETTINGS_KEY = "file_starts";

/** `system_kv`: the per-file size every file was last checked against. */
export const FEED_FILES_PLAN_KEY = "catalog:feed-files:plan";
/** `system_kv`: the index of the next file to check while checking every file. */
export const FEED_FILES_VERIFY_KEY = "catalog:feed-files:verify";
/** `system_kv`: product rows in the newest file (an upper bound between exact counts). */
export const FEED_FILES_NEWEST_KEY = "catalog:feed-files:newest";
/** `system_kv`: the database second the newest file was last counted at. */
export const FEED_FILES_CHECKED_AT_KEY = "catalog:feed-files:checked-at";
/** `system_kv`: product rows created at or after that second when it was counted (rows of that very second). */
export const FEED_FILES_CHECKED_COUNT_KEY = "catalog:feed-files:checked-count";
/** `system_kv`: how many file links the merchant has been shown. */
export const FEED_FILES_SEEN_KEY = "catalog:feed-files:seen";

async function readState(db: Database): Promise<{ state: FeedFilesState; stored: string | null }> {
    const row = await db
        .select({ value: settings.value })
        .from(settings)
        .where(and(eq(settings.category, FEED_FILES_SETTINGS_CATEGORY), eq(settings.key, FEED_FILES_SETTINGS_KEY)))
        .get();
    return { state: parseFeedFilesState(row?.value), stored: row?.value ?? null };
}

/**
 * Replace the stored state only while it is still `stored` (the value this
 * caller read): one upsert, so two writers can never both apply a change
 * made from the same state. Returns whether this write won.
 */
async function writeState(db: Database, stored: string | null, next: FeedFilesState): Promise<boolean> {
    const written = await db.insert(settings)
        .values({
            id: `${FEED_FILES_SETTINGS_CATEGORY}:${FEED_FILES_SETTINGS_KEY}`,
            key: FEED_FILES_SETTINGS_KEY,
            value: serializeFeedFilesState(next),
            type: "json",
            category: FEED_FILES_SETTINGS_CATEGORY,
        })
        .onConflictDoUpdate({
            target: [settings.key, settings.category],
            set: { value: sql`excluded.value`, updatedAt: sql`unixepoch()` },
            setWhere: sql`${settings.value} = ${stored ?? ""}`,
        })
        .returning({ value: settings.value });
    return written.length > 0;
}

export interface FeedFile extends FeedFileRange {
    /** 1 for the bare feed URL, then in creation order. */
    number: number;
    last: boolean;
    /** Holds more product rows than a file lists and cannot be split (more created in one second). */
    overfull: boolean;
}

export interface FeedFileRead extends FeedFile {
    /** Files in all. */
    total: number;
    /** Numbers of the files known to hold more product rows than a file lists. */
    overfullFiles: number[];
    /** The maintenance is still checking every file: a file may hold more than it lists until it is split. */
    checking: boolean;
}

function filesOf(state: FeedFilesState): FeedFile[] {
    return state.starts.map((from, index) => ({
        number: index + 1,
        from,
        to: state.starts[index + 1] ?? null,
        last: index === state.starts.length - 1,
        overfull: state.overfull.includes(from),
    }));
}

/** The file `from` starts, or null when no stored start is `from`: a URL never listed reads nothing more. */
export async function getFeedFile(db: Database, from: number): Promise<FeedFileRead | null> {
    const { state } = await readState(db);
    deps.settings(FEED_FILES_SETTINGS_CATEGORY, FEED_FILES_SETTINGS_KEY);
    if (!feedFileRange(state.starts, from)) return null;
    const files = filesOf(state);
    const file = files.find((each) => each.from === from)!;
    return {
        ...file,
        total: files.length,
        overfullFiles: files.filter((each) => each.overfull).map((each) => each.number),
        checking: state.checking,
    };
}

export interface FeedFilesOverview {
    files: FeedFile[];
    checking: boolean;
    /** Links the merchant has not been shown yet (the first file's bare URL counts as shown). */
    unseen: number;
}

/** Every file for the dashboard: two statements, no product row read. */
export async function listFeedFiles(db: Database): Promise<FeedFilesOverview> {
    const [{ state }, kv] = await Promise.all([readState(db), getSystemKvMany(db, [FEED_FILES_SEEN_KEY])]);
    const seen = Math.max(1, Number(kv.get(FEED_FILES_SEEN_KEY) ?? 1) || 1);
    return { files: filesOf(state), checking: state.checking, unseen: Math.max(0, state.starts.length - seen) };
}

/** The merchant has been shown `count` links (the dashboard's file list). */
export async function markFeedFilesSeen(db: Database, count: number): Promise<void> {
    await putSystemKv(db, FEED_FILES_SEEN_KEY, String(count));
}

/** Creation seconds of the first `limit` product rows (any state) in [from, before), ascending. */
async function readCreatedSeconds(db: Database, from: number, before: number | null, limit: number): Promise<number[]> {
    const range = (isPublic: boolean) => db
        .select({ createdAt: sql<number>`CAST(${buyerState.productCreatedAt} AS INTEGER)` })
        .from(buyerState)
        .where(and(
            eq(buyerState.isPublic, isPublic),
            gte(buyerState.productCreatedAt, sql`${from}`),
            before === null ? undefined : lt(buyerState.productCreatedAt, sql`${before}`),
        ))
        .orderBy(asc(buyerState.productCreatedAt))
        .limit(limit)
        .all();
    const [hidden, listed] = await Promise.all([range(false), range(true)]);
    return mergeAscending(hidden.map((row) => Number(row.createdAt)), listed.map((row) => Number(row.createdAt))).slice(0, limit);
}

/**
 * Product rows (any state) created at or after `from` (`atOnly`: in that very
 * second): one statement, one index range per `is_public` value.
 */
async function countCreatedSince(db: Database, from: number, atOnly = false): Promise<number> {
    const range = (isPublic: 0 | 1) => sql`(SELECT count(*) FROM product_buyer_state WHERE is_public = ${isPublic} AND product_created_at ${sql.raw(atOnly ? "=" : ">=")} ${from})`;
    const [row] = await db.all<unknown>(sql`SELECT ${range(0)} + ${range(1)} AS n`);
    // D1 returns a row as an array of values, the other providers as an object.
    return Number(Array.isArray(row) ? row[0] : (row as { n?: unknown } | undefined)?.n) || 0;
}

async function databaseNow(db: Database): Promise<number> {
    const [row] = await db.all<unknown>(sql`SELECT unixepoch() AS now`);
    // D1 returns a row as an array of values, the other providers as an object.
    return Number(Array.isArray(row) ? row[0] : (row as { now?: unknown } | undefined)?.now);
}

/**
 * The due-work probes (`readDueDrains`): a store with products whose files
 * were checked for another file size (a plan change, or never), every file is
 * being checked, or product rows were created since the newest file was last
 * counted. Idle, they read one key each and seek the newest index once.
 */
export function feedFilesDueProbes(perFile: number): SQL[] {
    return [
        sql`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM system_kv WHERE key = ${FEED_FILES_PLAN_KEY} AND value = ${String(perFile)})
            AND (EXISTS (SELECT 1 FROM product_buyer_state WHERE is_public = 0 AND product_created_at >= 0)
              OR EXISTS (SELECT 1 FROM product_buyer_state WHERE is_public = 1 AND product_created_at >= 0))`,
        sql`SELECT 1 FROM system_kv WHERE key = ${FEED_FILES_VERIFY_KEY}`,
        // A product row created after the counted second, or more in that second than when it was counted.
        sql`SELECT 1 FROM product_buyer_state WHERE is_public = 0 AND product_created_at > (
            SELECT CAST(value AS INTEGER) FROM system_kv WHERE key = ${FEED_FILES_CHECKED_AT_KEY})`,
        sql`SELECT 1 FROM product_buyer_state WHERE is_public = 1 AND product_created_at > (
            SELECT CAST(value AS INTEGER) FROM system_kv WHERE key = ${FEED_FILES_CHECKED_AT_KEY})`,
        sql`SELECT 1 WHERE (
            SELECT count(*) FROM product_buyer_state WHERE is_public = 0 AND product_created_at = (
                SELECT CAST(value AS INTEGER) FROM system_kv WHERE key = ${FEED_FILES_CHECKED_AT_KEY})
        ) + (
            SELECT count(*) FROM product_buyer_state WHERE is_public = 1 AND product_created_at = (
                SELECT CAST(value AS INTEGER) FROM system_kv WHERE key = ${FEED_FILES_CHECKED_AT_KEY})
        ) > (SELECT CAST(value AS INTEGER) FROM system_kv WHERE key = ${FEED_FILES_CHECKED_COUNT_KEY})`,
    ];
}

export interface FeedFilesMaintenance {
    /** Files whose size was read. */
    checked: number;
    /** Starts inserted. */
    added: number;
    /** Every file has been checked for the current size. */
    settled: boolean;
}

/**
 * One maintenance run: at most `maxChecks` file reads (two bounded index
 * statements each). While files were last checked for another size it walks
 * every file from the first; otherwise it counts the product rows created
 * since the newest file was last counted and reads that file only when it may
 * hold more than a file lists. A file holding more gets a start inside it at
 * the creation second of its first row past the limit (the guarded upsert);
 * the new file is checked next, so a file is split as often as it needs.
 */
export async function maintainFeedFiles(db: Database, perFile: number, maxChecks: number): Promise<FeedFilesMaintenance> {
    const kv = await getSystemKvMany(db, [
        FEED_FILES_PLAN_KEY, FEED_FILES_VERIFY_KEY, FEED_FILES_NEWEST_KEY, FEED_FILES_CHECKED_AT_KEY, FEED_FILES_CHECKED_COUNT_KEY,
    ]);
    /** Remember the newest file's rows as of `now`, and how many rows the second `now` already holds. */
    const counted = async (rows: number) => {
        await putSystemKv(db, FEED_FILES_NEWEST_KEY, String(rows));
        await putSystemKv(db, FEED_FILES_CHECKED_AT_KEY, String(now));
        await putSystemKv(db, FEED_FILES_CHECKED_COUNT_KEY, String(await countCreatedSince(db, now, true)));
    };
    const now = await databaseNow(db);
    let { state, stored } = await readState(db);
    const result: FeedFilesMaintenance = { checked: 0, added: 0, settled: false };

    /**
     * Read file `index` and split it when it holds too many rows. Returns the
     * rows it keeps, or null when another run changed the files meanwhile
     * (the caller reads it again from what that run wrote).
     */
    const check = async (index: number): Promise<number | null> => {
        const from = state.starts[index]!;
        const to = state.starts[index + 1] ?? null;
        result.checked += 1;
        const seconds = await readCreatedSeconds(db, from, to, perFile + 1);
        const split = feedFileSplit(seconds, perFile);
        const overfull = split?.whole === true;
        const next: FeedFilesState = {
            ...state,
            overfull: overfull ? [...new Set([...state.overfull, from])] : state.overfull.filter((start) => start !== from),
        };
        // A whole second at the end of the file: nothing after it to split off.
        if (split && (to === null || split.at < to)) next.starts = withFeedFileStart(state.starts, split.at);
        if (serializeFeedFilesState(next) !== serializeFeedFilesState(state)) {
            if (!(await writeState(db, stored, next))) {
                ({ state, stored } = await readState(db)); // another run changed it: continue from what it wrote
                return null;
            }
            if (next.starts.length > state.starts.length) result.added += 1;
            state = next;
            stored = serializeFeedFilesState(next);
        }
        // Split off: the file keeps its rows before the new start, at most a file's size.
        return split && !split.whole ? seconds.filter((second) => second < split.at).length : seconds.length;
    };

    const checkingFor = kv.get(FEED_FILES_PLAN_KEY) !== String(perFile) || kv.has(FEED_FILES_VERIFY_KEY);
    if (checkingFor) {
        // Every file, from the first (a new size or the first run), a bounded number per run.
        let index = kv.get(FEED_FILES_PLAN_KEY) === String(perFile) ? Number(kv.get(FEED_FILES_VERIFY_KEY) ?? 0) || 0 : 0;
        if (!state.checking && (await writeState(db, stored, { ...state, checking: true }))) {
            state = { ...state, checking: true };
            stored = serializeFeedFilesState(state);
        }
        await putSystemKv(db, FEED_FILES_PLAN_KEY, String(perFile));
        let newestRows: number | null = null;
        while (result.checked < maxChecks && index < state.starts.length) {
            const rows = await check(index);
            // The next file (the tail just split off, if any) is checked next.
            if (rows !== null) {
                if (index === state.starts.length - 1) newestRows = rows;
                index += 1;
            }
        }
        if (index < state.starts.length) {
            await putSystemKv(db, FEED_FILES_VERIFY_KEY, String(index));
            return result;
        }
        await deleteSystemKv(db, FEED_FILES_VERIFY_KEY);
        if (await writeState(db, stored, { ...state, checking: false })) state = { ...state, checking: false };
        await counted(newestRows ?? perFile + 1);
        result.settled = true;
        return result;
    }

    // The newest file only: rows created since it was last counted (rows already in that second were counted then).
    const checkedAt = Number(kv.get(FEED_FILES_CHECKED_AT_KEY) ?? 0) || 0;
    const checkedCount = Number(kv.get(FEED_FILES_CHECKED_COUNT_KEY) ?? 0) || 0;
    let rows = Number(kv.get(FEED_FILES_NEWEST_KEY) ?? perFile + 1)
        + Math.max(0, await countCreatedSince(db, checkedAt) - checkedCount);
    while (rows > perFile && result.checked < maxChecks) {
        const files = state.starts.length;
        const kept = await check(files - 1);
        if (kept === null) continue; // another run changed the files: read the newest again
        // Split: the tail is now the newest file, unread, and may hold too many again.
        rows = state.starts.length > files ? perFile + 1 : kept;
    }
    const settled = rows <= perFile;
    await counted(rows);
    // Out of reads before the newest file settled: the next run continues from it.
    if (!settled) await putSystemKv(db, FEED_FILES_VERIFY_KEY, String(state.starts.length - 1));
    result.settled = settled;
    return result;
}
