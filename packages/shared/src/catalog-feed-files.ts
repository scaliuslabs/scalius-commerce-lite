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
 * ends where the next stored start begins (the last file is open). The starts
 * are an append-only list (one settings row), so a file's range never changes
 * once a merchant has seen its link, whatever is created, trashed, restored or
 * permanently deleted later. A new start is appended only when the merchant
 * adds the next file, at a second after every product row that exists then,
 * so no product moves between files; only a last file holding more product
 * rows than a file can list gives its newest rows to the new file, because
 * the feed could not list them anyway.
 */

/** The query parameter that names a file after the first. */
export const FEED_FILE_FROM_PARAM = "from";

/** The largest `from` a URL may spell: unix seconds well past any creation time. */
export const FEED_FILE_MAX_FROM = 99_999_999_999;

/** The share of a file's rows at which the dashboard offers the next file. */
export const FEED_FILE_NEARLY_FULL_SHARE = 0.8;

export interface FeedFileRange {
  /** The first second of the file (0 for the first file). */
  from: number;
  /** The next file's start (exclusive); null for the last, open file. */
  to: number | null;
}

/**
 * The stored starts, as written: ascending whole seconds beginning with 0.
 * Anything else (no row yet, a damaged value) is the one file of a new store.
 */
export function parseFeedFileStarts(value: string | null | undefined): number[] {
  if (!value) return [0];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed[0] !== 0) return [0];
    for (let index = 0; index < parsed.length; index += 1) {
      const start = parsed[index];
      if (!Number.isSafeInteger(start) || (index > 0 && (start as number) <= (parsed[index - 1] as number))) return [0];
    }
    return parsed as number[];
  } catch {
    return [0];
  }
}

/** The file a stored start begins, or null when `from` is no file's start (a URL the dashboard never listed). */
export function feedFileRange(starts: readonly number[], from: number): FeedFileRange | null {
  const index = starts.indexOf(from);
  if (index < 0) return null;
  return { from, to: starts[index + 1] ?? null };
}

/**
 * Where the last file must end when it holds more product rows than a file
 * lists, given the creation seconds of its first `perFile + 1` rows ascending:
 * the second of its `perFile + 1`-th row, so it keeps `perFile` rows (a second
 * fuller than a file takes the whole second). Null while it holds no more.
 */
export function feedFileEnd(createdAts: readonly number[], perFile: number): number | null {
  if (!Number.isSafeInteger(perFile) || perFile < 1) throw new RangeError("perFile must be a positive integer");
  if (createdAts.length <= perFile) return null;
  const first = createdAts[0]!;
  const boundary = createdAts[perFile]!;
  return boundary > first ? boundary : boundary + 1;
}

/**
 * The start the next file gets when the merchant adds it. `lastFileSeconds`
 * are the creation seconds of the last file's first `perFile + 1` rows,
 * ascending; `now` is the current unix second. Within a file's size the new
 * start is after every existing row (and after now), so no product moves;
 * past it the last file keeps `perFile` rows and the rest, which its feed
 * could not list, start the new file.
 */
export function nextFeedFileStart(
  starts: readonly number[],
  lastFileSeconds: readonly number[],
  perFile: number,
  now: number,
): number {
  const lastStart = starts.at(-1) ?? 0;
  const end = feedFileEnd(lastFileSeconds, perFile);
  if (end !== null) return Math.max(end, lastStart + 1);
  return Math.max(now + 1, (lastFileSeconds.at(-1) ?? 0) + 1, lastStart + 1);
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
