/**
 * Keyset (cursor) pagination for large lists.
 *
 * OFFSET reads and discards every row before the page, and an unfiltered
 * `count(*)` reads every index row of the table; at a million orders both
 * burn the Free plan's daily D1 read budget on one list view. The lists that
 * can grow that large instead:
 *
 * - walk with an opaque cursor naming the last row they showed (sort value
 *   plus id, so equal values stay in one stable order);
 * - learn "is there another page" from `limit + 1` rows, not a count;
 * - show a total that is exact up to the plan's count cap and "1,000+" above
 *   it (`SELECT count(*) FROM (SELECT 1 ... LIMIT cap + 1)` reads at most
 *   cap + 1 index rows);
 * - keep numbered `page` requests only for shallow offsets (the plan's
 *   `maxOffset`).
 *
 * The cap and the offset bound are plan values (`planLimits().lists`,
 * `@scalius/shared/plan-limits`: 1,000 on Free, 10,000 on Paid); everything
 * here takes them as arguments and defaults to the deployment's plan.
 *
 * This module is the pure half (cursor tokens, caps, page info); the SQL
 * half lives in `@scalius/core/utils/keyset`.
 *
 * A cursor is a position, not a secret: it carries sort values the caller
 * can already see, so it is not signed. It is strictly validated instead, and
 * a cursor made for another sort or direction is rejected rather than
 * silently walking the wrong order.
 *
 * A sort whose values are personal data (the orders list by customer name,
 * the customers list by name) must not put them in a URL, and base64 is not
 * protection. Those cursors are REFERENCES: they name the row (sort, direction,
 * id) and carry no value; the server reads the boundary row's value by id when
 * the cursor comes back (`resolveReferencedBoundary` in
 * `@scalius/core/utils/keyset`). Their shape has `kinds: []`, so a cursor that
 * still carries a value for such a sort, and a reference for any other sort,
 * are both refused.
 */
import { z } from "zod";
import { planLimits } from "./plan-limits";

export const LIST_CURSOR_VERSION = 1;
export const LIST_CURSOR_ERROR_CODE = "invalid_cursor";
export const LIST_OFFSET_ERROR_CODE = "page_too_deep";

const MAX_CURSOR_LENGTH = 1_024;
const MAX_CURSOR_TEXT_LENGTH = 512;
const MAX_CURSOR_ID_LENGTH = 256;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type CursorDirection = "asc" | "desc";
export type CursorValue = string | number | null;

/** What one sort value looks like: a finite number or a text. */
export type CursorValueKind = "number" | "text";

export interface ListCursor {
  /** The sort the cursor was issued for ("createdAt", "name"...). */
  sort: string;
  direction: CursorDirection;
  /** The last row's sort value(s); one entry per sort column. Empty for a reference cursor. */
  values: CursorValue[];
  /** The last row's id: the unique tiebreaker. Empty only for positional cursors. */
  id: string;
}

