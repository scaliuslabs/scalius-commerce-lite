// Keyset pages of a database resource list (audit L9): `cursor` + `limit` +
// `updatedSince` in, `{ <plural>, nextCursor }` out, in (updatedAt, id)
// order so a sync walks every change once without offsets or counts. A page
// stops early before its JSON passes the response budget, so a list always
// fits an app or agent result. The page's ids are read first, then their
// resources in one batched read.
import { z } from "@hono/zod-openapi";
import { and, type SQL, type SQLWrapper } from "drizzle-orm";
import { encodeListCursorOrNull, type ListCursorShape } from "@scalius/shared/pagination";
import { keysetCondition, readListCursor, type KeysetOrder } from "@scalius/core/utils/keyset";

/** A page stops before its JSON passes this (an app or agent result is 64 KiB). */
const PAGE_BYTE_BUDGET = 56 * 1024;
const DEFAULT_PAGE = 20;
const MAX_PAGE = 50;

export const resourcePageQuery = {
  cursor: z.string().max(1024).optional().openapi({ description: "The `nextCursor` of the page before; leave it out for the first page." }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE).default(DEFAULT_PAGE)
    .openapi({ description: "At most this many records; a page may hold fewer to stay within the response budget." }),
  updatedSince: z.string().datetime({ offset: true }).optional()
    .openapi({ description: "Only records updated at or after this ISO 8601 time: keep the last `updatedAt` you saw to resume a sync." }),
};

/** Whole seconds since the epoch of an ISO 8601 time (timestamps are stored in seconds). */
export function epochSeconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/** Ascending (updatedAt, id): the order of every resource list. */
export function updatedOrder(column: SQLWrapper, id: SQLWrapper): KeysetOrder {
  return { column, id, direction: "asc" };
}

const CURSOR_SHAPE: ListCursorShape = { sort: "updatedAt", direction: "asc", kinds: ["number"] };

/** One page of a resource list (see the file comment). */
export async function resourcePage<T extends { id: string; updatedAt: string }>(
  options: {
    order: KeysetOrder;
    cursor: string | undefined;
    limit: number;
    where: SQL[];
    ids: (where: SQL | undefined, limit: number) => Promise<{ id: string }[]>;
    load: (ids: string[]) => Promise<T[]>;
  },
): Promise<{ items: T[]; nextCursor: string | null }> {
  const where = [...options.where];
  if (options.cursor) where.push(keysetCondition(options.order, readListCursor(options.cursor, CURSOR_SHAPE)));
  const rows = await options.ids(where.length > 0 ? and(...where) : undefined, options.limit + 1);
  const more = rows.length > options.limit;
  const items = await options.load(rows.slice(0, options.limit).map((row) => row.id));
  const kept: T[] = [];
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
      ? encodeListCursorOrNull({ sort: CURSOR_SHAPE.sort, direction: "asc", values: [epochSeconds(last.updatedAt)], id: last.id })
      : null,
  };
}
