/**
 * "Select all N matching" (dashboard T11, X6): a bulk action on every row
 * that matches a list's filter takes the filter, never an id list. The API
 * reads the matching rows itself, one slice at a time in id order, acts on
 * them, and hands back the last id as the cursor of the next slice.
 *
 * A slice is at most 90 rows (D1 binds at most 100 parameters, and the
 * per-row writes of one slice share one batch), and the walk is by id, not
 * by the list's sort: rows the action moves out of the filter (trashed,
 * set as draft) never shift the rows still to come, and a sort by relevance
 * cannot seek. Each request stays inside the plan's queries per invocation.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import { ValidationError } from "../errors";

/** Most rows one slice reads and acts on. */
export const BULK_MATCHING_SLICE = 90;

const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

/** The cursor a client sent: the last id of the slice before, or nothing for the first slice. */
export function readMatchingCursor(cursor: string | null | undefined): string | undefined {
    if (cursor === undefined || cursor === null || cursor === "") return undefined;
    if (!CURSOR_PATTERN.test(cursor)) {
        throw new ValidationError("This bulk action's position is not valid. Start it again.", { field: "matching.cursor" });
    }
    return cursor;
}

/** The rows after the cursor, in id order (`ORDER BY id` with it). */
export function matchingSliceCondition(id: SQLWrapper, cursor: string | undefined): SQL | undefined {
    return cursor ? sql`${id} > ${cursor}` : undefined;
}

/** The next slice's cursor: the last id when the slice was full (more may match), else null. */
export function nextMatchingCursor(rows: ReadonlyArray<{ id: string }>, limit: number): string | null {
    return rows.length >= limit ? rows[rows.length - 1]!.id : null;
}

