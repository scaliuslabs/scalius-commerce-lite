import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InvalidCursorError,
  buildPageInfo,
  capTotal,
  cappedCountLimit,
  decodeListCursor,
  encodeListCursor,
  encodeListCursorOrNull,
  finishKeysetPage,
  type ListCursor,
} from "./pagination";
import { planLimits } from "./plan-limits";

const numberShape = { sort: "createdAt", direction: "desc", kinds: ["number"] } as const;

function token(payload: unknown): string {
  return btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

describe("list cursors", () => {
  it("round-trips numbers, text (including non-ASCII) and NULL", () => {
    const cases: Array<[ListCursor, Parameters<typeof decodeListCursor>[1]]> = [
      [{ sort: "createdAt", direction: "desc", values: [1_700_000_123], id: "ord_1" }, numberShape],
      [{ sort: "customerName", direction: "asc", values: ["রহিম উদ্দিন"], id: "ord_2" }, {
        sort: "customerName", direction: "asc", kinds: ["text"],
      }],
      [{ sort: "name", direction: "asc", values: [null], id: "prd_9" }, {
        sort: "name", direction: "asc", kinds: ["text"], nullable: true,
      }],
    ];
    for (const [cursor, shape] of cases) {
      const encoded = encodeListCursor(cursor);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeListCursor(encoded, shape)).toEqual(cursor);
    }
  });

  it("rejects a cursor issued for another sort or direction", () => {
    const encoded = encodeListCursor({ sort: "createdAt", direction: "desc", values: [5], id: "a" });
    expect(() => decodeListCursor(encoded, { ...numberShape, sort: "updatedAt" })).toThrow(InvalidCursorError);
    expect(() => decodeListCursor(encoded, { ...numberShape, direction: "asc" })).toThrow(/different sort order/);
  });

  it("rejects malformed, tampered and mistyped tokens", () => {
    const valid = encodeListCursor({ sort: "createdAt", direction: "desc", values: [5], id: "a" });
    const bad = [
      "",
      "not base64!",
      "a".repeat(2_000),
      valid.slice(0, -3),
      valid + "$",
      token({ v: 2, s: "createdAt", d: "desc", k: [5], i: "a" }),
      token({ v: 1, s: "createdAt", d: "sideways", k: [5], i: "a" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [5], i: "a", extra: true }),
      token({ v: 1, s: "createdAt", d: "desc", k: ["5"], i: "a" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [null], i: "a" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [5, 6], i: "a" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [], i: "a" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [5], i: "" }),
      token({ v: 1, s: "createdAt", d: "desc", k: [5], i: 7 }),
      token("just a string"),
      token(null),
    ];
    for (const candidate of bad) {
      expect(() => decodeListCursor(candidate, numberShape), candidate.slice(0, 30)).toThrow(InvalidCursorError);
    }
  });

  it("carries a typed code so callers can answer 400", () => {
    try {
      decodeListCursor("zzz!", numberShape);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidCursorError);
      expect((error as InvalidCursorError).code).toBe("invalid_cursor");
    }
  });

  it("accepts NULL only for a nullable sort", () => {
    const encoded = encodeListCursor({ sort: "createdAt", direction: "desc", values: [null], id: "a" });
    expect(() => decodeListCursor(encoded, numberShape)).toThrow(InvalidCursorError);
    expect(decodeListCursor(encoded, { ...numberShape, nullable: true }).values).toEqual([null]);
  });

  it("reads positional cursors as a non-negative integer with no id", () => {
    const shape = { sort: "relevance", direction: "desc", kinds: ["number"], positional: true } as const;
    const ok = encodeListCursor({ sort: "relevance", direction: "desc", values: [41], id: "" });
    expect(decodeListCursor(ok, shape).values).toEqual([41]);
    for (const payload of [
      { v: 1, s: "relevance", d: "desc", k: [-1], i: "" },
      { v: 1, s: "relevance", d: "desc", k: [1.5], i: "" },
      { v: 1, s: "relevance", d: "desc", k: [3], i: "ord_1" },
    ]) {
      expect(() => decodeListCursor(token(payload), shape)).toThrow(InvalidCursorError);
    }
    // A keyset cursor is not a positional one, and the other way round.
    const keyset = encodeListCursor({ sort: "relevance", direction: "desc", values: [3], id: "ord_1" });
    expect(() => decodeListCursor(keyset, shape)).toThrow(InvalidCursorError);
    expect(() => decodeListCursor(ok, { ...shape, positional: false })).toThrow(InvalidCursorError);
  });
});

