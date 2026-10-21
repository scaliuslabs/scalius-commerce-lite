// Cursor pages of a bounded list (audit L9): the stable app API pages every
// list one way, `cursor` + `limit` in and `{ <plural>, nextCursor }` out,
// including lists the store bounds by design (an order's fulfilments, the
// store's languages, an app's webhook subscriptions). Such a list is read
// whole (it is small), ordered by a stable key, and cut here, so a client
// written against the contract keeps following `nextCursor` if a bound ever
// grows.
//
// The cursor names the last item's sort value and id (never its position),
// so an item added or removed between pages neither repeats nor skips the
// others. The limit defaults to the list's bound, so a caller that never
// pages still receives every item and `nextCursor: null`.
import { z } from "@hono/zod-openapi";
import { encodeListCursor, type ListCursorShape } from "@scalius/shared/pagination";
import { readListCursor } from "@scalius/core/utils/keyset";

export const nextCursorSchema = z.string().nullable().openapi({ description: "Pass it as `cursor` for the next page; null on the last page." });

/** `cursor` + `limit` query fields for a list of at most `bound` items. */
export function boundedPageQuery(bound: number) {
  return {
    cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
    limit: z.coerce.number().int().min(1).max(bound).default(bound)
      .openapi({ description: `At most this many items (default and maximum ${bound}).` }),
  };
}

type SortValue = string | number;

/**
 * One page of `items`, which must already be in the list's order: ascending
 * by the sort value (a number, or a short text such as an ISO time), then by
 * `id`. `name` scopes the cursor to this list.
 */
export function boundedPage<T>(
  items: readonly T[],
  options: {
    name: string;
    cursor: string | undefined;
    limit: number;
    id: (item: T) => string;
    sort: { kind: "number"; value: (item: T) => number } | { kind: "text"; value: (item: T) => string };
  },
): { items: T[]; nextCursor: string | null } {
  const sortValue = options.sort.value as (item: T) => SortValue;
  const shape: ListCursorShape = { sort: options.name, direction: "asc", kinds: [options.sort.kind] };
  let start = 0;
  if (options.cursor) {
    const cursor = readListCursor(options.cursor, shape);
    const after = cursor.values[0] as SortValue;
    start = items.findIndex((item) => {
      const value = sortValue(item);
      return value > after || (value === after && options.id(item) > cursor.id);
    });
    if (start < 0) start = items.length;
  }
  const page = items.slice(start, start + options.limit);
  const last = page.at(-1);
  const more = start + options.limit < items.length;
  return {
    items: page,
    nextCursor: more && last
      ? encodeListCursor({ sort: options.name, direction: "asc", values: [sortValue(last)], id: options.id(last) })
      : null,
  };
}
