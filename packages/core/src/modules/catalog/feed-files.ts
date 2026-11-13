// Catalogue feed files (`@scalius/shared/catalog-feed-files`): the stored
// starts (one settings row, the public reads' dependency), what a file
// request reads from them, the links the merchant has confirmed registered,
// and the scheduled maintenance that adds a start inside any file holding
// more product rows than a file lists.
//
// A file's rows are read from the buyer state's newest index (one row per
// product, `is_public` first): one ordered range per `is_public` value, at most
// a file plus one row each, so no read here walks the catalogue. The
// maintenance's bookkeeping lives in `system_kv` (private, no public read
// depends on it).
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Database } from "@scalius/database/client";
import { settings, systemKv } from "@scalius/database/schema";
import {
    feedFileRange,
    feedFileSplit,
    mergeAscending,
    parseFeedFileStart,
    parseFeedFilesState,
    serializeFeedFilesState,
    withFeedFileStart,
    type FeedFileRange,
    type FeedFileStart,
    type FeedFilesState,
    type FeedPosition,
} from "@scalius/shared/catalog-feed-files";
import { ConflictError, ValidationError } from "@scalius/core/errors";
import { getSystemKvMany, putSystemKv } from "../../utils/system-kv";
import { buyerState } from "./buyer-state";
import { deps } from "./declare-deps";

/** The settings row that holds the file starts (`set:catalog_feed:file_starts`). */
export const FEED_FILES_SETTINGS_CATEGORY = "catalog_feed";
export const FEED_FILES_SETTINGS_KEY = "file_starts";

/**
 * `system_kv`: the per-file size every file is being (or was) checked
 * against and how far that check got, one record: `<perFile>:<next file
 * index>` while checking, `<perFile>:done` once the last file was checked.
 */
export const FEED_FILES_CHECK_KEY = "catalog:feed-files:check";
/** `system_kv`: product rows in the newest file (an upper bound between exact counts). */
export const FEED_FILES_NEWEST_KEY = "catalog:feed-files:newest";
/** `system_kv`: the database second the newest file was last counted at. */
export const FEED_FILES_CHECKED_AT_KEY = "catalog:feed-files:checked-at";
/** `system_kv`: product rows created in that second when it was counted. */
export const FEED_FILES_CHECKED_COUNT_KEY = "catalog:feed-files:checked-count";
/** `system_kv`: the starts whose links a person confirmed they added to Google and Meta (a JSON list). */
export const FEED_FILES_REGISTERED_KEY = "catalog:feed-files:registered";

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
    /** 1 for the bare feed URL, then in position order. */
    number: number;
    last: boolean;
    /** Holds more product rows than a file lists until a split its current second waits for. */
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
export async function getFeedFile(db: Database, from: string): Promise<FeedFileRead | null> {
    const { state } = await readState(db);
    // Declared before the answer, so a "not found" cached for `from` ends when a start is added.
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
    files: Array<FeedFile & { registered: boolean }>;
    checking: boolean;
    /** Links no person has confirmed adding to Google and Meta (the bare first link counts as added). */
    unregistered: number;
}

function parseRegistered(value: string | undefined): Set<string> {
    try {
        const parsed: unknown = JSON.parse(value ?? "[]");
        return new Set(["0", ...(Array.isArray(parsed) ? parsed.filter((start): start is string => typeof start === "string") : [])]);
    } catch {
        return new Set(["0"]);
    }
}

/** Every file for the dashboard: two statements, no product row read, no write. */
export async function listFeedFiles(db: Database): Promise<FeedFilesOverview> {
    const [{ state }, kv] = await Promise.all([readState(db), getSystemKvMany(db, [FEED_FILES_REGISTERED_KEY])]);
    const registered = parseRegistered(kv.get(FEED_FILES_REGISTERED_KEY));
    const files = filesOf(state).map((file) => ({ ...file, registered: registered.has(file.from) }));
    return { files, checking: state.checking, unregistered: files.filter((file) => !file.registered).length };
}

/** Two confirmations at once both land: each retry merges into what the other wrote. */
const REGISTER_ATTEMPTS = 8;

/**
 * A person confirmed adding these files' links to Google and Meta. Only
 * listed starts are kept; the record only grows, so a repeat is harmless. The
 * record is replaced only while it still holds what this call read (the
 * guarded upsert the file starts use), so a confirmation made at the same
 * moment is never dropped.
 */
