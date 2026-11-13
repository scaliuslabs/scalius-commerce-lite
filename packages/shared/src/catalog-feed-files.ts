/**
 * Catalogue feed files (`/api/product-feed.xml`, `/api/facebook-feed.xml`).
 *
 * Google Merchant Center's scheduled fetch and Meta's scheduled feed read one
 * file per registered URL and follow no continuation. One request can only
 * produce the plan's `feedProductsPerRequest` products, so a larger catalogue
 * is published as several files, each a merchant registers once.
 *
 * A file is a range of product positions between two stored starts. A
 * position is a product's (creation second, id): the order the buyer state's
 * newest index keeps. A start is a second (`1700000004`: from the beginning
 * of that second) or a second and an id (`1700000004.prod_x`: from that
 * product on, within that second). The bare URL is the file starting at 0,
 * `?from=<start>` a later one, and each file ends where the next stored start
 * begins (the last file is open). Starts are only ever added, never moved or
 * removed, so a link keeps its start for good and the ranges always cover
 * every product. The scheduled maintenance adds them: whenever a file holds
 * more product rows than a file lists it inserts a start at its first row
 * past the limit, so the file keeps what it lists and the new link takes the
 * rest (or at the latest earlier row whose id a URL can spell). A start inside a second is only taken once that second has passed,
 * so no product created later can land before it.
 */

/** The query parameter that names a file after the first. */
export const FEED_FILE_FROM_PARAM = "from";

/** The largest second a start may name: unix seconds well past any creation time. */
export const FEED_FILE_MAX_SECOND = 99_999_999_999;

/** A start as a URL spells it: `<seconds>` or `<seconds>.<product id>`. */
export const FEED_FILE_START_PATTERN = /^(?:0|[1-9]\d{0,10})(?:\.[A-Za-z0-9_-]{1,64})?$/;

/** A product's place in the files: its creation second, then its id. */
export interface FeedPosition {
  second: number;
  id: string;
}

export interface FeedFileStart {
  second: number;
  /** Null: from the beginning of the second. */
  id: string | null;
}

/** The start a URL or the store spells, or null for anything else. */
export function parseFeedFileStart(value: string): FeedFileStart | null {
  if (!FEED_FILE_START_PATTERN.test(value)) return null;
  const dot = value.indexOf(".");
  const second = Number(dot < 0 ? value : value.slice(0, dot));
  if (!Number.isSafeInteger(second) || second > FEED_FILE_MAX_SECOND) return null;
  return { second, id: dot < 0 ? null : value.slice(dot + 1) };
}

export function encodeFeedFileStart(start: FeedFileStart): string {
  return start.id === null ? String(start.second) : `${start.second}.${start.id}`;
}

/** Ids compare as SQLite's and PostgreSQL's `C` collation compare them: by code unit. */
function compareIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Negative when `left` comes first: by second, then a whole second before any id in it, then by id. */
export function compareFeedFileStarts(left: FeedFileStart, right: FeedFileStart): number {
  if (left.second !== right.second) return left.second - right.second;
  if (left.id === right.id) return 0;
  if (left.id === null) return -1;
  if (right.id === null) return 1;
  return compareIds(left.id, right.id);
}

/** Whether a product at `position` is at or after `start`. */
export function feedPositionFrom(position: FeedPosition, start: FeedFileStart): boolean {
  if (position.second !== start.second) return position.second > start.second;
  return start.id === null || compareIds(position.id, start.id) >= 0;
}

/** Ascending positions: by second, then by id. */
export function compareFeedPositions(left: FeedPosition, right: FeedPosition): number {
  return left.second !== right.second ? left.second - right.second : compareIds(left.id, right.id);
}

/** What the store keeps (one settings row): the starts and what a feed request must say about them. */
export interface FeedFilesState {
  /** Ascending encoded starts, beginning with "0". */
  starts: string[];
  /**
   * Starts of files known to hold more product rows than a file lists; empty
   * once every file can be split (a start inside a second waits for that
   * second to pass).
   */
  overfull: string[];
  /** The maintenance is still checking every file (after a plan change or on its first run). */
  checking: boolean;
}

function ascendingFromZero(value: unknown): value is string[] {
  if (!Array.isArray(value) || value[0] !== "0") return false;
  let previous: FeedFileStart | null = null;
  for (const text of value) {
    const start = typeof text === "string" ? parseFeedFileStart(text) : null;
    if (!start || encodeFeedFileStart(start) !== text) return false;
    if (previous && compareFeedFileStarts(previous, start) >= 0) return false;
    previous = start;
  }
  return true;
}

