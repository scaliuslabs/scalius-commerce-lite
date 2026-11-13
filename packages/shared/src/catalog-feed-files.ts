/**
 * Catalogue feed files (`/api/product-feed.xml`, `/api/facebook-feed.xml`).
 *
 * Google Merchant Center's scheduled fetch and Meta's scheduled feed read one
 * file per registered URL and follow no continuation. One request can only
 * produce the plan's `feedProductsPerRequest` products, so a larger catalogue
 * is published as several files, each a merchant registers once.
 *
 * A file is a range of creation time between two stored starts: the bare URL
 * is the file starting at 0, `?from=<unix seconds>` a later one, and each file
 * ends where the next stored start begins (the last file is open). Starts are
 * only ever added, never moved or removed, so a link keeps its start for good
 * and the ranges always cover every product. The scheduled maintenance adds
 * them: whenever a file holds more product rows than a file lists (the newest
 * file filling up, a move to a plan with smaller files, the first run on a
 * large store) it inserts a start inside that file at the creation second of
 * its first row past the limit, so the file keeps what it can list and the
 * new link takes the rest. A boundary is a stored creation time, never a
 * clock reading, and every later product is created at or after it.
 */

/** The query parameter that names a file after the first. */
export const FEED_FILE_FROM_PARAM = "from";

/** The largest `from` a URL may spell: unix seconds well past any creation time. */
export const FEED_FILE_MAX_FROM = 99_999_999_999;

/** What the store keeps (one settings row): the starts and what a feed request must say about them. */
export interface FeedFilesState {
  /** Ascending whole seconds, beginning with 0. */
  starts: number[];
  /**
   * Starts of files known to hold more product rows than a file lists that
   * no start can split (more rows created in one second than a file lists).
   */
  overfull: number[];
  /** The maintenance is still checking every file (after a plan change or on its first run). */
  checking: boolean;
}

const EMPTY_STATE: FeedFilesState = Object.freeze({ starts: [0], overfull: [], checking: false }) as FeedFilesState;

function ascendingFromZero(value: unknown): value is number[] {
  if (!Array.isArray(value) || value[0] !== 0) return false;
  return value.every((start, index) => Number.isSafeInteger(start) && (index === 0 || start > value[index - 1]));
}

/** The stored state, or the one file of a new store for anything else (no row yet, a damaged value). */
export function parseFeedFilesState(value: string | null | undefined): FeedFilesState {
  if (!value) return { ...EMPTY_STATE, starts: [0], overfull: [] };
  try {
    const parsed = JSON.parse(value) as Partial<FeedFilesState> | null;
    if (!parsed || !ascendingFromZero(parsed.starts)) return { ...EMPTY_STATE, starts: [0], overfull: [] };
    const starts = parsed.starts;
    const overfull = Array.isArray(parsed.overfull)
      ? parsed.overfull.filter((start): start is number => starts.includes(start as number))
      : [];
    return { starts, overfull, checking: parsed.checking === true };
  } catch {
    return { ...EMPTY_STATE, starts: [0], overfull: [] };
  }
}

export function serializeFeedFilesState(state: FeedFilesState): string {
  return JSON.stringify({ starts: state.starts, overfull: state.overfull, checking: state.checking });
}

export interface FeedFileRange {
  /** The first second of the file (0 for the first file). */
  from: number;
  /** The next file's start (exclusive); null for the last, open file. */
  to: number | null;
}

/** The file a stored start begins, or null when `from` is no file's start (a URL the dashboard never listed). */
export function feedFileRange(starts: readonly number[], from: number): FeedFileRange | null {
  const index = starts.indexOf(from);
  if (index < 0) return null;
  return { from, to: starts[index + 1] ?? null };
}

/**
 * Where a file must split, given the creation seconds of its first
 * `perFile + 1` rows ascending: the second of its `perFile + 1`-th row, so it
 * keeps at most `perFile` rows; `whole` when all of those rows share one
 * second, which no start can split: the file then keeps that whole second
 * (more rows than it lists) and the split follows it. Null while the file
 * holds no more than `perFile` rows.
 */
export function feedFileSplit(createdAts: readonly number[], perFile: number): { at: number; whole: boolean } | null {
  if (!Number.isSafeInteger(perFile) || perFile < 1) throw new RangeError("perFile must be a positive integer");
  if (createdAts.length <= perFile) return null;
  const boundary = createdAts[perFile]!;
  return boundary > createdAts[0]! ? { at: boundary, whole: false } : { at: boundary + 1, whole: true };
}

/** The starts with one more inside them, ascending; every existing start kept. */
export function withFeedFileStart(starts: readonly number[], start: number): number[] {
  if (starts.includes(start)) return [...starts];
  return [...starts, start].sort((left, right) => left - right);
}

/** Two ascending lists as one ascending list (the two `is_public` index ranges of the buyer state). */
export function mergeAscending(left: readonly number[], right: readonly number[]): number[] {
  const merged: number[] = [];
  let l = 0;
  let r = 0;
  while (l < left.length || r < right.length) {
    if (r >= right.length || (l < left.length && left[l]! <= right[r]!)) merged.push(left[l++]!);
    else merged.push(right[r++]!);
  }
  return merged;
}

/**
 * The `from` a feed URL spells: absent is the first file (0); otherwise a
 * canonical non-negative integer of unix seconds. Null for anything else.
 */
export function parseFeedFileFrom(value: string | null): number | null {
  if (value === null) return 0;
  if (!/^(?:0|[1-9]\d{0,10})$/.test(value)) return null;
  const from = Number(value);
  return from <= FEED_FILE_MAX_FROM ? from : null;
}

/** The path and query of a file: the first file is the bare feed URL. */
export function feedFilePath(feedPath: string, from: number): string {
  return from === 0 ? feedPath : `${feedPath}?${FEED_FILE_FROM_PARAM}=${from}`;
}
