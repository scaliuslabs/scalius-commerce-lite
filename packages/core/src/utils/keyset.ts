/**
 * The SQL half of keyset pagination (the pure half is
 * `@scalius/shared/pagination`): the "rows after this cursor" predicate, the
 * capped count, and request-paging validation with typed 400s.
 *
 * The predicate is plain OR/AND expansion, never row values (`(a, b) < (?, ?)`),
 * because the sort direction and the NULL placement differ per sort and the
 * SQLite profile that D1, Turso and PostgreSQL share keeps to portable SQL.
 * NULL sorts first ascending and last descending (SQLite's order); a sort
 * column that can hold NULL must say so (`nullable`) or those rows would
 * drop out of the walk.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { SQLiteSelect } from "drizzle-orm/sqlite-core";
import type { Database } from "@scalius/database/client";
import { planLimits, type PlanLimits } from "@scalius/shared/plan-limits";
import {
    InvalidCursorError,
    LIST_OFFSET_ERROR_CODE,
    LIST_CURSOR_ERROR_CODE,
    buildPageInfo,
    cappedCountLimit,
    capTotal,
    decodeListCursor,
    encodeListCursor,
    encodeListCursorOrNull,
    finishKeysetPage,
    type CursorDirection,
    type CursorValue,
    type CursorValueKind,
    type ListCursor,
    type ListCursorShape,
} from "@scalius/shared/pagination";
import { AppError } from "../errors";
import { formatNumber } from "@scalius/shared/locale-format";

/** The plan's list limits: the count cap and the deepest numbered page. */
export type ListLimits = PlanLimits["lists"];

/** One sort: the column, its unique tiebreaker, and the direction the list reads in. */
export interface KeysetOrder {
    /** The sort column or expression, exactly as the ORDER BY writes it. */
    column: SQLWrapper;
    /** The unique tiebreaker (the id column). */
    id: SQLWrapper;
    direction: CursorDirection;
    /** The tiebreaker's own direction when it differs from the sort's (default: the same). */
    idDirection?: CursorDirection;
    /** The sort column can hold NULL. */
    nullable?: boolean;
}

function flip(direction: CursorDirection): CursorDirection {
    return direction === "asc" ? "desc" : "asc";
}

/** ORDER BY terms for the list, or for a backward read (a `before` cursor) in reverse. */
export function keysetOrderBy(order: KeysetOrder, backward = false): SQL[] {
    const direction = backward ? flip(order.direction) : order.direction;
    const idDirection = backward ? flip(order.idDirection ?? order.direction) : (order.idDirection ?? order.direction);
    return [
        sql`${order.column} ${sql.raw(direction)}`,
        sql`${order.id} ${sql.raw(idDirection)}`,
    ];
}

/**
 * The rows that come after the cursor in the list's order (`backward`: the
 * rows before it; `inclusive`: the cursor's own position as well).
 *
 * A redundant range on the sort column (`col <= ?` beside the tuple compare)
 * lets SQLite seek the sort column's index to the cursor instead of walking
 * from the top; it is skipped when NULL rows must stay reachable.
 */
export function keysetCondition(
    order: KeysetOrder,
    cursor: Pick<ListCursor, "values" | "id">,
    options: { backward?: boolean; inclusive?: boolean } = {},
): SQL {
    const direction = options.backward ? flip(order.direction) : order.direction;
    const idDirection = options.backward ? flip(order.idDirection ?? order.direction) : (order.idDirection ?? order.direction);
    const value: CursorValue = cursor.values[0] ?? null;
    const nullable = order.nullable === true;
    const column = sql`${order.column}`;
    const id = sql`${order.id}`;
    const ahead = sql.raw(direction === "asc" ? ">" : "<");
    const idAhead = sql.raw(idDirection === "asc" ? (options.inclusive ? ">=" : ">") : (options.inclusive ? "<=" : "<"));
    const bound = sql.raw(direction === "asc" ? ">=" : "<=");

    if (value === null) {
        // NULL is the smallest value: first ascending, last descending.
        return direction === "asc"
            ? sql`((${column} IS NULL AND ${id} ${idAhead} ${cursor.id}) OR ${column} IS NOT NULL)`
            : sql`(${column} IS NULL AND ${id} ${idAhead} ${cursor.id})`;
    }
    const tuple = sql`(${column} ${ahead} ${value} OR (${column} = ${value} AND ${id} ${idAhead} ${cursor.id}))`;
    if (nullable && direction === "desc") {
        return sql`(${tuple} OR ${column} IS NULL)`;
    }
    return sql`(${column} ${bound} ${value} AND ${tuple})`;
}

