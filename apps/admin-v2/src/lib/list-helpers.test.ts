import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_MAX_LIMIT,
  NO_CURSOR,
  createDataSelector,
  createListSearchValidator,
  getCanonicalPageForPagination,
  isPagingRefusal,
  normalizeAppFilterSearchParam,
  normalizeCursorSearchParam,
  normalizeOptionalEnumSearchParam,
  normalizeListPositiveInteger,
  resetCursorUnlessPaging,
  type SearchValidatorInput,
} from "./list-helpers";

function searchInput(value: Record<string, unknown>): SearchValidatorInput {
  return value as unknown as SearchValidatorInput;
}

describe("list helpers", () => {
  it("normalizes page and limit URL values before query construction", () => {
    const validateSearch = createListSearchValidator(
      ["createdAt", "updatedAt"] as const,
      { limit: 10, sort: "updatedAt" },
    );

    expect(validateSearch(searchInput({ page: "3", limit: "20" }))).toMatchObject({
      page: 3,
      limit: 20,
    });
    expect(validateSearch(searchInput({ page: "-4", limit: "999" }))).toMatchObject({
      page: 1,
      limit: DEFAULT_LIST_MAX_LIMIT,
    });
    expect(validateSearch(searchInput({ page: "2.9", limit: "50.8" }))).toMatchObject({
      page: 2,
      limit: 50,
    });
    expect(validateSearch(searchInput({ page: "bad", limit: "bad" }))).toMatchObject({
      page: 1,
      limit: 10,
    });
  });

  it("canonicalizes out-of-range pages after pagination is known", () => {
    expect(
      getCanonicalPageForPagination(999, { total: 54, totalPages: 6 }),
    ).toBe(6);
    expect(
      getCanonicalPageForPagination(999, { total: 0, totalPages: 0 }),
    ).toBe(1);
    expect(
      getCanonicalPageForPagination("bad", { total: 54, totalPages: 6 }),
    ).toBe(1);
  });

  it("keeps the numeric normalizer bounded and integer-only", () => {
    expect(normalizeListPositiveInteger(0, 10)).toBe(1);
    expect(normalizeListPositiveInteger(12.8, 10)).toBe(12);
    expect(normalizeListPositiveInteger(Number.POSITIVE_INFINITY, 10)).toBe(10);
    expect(normalizeListPositiveInteger(150, 10, { max: 100 })).toBe(100);
  });

  it("normalizes optional enum URL filters without keeping unknown values", () => {
    const options = ["paid", "partial", "unpaid"] as const;

    expect(normalizeOptionalEnumSearchParam("paid", options)).toBe("paid");
    expect(normalizeOptionalEnumSearchParam("unknown", options)).toBeUndefined();
    expect(normalizeOptionalEnumSearchParam(undefined, options)).toBeUndefined();
  });
});

describe("cursor paging URL state", () => {
  const validateSearch = createListSearchValidator(["createdAt", "updatedAt"] as const, { limit: 10 });

  it("keeps an opaque cursor from the URL and drops anything that is not URL-safe or too long", () => {
    expect(validateSearch(searchInput({ after: "eyJ2IjoxfQ" }))).toMatchObject({ after: "eyJ2IjoxfQ" });
    expect(validateSearch(searchInput({ before: "abc_DEF-123" }))).toMatchObject({ before: "abc_DEF-123" });
    expect(validateSearch(searchInput({ after: "not a cursor!" }))).not.toHaveProperty("after");
    expect(validateSearch(searchInput({ after: "a".repeat(1_025) }))).not.toHaveProperty("after");
    expect(validateSearch(searchInput({ after: "", before: 7 }))).not.toHaveProperty("before");
    expect(normalizeCursorSearchParam(undefined)).toBeUndefined();
  });

  it("uses after when a hand-edited URL carries both cursors", () => {
    const search = validateSearch(searchInput({ after: "first", before: "second" }));
    expect(search.after).toBe("first");
    expect(search).not.toHaveProperty("before");
  });

  it("drops the cursor on any change that is not a Previous/Next move", () => {
    expect(resetCursorUnlessPaging({ sort: "createdAt", page: 1 })).toEqual({ sort: "createdAt", page: 1, ...NO_CURSOR });
    expect(resetCursorUnlessPaging({ after: "next-page", page: 1 })).toEqual({ after: "next-page", page: 1 });
    expect(resetCursorUnlessPaging({ before: "prev-page", after: undefined })).toEqual({ before: "prev-page", after: undefined });
  });

  it("recognises the API's paging refusals", () => {
    expect(isPagingRefusal({ code: "invalid_cursor" })).toBe(true);
    expect(isPagingRefusal({ code: "page_too_deep" })).toBe(true);
    expect(isPagingRefusal({ code: "validation_error" })).toBe(false);
    expect(isPagingRefusal(new Error("boom"))).toBe(false);
    expect(isPagingRefusal(null)).toBe(false);
  });

  it("hands the list's pageInfo to the table beside its rows and counts", () => {
    const pageInfo = { hasNextPage: true, hasPreviousPage: false, startCursor: "a", endCursor: "b" };
    const selected = createDataSelector<{ id: string }>("orders")({
      orders: [{ id: "o1" }],
      pagination: { total: 1_000, page: 1, limit: 10, totalPages: 100, totalIsCapped: true, offset: 0 },
      pageInfo,
    });
    expect(selected.pageInfo).toEqual(pageInfo);
    expect(selected.pagination).toMatchObject({ totalIsCapped: true, offset: 0 });
    expect(createDataSelector("orders")({}).pageInfo).toBeUndefined();
  });

  it("puts the apps' values on their rows, and leaves the rows alone without any", () => {
    const rows = [{ id: "o1" }, { id: "o2" }];
    const none = createDataSelector<{ id: string }>("orders")({ orders: rows });
    // Without app columns the very same rows come back.
    expect(none.data).toBe(rows);
    const withValues = createDataSelector<{ id: string; appValues?: unknown }>("orders")({
      orders: rows,
      appValues: { o1: { "acme.crm/tier": "gold", "acme.crm/vip": false } },
    });
    expect(withValues.data).toEqual([
      { id: "o1", appValues: { "acme.crm/tier": "gold", "acme.crm/vip": false } },
      { id: "o2" },
    ]);
    // The response's rows are not changed.
    expect(rows[0]).toEqual({ id: "o1" });
  });

  it("reads an app filter from the URL only in its own shape", () => {
    expect(normalizeAppFilterSearchParam("acme.crm/tier:gold")).toBe("acme.crm/tier:gold");
    expect(normalizeAppFilterSearchParam("acme.crm/note:a:b c")).toBe("acme.crm/note:a:b c");
    for (const bad of ["", "tier:gold", "acme.crm/tier", "acme.crm/tier:", "/tier:gold", "a b/tier:x", `a/b:${"x".repeat(400)}`, 5, undefined, ["a/b:c"]]) {
      expect(normalizeAppFilterSearchParam(bad), String(bad)).toBeUndefined();
    }
  });
});
