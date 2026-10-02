import { sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import {
    decodeListCursor,
    encodeListCursor,
    type CursorDirection,
} from "@scalius/shared/pagination";
import { planLimits } from "@scalius/shared/plan-limits";
import {
    keysetCondition,
    keysetOrderBy,
    positionCursor,
    resolveListPaging,
    resolvePositionalPaging,
    type KeysetOrder,
} from "./keyset";

// A sort column that holds NULLs and ties: the cases a keyset walk can lose rows on.
const VALUES: Array<number | null> = [null, 3, 1, null, 2, 3, 3, 1, null, 2, 5, 5];
const rows = VALUES.map((value, index) => ({ id: `r${String(index).padStart(2, "0")}`, value }));

const harnesses: Array<{ sqlite: { close(): void } }> = [];
afterEach(() => {
    vi.unstubAllGlobals();
    for (const harness of harnesses.splice(0)) harness.sqlite.close();
});

function setup() {
    const harness = createSqliteD1Database();
    harnesses.push(harness);
    harness.sqlite.exec("CREATE TABLE kt (id TEXT PRIMARY KEY, v INTEGER)");
    const insert = harness.sqlite.prepare("INSERT INTO kt (id, v) VALUES (?, ?)");
    for (const row of rows) insert.run(row.id, row.value);
    return harness.db;
}

const column = sql.raw("kt.v");
const id = sql.raw("kt.id");

function expected(direction: CursorDirection, idDirection: CursorDirection = direction): string[] {
    const sign = direction === "asc" ? 1 : -1;
    const idSign = idDirection === "asc" ? 1 : -1;
    const rank = (value: number | null) => value === null ? -Infinity : value;
    return [...rows]
        .sort((a, b) => sign * ((rank(a.value) - rank(b.value) || 0)) || idSign * (a.id < b.id ? -1 : 1))
        .map((row) => row.id);
}

describe("keyset conditions", () => {
    // The storefront lists newest-first with ids ascending, so the tiebreaker may run against the sort.
    const orders = [
        ...([true, false] as const).flatMap((nullable) => (["asc", "desc"] as const).map((direction) => ({ nullable, direction, idDirection: direction }))),
        { nullable: false, direction: "desc" as const, idDirection: "asc" as const },
        { nullable: false, direction: "asc" as const, idDirection: "desc" as const },
        { nullable: true, direction: "desc" as const, idDirection: "asc" as const },
    ];
    for (const { nullable, direction, idDirection } of orders) {
        {
            it(`pages ${direction} (ids ${idDirection}) through ties${nullable ? " and NULLs" : ""} one row at a time`, async () => {
                const db = setup();
                // Without NULLs the column is declared non-nullable; use only the non-NULL rows then.
                const all = nullable ? expected(direction, idDirection) : expected(direction, idDirection).filter((rowId) => rows.find((row) => row.id === rowId)!.value !== null);
                const order: KeysetOrder = { column, id, direction, idDirection, nullable };
                const present = (rowId: string) => nullable || rows.find((row) => row.id === rowId)!.value !== null;

                // Forward from every position: the rest of the list, in order.
                for (let position = 0; position < all.length; position += 1) {
                    const at = rows.find((row) => row.id === all[position])!;
                    const forward = await db.all<{ id: string }>(sql`SELECT kt.id FROM kt WHERE ${keysetCondition(order, { values: [at.value], id: at.id })} ORDER BY ${sql.join(keysetOrderBy(order), sql`, `)}`);
                    expect(forward.map((row) => row.id).filter(present), `after ${at.id}`).toEqual(all.slice(position + 1));
                    // Backward: the rows above, nearest first.
                    const backward = await db.all<{ id: string }>(sql`SELECT kt.id FROM kt WHERE ${keysetCondition(order, { values: [at.value], id: at.id }, { backward: true })} ORDER BY ${sql.join(keysetOrderBy(order, true), sql`, `)}`);
                    expect(backward.map((row) => row.id).filter(present), `before ${at.id}`).toEqual(all.slice(0, position).reverse());
                    // Inclusive: the cursor row itself counts too.
                    const upTo = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM kt WHERE ${keysetCondition(order, { values: [at.value], id: at.id }, { backward: true, inclusive: true })}`);
                    if (nullable) expect(Number(upTo[0]!.n)).toBe(position + 1);
                }
            });
        }
    }
});

describe("request paging", () => {
    const shape = { sort: "createdAt", direction: "desc", kinds: ["number"] } as const;

    it("reads a numbered page, or a cursor, never both", () => {
        expect(resolveListPaging({ page: 3, limit: 20 }, shape)).toEqual({ mode: "offset", offset: 40 });
        const token = encodeListCursor({ sort: "createdAt", direction: "desc", values: [9], id: "a" });
        expect(resolveListPaging({ page: 1, limit: 20, after: token }, shape)).toMatchObject({ mode: "after" });
        expect(resolveListPaging({ page: 1, limit: 20, before: token }, shape)).toMatchObject({ mode: "before" });
        expect(() => resolveListPaging({ page: 2, limit: 20, after: token }, shape)).toThrow(/page or a cursor/);
        expect(() => resolveListPaging({ page: 1, limit: 20, after: token, before: token }, shape)).toThrow(/either after or before/);
    });

    it("turns every cursor failure into a typed 400", () => {
        for (const bad of ["x", "eyJ2IjoxfQ", "a".repeat(5_000)]) {
            expect(() => resolveListPaging({ page: 1, limit: 20, after: bad }, shape)).toThrow(
                expect.objectContaining({ status: 400, code: "INVALID_CURSOR" }),
            );
        }
    });

    it.each(["free", "paid"] as const)("stops numbered pages at the %s plan's offset bound and points at the cursor", (plan) => {
        vi.stubGlobal("__SCALIUS_PLAN__", plan);
        const { maxOffset } = planLimits(plan).lists;
        const lastPage = maxOffset / 50;
        expect(() => resolveListPaging({ page: lastPage, limit: 50 }, shape)).not.toThrow();
        expect(() => resolveListPaging({ page: lastPage + 1, limit: 50 }, shape)).toThrow(
            expect.objectContaining({
                status: 400,
                code: "PAGE_TOO_DEEP",
                details: { maxOffset },
                message: expect.stringContaining("after cursor"),
            }),
        );
        // The bound is a value: the same call can name another one.
        expect(() => resolveListPaging({ page: 3, limit: 50 }, shape, 100)).toThrow(expect.objectContaining({ code: "PAGE_TOO_DEEP" }));
    });
});

describe("positional (ranked) paging", () => {
    it.each(["free", "paid"] as const)("pages by position inside the %s plan's bounded window", (plan) => {
        vi.stubGlobal("__SCALIUS_PLAN__", plan);
        const { maxOffset } = planLimits(plan).lists;
        expect(resolvePositionalPaging({ page: 1, limit: 25 }, "relevance")).toEqual({ offset: 0, take: 25 });
        expect(resolvePositionalPaging({ page: 3, limit: 25 }, "relevance")).toEqual({ offset: 50, take: 25 });
        expect(resolvePositionalPaging({ page: 1, limit: 25, after: positionCursor("relevance", 24) }, "relevance")).toEqual({ offset: 25, take: 25 });
        expect(resolvePositionalPaging({ page: 1, limit: 25, before: positionCursor("relevance", 60) }, "relevance")).toEqual({ offset: 35, take: 25 });
        // Near the top a before-page is whatever is left above the cursor.
        expect(resolvePositionalPaging({ page: 1, limit: 25, before: positionCursor("relevance", 10) }, "relevance")).toEqual({ offset: 0, take: 10 });
        // The last window page is trimmed to the bound.
        expect(resolvePositionalPaging({ page: 1, limit: 30, after: positionCursor("relevance", maxOffset - 16) }, "relevance")).toEqual({ offset: maxOffset - 15, take: 15 });
    });

    it("rejects the window's end, other sorts and keyset cursors", () => {
        const { maxOffset } = planLimits().lists;
        expect(() => resolvePositionalPaging({ page: 1, limit: 25, after: positionCursor("relevance", maxOffset - 1) }, "relevance")).toThrow(
            expect.objectContaining({ code: "PAGE_TOO_DEEP" }),
        );
        expect(() => resolvePositionalPaging({ page: 1, limit: 25, after: positionCursor("other", 3) }, "relevance")).toThrow(
            expect.objectContaining({ code: "INVALID_CURSOR" }),
        );
        const keyset = encodeListCursor({ sort: "relevance", direction: "desc", values: [3], id: "x" });
        expect(() => resolvePositionalPaging({ page: 1, limit: 25, after: keyset }, "relevance")).toThrow(
            expect.objectContaining({ code: "INVALID_CURSOR" }),
        );
        expect(decodeListCursor(positionCursor("relevance", 7), {
            sort: "relevance", direction: "desc", kinds: ["number"], positional: true,
        }).values).toEqual([7]);
    });
});