/**
 * A count that reads at most `cap + 1` rows: pass a `select 1 ... where ...`
 * and get `SELECT count(*) FROM (<that> LIMIT cap + 1)`. Feed the result to
 * `capTotal` from `@scalius/shared/pagination`.
 */
export function cappedCountQuery(
    db: Database,
    probe: SQLiteSelect,
    cap: number = planLimits().lists.countCap,
) {
    return db
        .select({ count: sql<number>`count(*)` })
        .from(probe.limit(cappedCountLimit(cap)).as("capped_rows"));
}

/** A `select 1`, the column a capped count's probe reads. */
export const COUNT_PROBE_COLUMN = { one: sql<number>`1`.as("one") } as const;

// ─── Request paging ──────────────────────────────────────────────────────────

/** A cursor the caller can read, with the typed 400 every list shares. */
export function invalidCursor(message: string): AppError {
    return new AppError(400, LIST_CURSOR_ERROR_CODE, message, {
        hint: "Start again from the first page, without after or before.",
    });
}

/** Reads a cursor token for this sort, turning a bad one into a typed 400. */
export function readListCursor(token: string, shape: ListCursorShape): ListCursor {
    try {
        return decodeListCursor(token, shape);
    } catch (error) {
        if (error instanceof InvalidCursorError) throw invalidCursor(error.message);
        throw error;
    }
}

export function tooDeepPage(offset: number, maxOffset: number = planLimits().lists.maxOffset): AppError {
    return new AppError(
        400,
        LIST_OFFSET_ERROR_CODE,
        `Page numbers reach the first ${formatNumber(maxOffset, "en")} rows only (this page starts at row ${formatNumber(offset + 1, "en")}). Walk further with the after cursor from pageInfo.endCursor.`,
        { maxOffset },
    );
}

export type ListPaging =
    | { mode: "offset"; offset: number }
    | { mode: "after" | "before"; cursor: ListCursor };

/**
 * Which way a list request reads: a numbered page (`page`, shallow only), or
 * `after`/`before` a cursor. They are mutually exclusive; a bad combination or
 * a cursor for another sort is a typed 400.
 */
export function resolveListPaging(
    input: { page: number; limit: number; after?: string | null; before?: string | null },
    shape: ListCursorShape,
    maxOffset: number = planLimits().lists.maxOffset,
): ListPaging {
    const after = input.after?.trim() || undefined;
    const before = input.before?.trim() || undefined;
    if (after && before) {
        throw invalidCursor("Use either after or before, not both.");
    }
    const token = after ?? before;
    if (token) {
        if (input.page > 1) throw invalidCursor("Use either page or a cursor, not both.");
        return { mode: after ? "after" : "before", cursor: readListCursor(token, shape) };
    }
    const offset = Math.max(0, (input.page - 1) * input.limit);
    if (offset >= maxOffset) throw tooDeepPage(offset, maxOffset);
    return { mode: "offset", offset };
}

/** The cursor token for row `position` of a ranked (relevance) result. */
export function positionCursor(sort: string, position: number): string {
    return encodeListCursor({ sort, direction: "desc", values: [position], id: "" });
}

/**
 * Paging for a ranked result (a text search ordered by relevance). The rank
 * is computed per row and cannot seek, so these lists page by position and
 * only inside the first `maxOffset` matches: `after`/`before` cursors
 * carry a row position instead of a sort value. Returns the rows to skip and
 * the rows to show (a `before` page is the `limit` rows ending at the cursor).
 */