export async function markFeedFilesRegistered(db: Database, starts: readonly string[]): Promise<FeedFilesOverview> {
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt += 1) {
        const [{ state }, kv] = await Promise.all([readState(db), getSystemKvMany(db, [FEED_FILES_REGISTERED_KEY])]);
        const unknown = starts.filter((start) => !state.starts.includes(start));
        if (unknown.length > 0) throw new ValidationError(`No feed file starts at ${unknown.join(", ")}.`);
        const stored = kv.get(FEED_FILES_REGISTERED_KEY) ?? null;
        const registered = parseRegistered(stored ?? undefined);
        for (const start of starts) registered.add(start);
        const value = JSON.stringify([...registered].filter((start) => state.starts.includes(start)));
        if (value === stored) return listFeedFiles(db);
        const written = await db.insert(systemKv)
            .values({ key: FEED_FILES_REGISTERED_KEY, value, expiresAt: null })
            .onConflictDoUpdate({
                target: systemKv.key,
                set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
                setWhere: sql`${systemKv.value} = ${stored ?? ""}`,
            })
            .returning({ key: systemKv.key });
        if (written.length > 0) return listFeedFiles(db);
    }
    throw new ConflictError("The feed links changed while they were being confirmed; try again.");
}

/** SQL for "the buyer-state row is at or after `start`" (index range first, then the id within its second). */
function fromStart(start: FeedFileStart): SQL {
    if (start.id === null) return sql`${buyerState.productCreatedAt} >= ${start.second}`;
    return sql`${buyerState.productCreatedAt} >= ${start.second} AND (${buyerState.productCreatedAt} > ${start.second} OR ${buyerState.productId} >= ${start.id})`;
}

function beforeStart(start: FeedFileStart): SQL {
    if (start.id === null) return sql`${buyerState.productCreatedAt} < ${start.second}`;
    return sql`${buyerState.productCreatedAt} <= ${start.second} AND (${buyerState.productCreatedAt} < ${start.second} OR ${buyerState.productId} < ${start.id})`;
}

/** The first `limit` product rows (any state) in [from, before), ascending by position. */
async function readRows(db: Database, from: FeedFileStart, before: FeedFileStart | null, limit: number): Promise<FeedPosition[]> {
    const range = (isPublic: boolean) => db
        .select({ second: sql<number>`CAST(${buyerState.productCreatedAt} AS INTEGER)`, id: buyerState.productId })
        .from(buyerState)
        .where(and(eq(buyerState.isPublic, isPublic), fromStart(from), before === null ? undefined : beforeStart(before)))
        .orderBy(buyerState.productCreatedAt, buyerState.productId)
        .limit(limit)
        .all();
    const [hidden, listed] = await Promise.all([range(false), range(true)]);
    const rows = (list: Array<{ second: number; id: string }>) => list.map((row) => ({ second: Number(row.second), id: row.id }));
    return mergeAscending(rows(hidden), rows(listed)).slice(0, limit);
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
    return Number(Array.isArray(row) ? row[0] : (row as { now?: unknown } | undefined)?.now);
}

/**
 * The due-work probes (`readDueDrains`): a store with products whose files
 * are not all checked for this file size (a plan change, a first run, or a
 * check under way), or product rows created since the newest file was last
 * counted. Idle, they read one key and seek the newest index a few times.
 */
