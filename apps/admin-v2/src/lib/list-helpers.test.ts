import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIST_MAX_LIMIT,
  createListSearchSchema,
  getCanonicalPageForPagination,
  normalizeListPositiveInteger,
} from "./list-helpers";

describe("list helpers", () => {
  it("normalizes page and limit URL values before query construction", () => {
    const schema = createListSearchSchema(
      ["createdAt", "updatedAt"] as const,
      { limit: 10, sort: "updatedAt" },
    );

    expect(schema.parse({ page: "3", limit: "20" })).toMatchObject({
      page: 3,
      limit: 20,
    });
    expect(schema.parse({ page: "-4", limit: "999" })).toMatchObject({
      page: 1,
      limit: DEFAULT_LIST_MAX_LIMIT,
    });
    expect(schema.parse({ page: "2.9", limit: "50.8" })).toMatchObject({
      page: 2,
      limit: 50,
    });
    expect(schema.parse({ page: "bad", limit: "bad" })).toMatchObject({
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
});
