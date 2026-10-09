import { z } from "@hono/zod-openapi";
import { ValidationError } from "../utils/api-error";

/**
 * "All matching" bulk actions (`@scalius/core/utils/bulk-matching`): a bulk
 * endpoint takes either its id list or `matching: { filter, cursor? }`, the
 * list's own filter fields. The API reads at most one slice of the matching
 * rows (90, fewer for actions that write per row), acts on them and answers
 * `matching: { processed, skipped, next }`; the dashboard repeats the call
 * with `next` until it is null. The ids never travel, so "all 52,341
 * matching products" needs no list of 52,341 ids and no cap.
 */
export const matchingCursorSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).openapi({
    description: "The `next` of the slice before; leave it out for the first slice.",
});

export function matchingSchema<F extends z.ZodTypeAny>(filter: F) {
    return z.object({
        filter,
        cursor: matchingCursorSchema.optional(),
    }).strict().openapi({
        description: "Act on every row the list's filter matches instead of an id list, one slice per request.",
    });
}

export const matchingResultSchema = z.object({
    processed: z.number().int().nonnegative().openapi({ description: "Rows this slice changed." }),
    skipped: z.number().int().nonnegative().openapi({ description: "Rows this slice read but left as they were." }),
    next: z.string().nullable().openapi({ description: "Send it as matching.cursor for the next slice; null when every matching row is done." }),
});

export type MatchingResult = z.infer<typeof matchingResultSchema>;

/** A bulk body names its rows one way: ids or `matching`, never both or neither. */
export function requireOneSelection(ids: unknown[] | undefined, matching: unknown): void {
    if ((ids && ids.length > 0) === Boolean(matching)) {
        throw new ValidationError("Send either the rows or matching, not both.", { field: "matching" });
    }
}