/** The stored state, or the one file of a new store for anything else (no row yet, a damaged value). */
export function parseFeedFilesState(value: string | null | undefined): FeedFilesState {
  const empty = (): FeedFilesState => ({ starts: ["0"], overfull: [], checking: false });
  if (!value) return empty();
  try {
    const parsed = JSON.parse(value) as Partial<FeedFilesState> | null;
    if (!parsed || !ascendingFromZero(parsed.starts)) return empty();
    const starts = parsed.starts;
    const overfull = Array.isArray(parsed.overfull)
      ? parsed.overfull.filter((start): start is string => starts.includes(start as string))
      : [];
    return { starts, overfull, checking: parsed.checking === true };
  } catch {
    return empty();
  }
}

export function serializeFeedFilesState(state: FeedFilesState): string {
  return JSON.stringify({ starts: state.starts, overfull: state.overfull, checking: state.checking });
}

export interface FeedFileRange {
  /** The file's encoded start ("0" for the first file). */
  from: string;
  /** The next file's encoded start (exclusive); null for the last, open file. */
  to: string | null;
}

/** The file a stored start begins, or null when `from` is no file's start (a URL the dashboard never listed). */
export function feedFileRange(starts: readonly string[], from: string): FeedFileRange | null {
  const index = starts.indexOf(from);
  if (index < 0) return null;
  return { from, to: starts[index + 1] ?? null };
}

export type FeedFileSplit =
  /** Insert this start: the file keeps the rows before it, at most a file's size. */
  | { at: string }
  /** The file's first row past the limit shares the current second with the row before it: split once that second has passed. */
  | { wait: true }
  /**
   * Every row a split inside the second could start at has an id no URL can
   * spell (outside `[A-Za-z0-9_-]{1,64}`, an imported id): the file stays
   * whole and is flagged overfull, and the maintenance goes on.
   */
  | { unsplittable: true };

/**
 * Where a file must split, given its first `perFile + 1` rows ascending by
 * position and the database's current second. A whole second when the row
 * past the limit begins a later second than the file's first row (the file
 * keeps fewer rows, and a URL needs no id); otherwise the row itself, once
 * its second has passed. Null while the file holds no more than `perFile`.
 */
export function feedFileSplit(rows: readonly FeedPosition[], perFile: number, now: number): FeedFileSplit | null {
  if (!Number.isSafeInteger(perFile) || perFile < 1) throw new RangeError("perFile must be a positive integer");
  if (rows.length <= perFile) return null;
  const past = rows[perFile]!;
  if (past.second > rows[0]!.second) return { at: String(past.second) };
  if (past.second >= now) return { wait: true };
  // The row past the limit, or else the latest row before it (the file keeps fewer), whose id a link
  // can spell; never the file's first row, so the file keeps at least one.
  for (let index = perFile; index > 0; index -= 1) {
    const at = encodeFeedFileStart({ second: past.second, id: rows[index]!.id });
    if (parseFeedFileStart(at)) return { at };
  }
  return { unsplittable: true };
}

/** The starts with one more inside them, ascending; every existing start kept. */
export function withFeedFileStart(starts: readonly string[], start: string): string[] {
  if (starts.includes(start)) return [...starts];
  const parsed = parseFeedFileStart(start);
  if (!parsed) throw new RangeError(`not a feed file start: ${start}`);
  return [...starts, start].sort((left, right) => compareFeedFileStarts(parseFeedFileStart(left)!, parseFeedFileStart(right)!));
}

/** Two ascending position lists as one (the two `is_public` index ranges of the buyer state). */
export function mergeAscending(left: readonly FeedPosition[], right: readonly FeedPosition[]): FeedPosition[] {
  const merged: FeedPosition[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    if (r >= right.length || (l < left.length && compareFeedPositions(left[l]!, right[r]!) <= 0)) merged.push(left[l++]!);
    else merged.push(right[r++]!);
  }
  return merged;
}

/**
 * The `from` a feed URL spells: absent is the first file ("0"); otherwise a
 * canonical start. Null for anything else.
 */
export function parseFeedFileFrom(value: string | null): string | null {
  if (value === null) return "0";
  const start = parseFeedFileStart(value);
  return start && encodeFeedFileStart(start) === value ? value : null;
}

/** The path and query of a file: the first file is the bare feed URL. */
export function feedFilePath(feedPath: string, from: string): string {
  return from === "0" ? feedPath : `${feedPath}?${FEED_FILE_FROM_PARAM}=${encodeURIComponent(from)}`;
}
