import { describe, expect, it } from "vitest";

import {
  normalizePublicFtsSearchQuery,
  normalizePublicListingSearchParam,
  normalizePublicSearchQuery,
  readRepeatedPublicQueryValues,
} from "./public-search-query";

describe("public search query normalization", () => {
  it("normalizes semantic whitespace", () => {
    expect(normalizePublicSearchQuery("  Fresh   Hilsa\nFish  ")).toBe("Fresh Hilsa Fish");
  });

  it("separates blank, invalid, and meaningful FTS search values", () => {
    expect(normalizePublicFtsSearchQuery("!!!!")).toBe("");
    expect(normalizePublicListingSearchParam("!!!!")).toBe("!!!!");

    expect(normalizePublicFtsSearchQuery("   ")).toBe("");
    expect(normalizePublicListingSearchParam("   ")).toBeUndefined();

    expect(normalizePublicFtsSearchQuery("  Fresh   Hilsa  ")).toBe("Fresh Hilsa");
    expect(normalizePublicListingSearchParam("  Fresh   Hilsa  ")).toBe("Fresh Hilsa");
  });

  it("preserves repeated public values for multi-select facet resolution", () => {
    expect(readRepeatedPublicQueryValues(
      "https://api.example.test/products?color=Red&color=Blue&page=2",
    )).toEqual({ color: ["Red", "Blue"], page: ["2"] });
  });
});
