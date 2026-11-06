// Keyset pages of a database resource list (audit L9): `cursor` + `limit` +
// `updatedSince` in, `{ <plural>, nextCursor }` out, in (updatedAt, id)
// order so a sync walks every change once without offsets or counts. A page
// stops early before its JSON passes the response budget, so a list always
// fits an app or agent result. The page's rows (or ids) are read first, then
// what each answers, in one batched read.
import { z } from "@hono/zod-openapi";
import { and, type SQL, type SQLWrapper } from "drizzle-orm";
import { encodeListCursorOrNull, type CursorValue, type ListCursor, type ListCursorShape } from "@scalius/shared/pagination";
import { keysetCondition, readListCursor, type KeysetOrder } from "@scalius/core/utils/keyset";

/** A page stops before its JSON passes this (an app or agent result is 64 KiB). */
const PAGE_BYTE_BUDGET = 56 * 1024;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

/** `cursor`, `limit` (at most `max`, `fallback` when omitted) and `updatedSince` query fields. */
export function resourcePageQueryWith(max: number, fallback: number) {
  return {
    cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
    limit: z.coerce.number().int().min(1).max(max).default(fallback)
      .openapi({ description: "At most this many records; a page may hold fewer to stay within the response budget." }),
    updatedSince: z.string().datetime({ offset: true }).optional()
      .openapi({ description: "Only records updated at or after this ISO 8601 time: keep the last `updatedAt` you saw to resume a sync." }),
  };
}

export const resourcePageQuery = resourcePageQueryWith(MAX_PAGE, DEFAULT_PAGE);

/** Whole seconds since the epoch of an ISO 8601 time (timestamps are stored in seconds). */
export function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** A resource's `updatedAt` (an ISO string or a timestamp column's Date) in the cursor's whole seconds. */
export function updatedSeconds(updatedAt: string | Date | null): number {
  if (updatedAt instanceof Date) return Math.floor(updatedAt.getTime() / 1000);
  return updatedAt ? epochSeconds(updatedAt) : 0;
}

/** Ascending (updatedAt, id): the order of every resource list. */
export function updatedOrder(column: SQLWrapper, id: SQLWrapper): KeysetOrder {
  return { column, id, direction: "asc" };
}

const CURSOR_SHAPE: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };

/**
 * One page of rows in a keyset order the caller defines: `after` is the rows
 * past a decoded cursor of `shape`, `position` an answered item's place in
 * that order (its sort values and its unique tiebreaker).
 */
export async function keysetRowsPage<Row, Item>(options: {
  shape: ListCursorShape;
  after: (cursor: ListCursor) => SQL;
  cursor: string | undefined;
  limit: number;
  where: SQL[];
  rows: (where: SQL | undefined, limit: number) => Promise<Row[]>;
  load: (rows: Row[]) => Promise<Item[]> | Item[];
  position: (item: Item) => { values: CursorValue[]; id: string };
}): Promise<{ items: Item[]; nextCursor: string | null }> {
  const where = [...options.where];
  if (options.cursor) where.push(options.after(readListCursor(options.cursor, options.shape)));
  const rows = await options.rows(where.length > 0 ? and(...where) : undefined, options.limit + 1);
  const more = rows.length > options.limit;
  const items = await options.load(rows.slice(0, options.limit));
  const kept: Item[] = [];
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (kept.length > 0 && bytes + size > PAGE_BYTE_BUDGET) break;
    kept.push(item);
    bytes += size;
  }
  const last = kept.at(-1);
  const cut = more || kept.length < items.length;
  return {
    items: kept,
    nextCursor: cut && last
      ? encodeListCursorOrNull({ sort: options.shape.sort, direction: options.shape.direction, ...options.position(last) })
      : null,
  };
}

/** One page of a resource list in (updatedAt, id) order (see the file comment): its ids, then their resources. */
export async function resourcePage<T extends { id: string; updatedAt: string | Date | null }>(
  options: {
    order: KeysetOrder;
    cursor: string | undefined;
    limit: number;
    where: SQL[];
    ids: (where: SQL | undefined, limit: number) => Promise<{ id: string }[]>;
    load: (ids: string[]) => Promise<T[]>;
  },
): Promise<{ items: T[]; nextCursor: string | null }> {
  return keysetRowsPage({
    shape: CURSOR_SHAPE,
    after: (cursor) => keysetCondition(options.order, cursor),
    cursor: options.cursor,
    limit: options.limit,
    where: options.where,
    rows: options.ids,
    load: (rows) => options.load(rows.map((row) => row.id)),
    position: (item) => ({ values: [updatedSeconds(item.updatedAt)], id: item.id }),
  });
}