/** A malformed, tampered, or mismatched cursor. Callers turn it into a typed 400. */
export class InvalidCursorError extends Error {
  readonly code = LIST_CURSOR_ERROR_CODE;
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

const cursorEnvelope = z.strictObject({
  v: z.literal(LIST_CURSOR_VERSION),
  s: z.string().min(1).max(64),
  d: z.enum(["asc", "desc"]),
  // Empty for a reference cursor (a sort whose values are personal data).
  k: z.array(z.union([z.string().max(MAX_CURSOR_TEXT_LENGTH), z.number().finite(), z.null()])).max(4),
  i: z.string().max(MAX_CURSOR_ID_LENGTH),
});

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(token: string): string {
  const padded = token.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** The opaque URL-safe token for a list position. */
export function encodeListCursor(cursor: ListCursor): string {
  return toBase64Url(JSON.stringify({
    v: LIST_CURSOR_VERSION,
    s: cursor.sort,
    d: cursor.direction,
    k: cursor.values,
    i: cursor.id,
  }));
}

/**
 * The token, or null when the position cannot be carried: a text sort value
 * longer than a cursor holds (an imported 600-character name) would encode into
 * a token `decodeListCursor` refuses, so the page says it has no cursor
 * instead of handing out one that fails.
 */
export function encodeListCursorOrNull(cursor: ListCursor): string | null {
  const tooLong = cursor.values.some((value) => typeof value === "string" && value.length > MAX_CURSOR_TEXT_LENGTH)
    || cursor.id.length > MAX_CURSOR_ID_LENGTH;
  if (tooLong) return null;
  const token = encodeListCursor(cursor);
  return token.length > MAX_CURSOR_LENGTH ? null : token;
}

export interface ListCursorShape {
  /** The sort the request asked for. */
  sort: string;
  /** The direction the request asked for. */
  direction: CursorDirection;
  /** The type of each sort value, in order. Empty for a reference cursor (personal data: the cursor names the row only). */
  kinds: readonly CursorValueKind[];
  /** A sort column may hold NULL (the cursor then carries `null`). */
  nullable?: boolean;
  /** A position in a bounded ranked result: one non-negative integer and no id. */
  positional?: boolean;
}

function matchesKind(value: CursorValue, kind: CursorValueKind, nullable: boolean): boolean {
  if (value === null) return nullable;
  return kind === "number" ? typeof value === "number" : typeof value === "string";
}

/**
 * Reads a cursor token for the sort and direction the request asked for.
 * Throws `InvalidCursorError` for anything else: bad characters, bad JSON,
 * an unknown version, another sort or direction, wrong value types.
 */
export function decodeListCursor(token: string, shape: ListCursorShape): ListCursor {
  if (token.length === 0 || token.length > MAX_CURSOR_LENGTH || !BASE64URL.test(token)) {
    throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
  }
  let parsed: z.infer<typeof cursorEnvelope>;
  try {
    parsed = cursorEnvelope.parse(JSON.parse(fromBase64Url(token)));
  } catch {
    throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
  }
  if (parsed.s !== shape.sort || parsed.d !== shape.direction) {
    throw new InvalidCursorError(
      "This page cursor was issued for a different sort order. Start again from the first page after changing the sort.",
    );
  }
  if (parsed.k.length !== shape.kinds.length) {
    throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
  }
  const nullable = shape.nullable === true;
  if (!parsed.k.every((value, index) => matchesKind(value, shape.kinds[index]!, nullable))) {
    throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
  }
  if (shape.positional) {
    const position = parsed.k[0];
    if (parsed.i !== "" || typeof position !== "number" || !Number.isInteger(position) || position < 0) {
      throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
    }
  } else if (parsed.i === "") {
    throw new InvalidCursorError("This page cursor is not valid. Start again from the first page.");
  }
  return { sort: parsed.s, direction: parsed.d, values: parsed.k, id: parsed.i };
}

/** A total that is exact up to the cap and a lower bound above it. */
export function capTotal(
  counted: number,
  cap: number = planLimits().lists.countCap,
): { total: number; totalIsCapped: boolean } {
  const rows = Math.max(0, Math.trunc(Number(counted) || 0));
  return rows > cap ? { total: cap, totalIsCapped: true } : { total: rows, totalIsCapped: false };
}

/** The number of rows to read behind a capped count: one more than the cap shows. */
export function cappedCountLimit(cap: number = planLimits().lists.countCap): number {
  return cap + 1;
}

export interface PageInfo {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

export interface KeysetPage<T> {
  rows: T[];
  /** More rows exist beyond the page, in the direction that was read. */
  hasMore: boolean;
}

/**
 * Trims the `limit + 1` rows a keyset read returned. A backward read (a
 * `before` cursor) is fetched in reverse order and comes back in display
 * order.
 */
export function finishKeysetPage<T>(fetched: readonly T[], limit: number, backward: boolean): KeysetPage<T> {
  const rows = fetched.slice(0, limit);
  return { rows: backward ? rows.reverse() : rows, hasMore: fetched.length > limit };
}

/**
 * `anchored`: the page does not start at the top of the list (an `after`
 * cursor or a numbered page beyond the first) or, for a backward read, does
 * not end at the bottom (a `before` cursor always has the row it points at
 * after it).
 */
export function buildPageInfo<T>(
  page: KeysetPage<T>,
  options: { backward: boolean; anchored: boolean; cursorOf: (row: T) => string | null },
): PageInfo {
  const first = page.rows[0];
  const last = page.rows[page.rows.length - 1];
  return {
    hasNextPage: options.backward ? options.anchored : page.hasMore,
    hasPreviousPage: options.backward ? page.hasMore : options.anchored,
    startCursor: first === undefined ? null : options.cursorOf(first),
    endCursor: last === undefined ? null : options.cursorOf(last),
  };
}