describe("reference cursors (sorts whose values are personal data)", () => {
  const referenceShape = { sort: "customerName", direction: "asc", kinds: [] } as const;

  it("name the row and carry no sort value", () => {
    const cursor: ListCursor = { sort: "customerName", direction: "asc", values: [], id: "ord_7" };
    const encoded = encodeListCursor(cursor);
    expect(JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
      v: 1, s: "customerName", d: "asc", k: [], i: "ord_7",
    });
    expect(decodeListCursor(encoded, referenceShape)).toEqual(cursor);
    expect(encodeListCursorOrNull(cursor)).toBe(encoded);
  });

  it("are refused when a value is still inside, when the id is missing, and by a sort that expects a value", () => {
    const withValue = token({ v: 1, s: "customerName", d: "asc", k: ["Karim Ali"], i: "ord_7" });
    const withoutId = token({ v: 1, s: "customerName", d: "asc", k: [], i: "" });
    const reference = token({ v: 1, s: "customerName", d: "asc", k: [], i: "ord_7" });
    expect(() => decodeListCursor(withValue, referenceShape)).toThrow(InvalidCursorError);
    expect(() => decodeListCursor(withoutId, referenceShape)).toThrow(InvalidCursorError);
    expect(() => decodeListCursor(reference, { sort: "customerName", direction: "asc", kinds: ["text"] })).toThrow(InvalidCursorError);
  });
});

describe("cursors that cannot be carried", () => {
  it("encodes a normal position and gives no cursor for a value too long to decode again", () => {
    const normal: ListCursor = { sort: "customerName", direction: "asc", values: ["Anika Rahman"], id: "ord_1" };
    expect(encodeListCursorOrNull(normal)).toBe(encodeListCursor(normal));
    const long: ListCursor = { sort: "customerName", direction: "asc", values: ["x".repeat(513)], id: "ord_1" };
    expect(encodeListCursorOrNull(long)).toBeNull();
    // What it does return always decodes.
    const edge: ListCursor = { sort: "customerName", direction: "asc", values: ["é".repeat(300)], id: "ord_1" };
    const token = encodeListCursorOrNull(edge);
    if (token) expect(decodeListCursor(token, { sort: "customerName", direction: "asc", kinds: ["text"] })).toEqual(edge);
    expect(encodeListCursorOrNull({ ...normal, id: "i".repeat(300) })).toBeNull();
  });

  it("builds page info with a missing cursor when a row's position cannot be carried", () => {
    const page = finishKeysetPage(["a", "b"], 5, false);
    expect(buildPageInfo(page, { backward: false, anchored: false, cursorOf: () => null })).toEqual({
      hasNextPage: false,
      hasPreviousPage: false,
      startCursor: null,
      endCursor: null,
    });
  });
});

describe("capped totals", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["free", "paid"] as const)("is exact up to the %s plan's cap and a lower bound above it", (plan) => {
    vi.stubGlobal("__SCALIUS_PLAN__", plan);
    const cap = planLimits(plan).lists.countCap;
    expect(capTotal(0)).toEqual({ total: 0, totalIsCapped: false });
    expect(capTotal(37)).toEqual({ total: 37, totalIsCapped: false });
    expect(capTotal(cap)).toEqual({ total: cap, totalIsCapped: false });
    expect(capTotal(cap + 1)).toEqual({ total: cap, totalIsCapped: true });
    expect(capTotal(Number.NaN)).toEqual({ total: 0, totalIsCapped: false });
  });

  it("takes the cap as a value too", () => {
    expect(capTotal(120, 100)).toEqual({ total: 100, totalIsCapped: true });
    expect(capTotal(120, planLimits("paid").lists.countCap)).toEqual({ total: 120, totalIsCapped: false });
  });

  it.each(["free", "paid"] as const)("reads one row more than the cap shows on %s", (plan) => {
    vi.stubGlobal("__SCALIUS_PLAN__", plan);
    expect(cappedCountLimit()).toBe(planLimits(plan).lists.countCap + 1);
    expect(cappedCountLimit(10)).toBe(11);
  });
});

describe("page info", () => {
  const rows = ["a", "b", "c"];
  const cursorOf = (row: string) => `cursor:${row}`;

  it("trims the extra row and reports more rows ahead", () => {
    const page = finishKeysetPage([...rows, "d"], 3, false);
    expect(page).toEqual({ rows, hasMore: true });
    expect(buildPageInfo(page, { backward: false, anchored: false, cursorOf })).toEqual({
      hasNextPage: true,
      hasPreviousPage: false,
      startCursor: "cursor:a",
      endCursor: "cursor:c",
    });
  });

  it("an after-page knows rows precede it and none follow at the end", () => {
    const page = finishKeysetPage(rows, 3, false);
    expect(buildPageInfo(page, { backward: false, anchored: true, cursorOf })).toMatchObject({
      hasNextPage: false,
      hasPreviousPage: true,
    });
  });

  it("restores display order for a backward read and swaps the flags", () => {
    // Fetched nearest-first: c, b, a, then one more row before them.
    const page = finishKeysetPage(["c", "b", "a", "z"], 3, true);
    expect(page.rows).toEqual(["a", "b", "c"]);
    expect(buildPageInfo(page, { backward: true, anchored: true, cursorOf })).toEqual({
      hasNextPage: true,
      hasPreviousPage: true,
      startCursor: "cursor:a",
      endCursor: "cursor:c",
    });
    const top = finishKeysetPage(["b", "a"], 3, true);
    expect(buildPageInfo(top, { backward: true, anchored: true, cursorOf }).hasPreviousPage).toBe(false);
  });

  it("an empty page has no cursors", () => {
    expect(buildPageInfo(finishKeysetPage([], 3, false), { backward: false, anchored: true, cursorOf })).toEqual({
      hasNextPage: false,
      hasPreviousPage: true,
      startCursor: null,
      endCursor: null,
    });
  });
});