export function resolvePositionalPaging(
    input: { page: number; limit: number; after?: string | null; before?: string | null },
    sort: string,
    maxOffset: number = planLimits().lists.maxOffset,
): { offset: number; take: number } {
    const after = input.after?.trim() || undefined;
    const before = input.before?.trim() || undefined;
    if (after && before) throw invalidCursor("Use either after or before, not both.");
    const token = after ?? before;
    let offset = Math.max(0, (input.page - 1) * input.limit);
    let take = input.limit;
    if (token) {
        if (input.page > 1) throw invalidCursor("Use either page or a cursor, not both.");
        const position = readListCursor(token, {
            sort, direction: "desc", kinds: ["number"], positional: true,
        }).values[0] as number;
        if (after) {
            offset = position + 1;
        } else {
            offset = Math.max(0, position - input.limit);
            take = position - offset;
        }
    }
    if (offset >= maxOffset) throw tooDeepPage(offset, maxOffset);
    return { offset, take: Math.min(take, maxOffset - offset) };
}

// ─── One list's page plan ────────────────────────────────────────────────────

export interface KeysetListSpec {
    /** The sort the request asked for; its cursors are issued for it. */
    sort: string;
    order: KeysetOrder;
    kind: CursorValueKind;
    /** A ranked result (search by relevance): page by position over this ORDER BY. */
    ranked?: SQL[];
    /**
     * The sort column holds personal data (a customer's name): its cursors
     * name the row and carry no value, so nothing personal enters a URL. The
     * caller reads the boundary row's value by id first
     * (`resolveReferencedBoundary`) and passes it as `input.boundary`.
     * Such a sort column must not be NULL.
     */
    referenced?: boolean;
}

/** What a list request carries to `planKeysetPage`. */
export interface KeysetPageInput {
    page: number;
    limit: number;
    after?: string | null;
    before?: string | null;
    /** A referenced sort only: the cursor row's current sort value (see `resolveReferencedBoundary`). */
    boundary?: CursorValue;
}

/**
 * Reads the sort value of the row a reference cursor names, for a sort whose
 * values are personal data. `read` is one primary-key lookup of the sort
 * column. Resolves to `undefined` when the request has no cursor; a cursor for
 * a row that no longer exists is a typed 400, not a silently empty page.
 */
export async function resolveReferencedBoundary(
    input: { after?: string | null; before?: string | null },
    spec: { sort: string; direction: CursorDirection },
    read: (id: string) => Promise<CursorValue | undefined>,
): Promise<CursorValue | undefined> {
    const after = input.after?.trim() || undefined;
    const before = input.before?.trim() || undefined;
    // Both together is refused by `resolveListPaging`, with its own message.
    const token = after && before ? undefined : (after ?? before);
    if (!token) return undefined;
    const cursor = readListCursor(token, { sort: spec.sort, direction: spec.direction, kinds: [] });
    const value = await read(cursor.id);
    if (value === undefined || value === null) {
        throw invalidCursor("This page cursor points at a row that no longer exists. Start again from the first page.");
    }
    return value;
}

/** A row of a keyset-paged read: its id and its sort column exactly as stored. */
export interface KeysetRow {
    id: string;
    keysetValue: CursorValue;
}

/**
 * Everything one list needs to read a page: validated paging, the page's
 * predicate and ORDER BY, the window to fetch (one row past the page), the
 * capped position count, and how to turn the fetched rows into the page and
 * its `pageInfo`.
 *
 * The data read must select the sort column as `keysetValue` (aliased: a
 * plain duplicate of a column the query already selects maps to NULL) and
 * the id as `id`.
 */
