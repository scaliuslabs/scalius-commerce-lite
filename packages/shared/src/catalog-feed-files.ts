/**
 * Catalogue feed files (`/api/product-feed.xml`, `/api/facebook-feed.xml`).
 *
 * Google Merchant Center's scheduled fetch and Meta's scheduled feed read one
 * file per registered URL and follow no continuation. One request can only
 * produce the plan's `feedProductsPerRequest` products, so a larger catalogue
 * is published as several files, each a merchant registers once.
 *
 * A file is a range of creation time: the products created at or after its
 * start (`?from=<unix seconds>`; the first file has no `from`) and before the
 * next file's start. The next start is where the file's `perFile + 1`-th
 * product row was created, counting every product row (drafts, inactive and
 * trashed ones too), so:
 * - a new product is created now and joins the last file: no earlier file
 *   changes, and once the last file is full the next one appears after it.
 *   Registered URLs never change meaning; the merchant only ever adds one;
 * - publishing, unpublishing, trashing or restoring a product moves no file's
 *   end, so no product falls between two files;
 * - permanently deleting a product moves its file's end forward: that file
 *   then shares a few products with the next, but never skips one.
 * Every product of one second is in one file, so a file ends on a whole second.
 */

/** The query parameter that names a file after the first. */
export const FEED_FILE_FROM_PARAM = "from";

/** The largest `from` a URL may spell: unix seconds well past any creation time. */
export const FEED_FILE_MAX_FROM = 99_999_999_999;

export interface FeedFileRange {
  /** The first second of the file (0 for the first file). */
  from: number;
  /**
   * The second after the file's last (exclusive); null when the file is the
   * last one and reaches the newest product.
   */
  to: number | null;
}

/**
 * Where the file starting at `from` ends, given the creation seconds of the
 * first `perFile + 1` product rows created at or after `from`, ascending.
 * Null: the file holds every remaining row (it is the last file).
 */
export function feedFileEnd(createdAts: readonly number[], perFile: number): number | null {
  if (!Number.isSafeInteger(perFile) || perFile < 1) throw new RangeError("perFile must be a positive integer");
  if (createdAts.length <= perFile) return null;
  const first = createdAts[0]!;
  const boundary = createdAts[perFile]!;
  // More rows than a file holds were created in one second: the file takes
  // that whole second (it can then hold more than `perFile`).
  return boundary > first ? boundary : boundary + 1;
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

export interface FeedFile extends FeedFileRange {
  /** 1 for the canonical URL, then in creation order. */
  number: number;
  /** Product rows (any state) created in the file's range. */
  rows: number;
  /** When the file's first product row was created (unix seconds); null for an empty last file. */
  firstCreatedAt: number | null;
}

/**
 * Every file of a catalogue, from the creation seconds of all its product
 * rows, ascending. It applies `feedFileEnd` from each start, exactly as a
 * file request does, so the list names the files the requests serve.
 */
export function chainFeedFiles(createdAts: readonly number[], perFile: number): FeedFile[] {
  const files: FeedFile[] = [];
  let from = 0;
  let index = 0;
  for (;;) {
    const to = feedFileEnd(createdAts.slice(index, index + perFile + 1), perFile);
    let end = index;
    if (to === null) end = createdAts.length;
    else while (end < createdAts.length && createdAts[end]! < to) end += 1;
    files.push({
      number: files.length + 1,
      from,
      to,
      rows: end - index,
      firstCreatedAt: end > index ? createdAts[index]! : null,
    });
    if (to === null) return files;
    from = to;
    index = end;
  }
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
