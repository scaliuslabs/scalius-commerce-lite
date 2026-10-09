/**
 * What a list's bulk action acts on (T11, X6). Either the rows ticked on this
 * page, or every row that matches the list's filter: then the dashboard
 * never gathers ids. It sends the filter, and the API reads the matching rows
 * itself, one slice at a time (at most 90 rows, inside D1's limits of 100
 * bound parameters and the plan's queries per request), acts on them, and
 * answers with a cursor to the next slice until none is left.
 *
 * The API contract (`apps/api/src/schemas/bulk-matching.ts`): a bulk
 * endpoint takes either its ids (`products`, `customerIds`, …) or
 * `matching: { filter, cursor? }` (the list's own filter fields, never in a
 * URL), and returns `matching: { processed, skipped, next }`.
 */
export type BulkTarget<T> =
  | { kind: "rows"; rows: T[] }
  | {
      kind: "matching";
      /** How many rows the list counted: a lower bound when `capped` ("1,000+"). */
      count: number;
      capped: boolean;
    };

/** One slice's answer from the API. */
export interface MatchingSlice {
  /** Rows the slice changed. */
  processed: number;
  /** Rows the slice read but left as they were (already in that state, or blocked). */
  skipped: number;
  /** Where the next slice starts; null when every matching row is done. */
  next: string | null;
}

export interface MatchingTotals {
  processed: number;
  skipped: number;
  /** The merchant stopped before the end. */
  stopped: boolean;
}

/**
 * Runs a matching bulk action slice by slice, one request after another,
 * until the API has no next slice or `shouldStop` says so. `onProgress`
 * gets the running totals after each slice.
 */
export async function runMatching(
  slice: (cursor: string | undefined) => Promise<MatchingSlice>,
  onProgress: (totals: MatchingTotals) => void = () => {},
  shouldStop: () => boolean = () => false,
): Promise<MatchingTotals> {
  const totals: MatchingTotals = { processed: 0, skipped: 0, stopped: false };
  let cursor: string | undefined;
  for (;;) {
    const result = await slice(cursor);
    totals.processed += result.processed;
    totals.skipped += result.skipped;
    onProgress({ ...totals });
    if (!result.next) return totals;
    if (shouldStop()) return { ...totals, stopped: true };
    // A cursor that does not move would loop forever: the API's bug, not a reason to hang.
    if (result.next === cursor) throw new Error("The bulk action did not move on.");
    cursor = result.next;
  }
}

/** The rows a target names, for actions that only work on ticked rows. */
export function targetRows<T>(target: BulkTarget<T>): T[] {
  return target.kind === "rows" ? target.rows : [];
}

/** How many rows a target names (a lower bound when the list's count is capped). */
export function targetCount<T>(target: BulkTarget<T>): number {
  return target.kind === "rows" ? target.rows.length : target.count;
}