export function planKeysetPage(
    input: KeysetPageInput,
    spec: KeysetListSpec,
    lists: ListLimits = planLimits().lists,
) {
    const { limit } = input;
    const positional = spec.ranked ? resolvePositionalPaging(input, spec.sort, lists.maxOffset) : null;
    let paging: ListPaging = positional
        ? { mode: "offset", offset: positional.offset }
        : resolveListPaging(input, {
            sort: spec.sort,
            direction: spec.order.direction,
            kinds: spec.referenced ? [] : [spec.kind],
            nullable: spec.order.nullable,
        }, lists.maxOffset);
    if (spec.referenced && paging.mode !== "offset") {
        if (input.boundary === undefined) {
            throw new Error(`The ${spec.sort} sort pages by reference: read the boundary with resolveReferencedBoundary first.`);
        }
        paging = { mode: paging.mode, cursor: { ...paging.cursor, values: [input.boundary] } };
    }
    const backward = paging.mode === "before";
    const take = positional?.take ?? limit;

    return {
        /** ORDER BY of the page read (reversed for a `before` page). */
        orderBy: spec.ranked ?? keysetOrderBy(spec.order, backward),
        /** Rows to skip. */
        offset: paging.mode === "offset" ? paging.offset : 0,
        /** Rows to read: one more than the page shows. */
        fetchLimit: take + 1,
        /** The list's filters plus, for a cursor page, the rows beyond the cursor. */
        pageWhere(base: SQL | undefined): SQL | undefined {
            return paging.mode === "offset"
                ? base
                : sql`${base} AND ${keysetCondition(spec.order, paging.cursor, { backward })}`;
        },
        /**
         * The predicate of a capped count of the rows that lead up to a cursor
         * page (so the dashboard can print "51-100 of 1,000+"); null for a
         * numbered or positional page, whose offset is already known.
         */
        positionWhere(base: SQL | undefined): SQL | null {
            return paging.mode === "offset"
                ? null
                : sql`${base} AND ${keysetCondition(spec.order, paging.cursor, { backward: true, inclusive: !backward })}`;
        },
        /** Trims the fetched rows to the page and builds its `pageInfo` and start position. */
        finish<Row extends KeysetRow>(fetched: readonly Row[], positionCount?: number) {
            const page = finishKeysetPage(fetched, take, backward);
            // A ranked search only shows its first `maxOffset` matches.
            if (positional && positional.offset + take >= lists.maxOffset) page.hasMore = false;
            const rows = page.rows;
            const upToCursor = paging.mode === "offset" ? null : Number(positionCount ?? 0);
            const pageStart: number | null = paging.mode === "offset"
                ? paging.offset
                : upToCursor !== null && upToCursor <= lists.countCap
                    ? Math.max(0, upToCursor - (backward ? rows.length : 0))
                    : null;
            const pageInfo = buildPageInfo(
                { rows: rows.map((row, index) => ({ row, index })), hasMore: page.hasMore },
                {
                    backward,
                    anchored: paging.mode !== "offset" || paging.offset > 0,
                    cursorOf: ({ row, index }) => positional
                        ? positionCursor(spec.sort, positional.offset + index)
                        : encodeListCursorOrNull({
                            sort: spec.sort,
                            direction: spec.order.direction,
                            // A referenced sort never puts its (personal) value in the cursor.
                            values: spec.referenced ? [] : [row.keysetValue],
                            id: row.id,
                        }),
                },
            );
            return { rows, pageInfo, pageStart };
        },
    };
}

/** The `pagination` object of a keyset-paged list. */
export function cappedPagination(
    counted: number,
    pageStart: number | null,
    limit: number,
    cap: number = planLimits().lists.countCap,
) {
    const { total, totalIsCapped } = capTotal(counted, cap);
    return {
        total,
        /** `total` is a lower bound: more rows match than the count reads. */
        totalIsCapped,
        /** The page's number; 0 for a cursor page deeper than the count cap. */
        page: pageStart === null ? 0 : Math.floor(pageStart / limit) + 1,
        limit,
        totalPages: Math.ceil(total / limit),
        /** Zero-based index of the page's first row; null deeper than the count cap. */
        offset: pageStart,
    };
}