export function feedFilesDueProbes(perFile: number): SQL[] {
    return [
        sql`SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM system_kv WHERE key = ${FEED_FILES_CHECK_KEY} AND value = ${`${perFile}:done`})
            AND (EXISTS (SELECT 1 FROM product_buyer_state WHERE is_public = 0 AND product_created_at >= 0)
              OR EXISTS (SELECT 1 FROM product_buyer_state WHERE is_public = 1 AND product_created_at >= 0))`,
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
    /** Files whose rows were read. */
    checked: number;
    /** Starts inserted. */
    added: number;
    /** Every file is within its size for the current plan (a split may still wait for its second to pass). */
    settled: boolean;
}

/** The check record: `{ perFile, next }` while checking, `{ perFile, next: null }` once done. */
function parseCheck(value: string | undefined): { perFile: number; next: number | null } | null {
    const match = /^(\d+):(done|\d+)$/.exec(value ?? "");
    if (!match) return null;
    return { perFile: Number(match[1]), next: match[2] === "done" ? null : Number(match[2]) };
}

/**
 * One maintenance run: at most `maxChecks` file reads (two bounded index
 * statements each). While the files are not all checked for this size it
 * walks them from where the check record says, recording each checked file
 * before the next, so a run that stops anywhere (an error, the invocation's
 * query cap) loses at most the file it was reading. Otherwise it counts the
 * product rows created since the newest file was last counted and reads that
 * file only when it may hold more than a file lists. A file holding more
 * gets a start at its first row past the limit (the guarded upsert).
 */
export async function maintainFeedFiles(db: Database, perFile: number, maxChecks: number): Promise<FeedFilesMaintenance> {
    const kv = await getSystemKvMany(db, [FEED_FILES_CHECK_KEY, FEED_FILES_NEWEST_KEY, FEED_FILES_CHECKED_AT_KEY, FEED_FILES_CHECKED_COUNT_KEY]);
    const now = await databaseNow(db);
    let { state, stored } = await readState(db);
    const result: FeedFilesMaintenance = { checked: 0, added: 0, settled: false };

    /** Write the state if it changed; false when another run changed it first (then it is read again). */
    const save = async (next: FeedFilesState): Promise<boolean> => {
        if (serializeFeedFilesState(next) === serializeFeedFilesState(state)) return true;
        if (!(await writeState(db, stored, next))) {
            ({ state, stored } = await readState(db));
            return false;
        }
        if (next.starts.length > state.starts.length) result.added += 1;
        state = next;
        stored = serializeFeedFilesState(next);
        return true;
    };

    /**
     * Read file `index` and split it when it holds too many rows. Returns the
     * rows it keeps, or null when another run changed the files meanwhile.
     */
    const check = async (index: number): Promise<number | null> => {
        const from = state.starts[index]!;
        const to = state.starts[index + 1] ?? null;
        result.checked += 1;
        const rows = await readRows(db, parseFeedFileStart(from)!, to === null ? null : parseFeedFileStart(to)!, perFile + 1);
        const split = feedFileSplit(rows, perFile, now);
        // Waiting for its second to pass, or unsplittable: flagged overfull, and the run goes on.
        const waiting = split !== null && !("at" in split);
        const next: FeedFilesState = {
            ...state,
            starts: split && "at" in split ? withFeedFileStart(state.starts, split.at) : state.starts,
            overfull: waiting ? [...new Set([...state.overfull, from])] : state.overfull.filter((start) => start !== from),
        };
        if (!(await save(next))) return null;
        if (split && "at" in split) {
            const at = parseFeedFileStart(split.at)!;
            return rows.filter((row) => row.second < at.second || (row.second === at.second && at.id !== null && row.id < at.id)).length;
        }
        return rows.length;
    };

    const record = parseCheck(kv.get(FEED_FILES_CHECK_KEY));
    if (!record || record.perFile !== perFile || record.next !== null) {
        // Every file from the recorded position (from the first for a new size).
        let index = record && record.perFile === perFile && record.next !== null ? record.next : 0;
        await putSystemKv(db, FEED_FILES_CHECK_KEY, `${perFile}:${index}`);
        let newestRows: number | null = null;
        while (result.checked < maxChecks && index < state.starts.length) {
            const rows = await check(index);
            if (rows === null) continue; // read the same file again from what the other run wrote
            if (index === state.starts.length - 1) newestRows = rows;
            index += 1;
            // This file is done: the record moves past it before the next is read.
            await putSystemKv(db, FEED_FILES_CHECK_KEY, `${perFile}:${index < state.starts.length ? index : "done"}`);
        }
        if (index < state.starts.length) {
            // Files remain: feed responses say so until they are checked. A store whose
            // files all fit in one run writes no state (and adds no settings row).
            if (!state.checking) await save({ ...state, checking: true });
            return result;
        }
        if (state.checking) await save({ ...state, checking: false });
        await counted(newestRows ?? perFile + 1);
        result.settled = state.overfull.length === 0;
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
        if (kept === null) continue;
        // A split: the tail is now the newest file, unread, and may hold too many again.
        if (state.starts.length > files) rows = perFile + 1;
        else {
            rows = kept;
            break; // read without a split: within its size, or waiting for its second to pass
        }
    }
    await counted(rows);
    const settled = rows <= perFile;
    // Out of reads, or waiting for a second to pass: the next run checks from the newest file.
    if (!settled) await putSystemKv(db, FEED_FILES_CHECK_KEY, `${perFile}:${state.starts.length - 1}`);
    result.settled = settled;
    return result;

    async function counted(newest: number): Promise<void> {
        await putSystemKv(db, FEED_FILES_NEWEST_KEY, String(newest));
        await putSystemKv(db, FEED_FILES_CHECKED_AT_KEY, String(now));
        await putSystemKv(db, FEED_FILES_CHECKED_COUNT_KEY, String(await countCreatedSince(db, now, true)));
    }
}
