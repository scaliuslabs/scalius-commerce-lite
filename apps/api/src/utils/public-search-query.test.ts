import { describe, expect, it } from "vitest";

import {
  INVALID_PUBLIC_FTS_CACHE_VALUE,
  isPublicProductListCacheable,
  isPublicProductSearchCacheable,
  isPublicSearchCacheable,
  normalizePublicFtsSearchCacheValue,
  normalizePublicFtsSearchQuery,
  normalizePublicIntegerCacheValue,
  normalizePublicListingSearchParam,
  normalizePublicNumberCacheValue,
  normalizePublicSearchQuery,
} from "./public-search-query";

describe("public search query normalization", () => {
  it("normalizes semantic whitespace", () => {
    expect(normalizePublicSearchQuery("  Fresh   Hilsa\nFish  ")).toBe("Fresh Hilsa Fish");
  });

  it("separates blank, invalid, and meaningful FTS search values", () => {
    expect(normalizePublicFtsSearchQuery("!!!!")).toBe("");
    expect(normalizePublicFtsSearchCacheValue("!!!!")).toBe(INVALID_PUBLIC_FTS_CACHE_VALUE);
    expect(normalizePublicListingSearchParam("!!!!")).toBe("!!!!");

    expect(normalizePublicFtsSearchCacheValue("   ")).toBe("");
    expect(normalizePublicListingSearchParam("   ")).toBeUndefined();

    expect(normalizePublicFtsSearchCacheValue("  Fresh   Hilsa  ")).toBe("Fresh Hilsa");
    expect(normalizePublicListingSearchParam("  Fresh   Hilsa  ")).toBe("Fresh Hilsa");
  });

  it("normalizes numeric cache key values", () => {
    expect(normalizePublicIntegerCacheValue("004")).toBe("4");
    expect(normalizePublicIntegerCacheValue("4.5")).toBe("4.5");
    expect(normalizePublicNumberCacheValue("001.50")).toBe("1.5");
    expect(normalizePublicNumberCacheValue("abc")).toBe("abc");
  });

  it("keeps invalid public search query shapes out of cache", () => {
    expect(isPublicSearchCacheable("https://api.example.test/search?q=fish&limit=50")).toBe(true);
    expect(isPublicSearchCacheable("https://api.example.test/search?q=fish&limit=5000")).toBe(false);
    expect(isPublicSearchCacheable("https://api.example.test/search?q=fish&limit=")).toBe(false);
    expect(isPublicSearchCacheable("https://api.example.test/search?q=fish&searchPages=")).toBe(false);
    expect(isPublicSearchCacheable("https://api.example.test/search?q=fish&minPrice=abc")).toBe(false);
  });

  it("keeps invalid public product query shapes out of cache", () => {
    expect(isPublicProductListCacheable("https://api.example.test/products?search=&page=1&limit=100")).toBe(true);
    expect(isPublicProductListCacheable("https://api.example.test/products?limit=101")).toBe(false);
    expect(isPublicProductListCacheable("https://api.example.test/products?page=0")).toBe(false);
    expect(isPublicProductListCacheable("https://api.example.test/products?page=1001")).toBe(false);
    expect(isPublicProductListCacheable("https://api.example.test/products?freeDelivery=")).toBe(false);
    expect(isPublicProductListCacheable("https://api.example.test/products?brand=")).toBe(false);
  });

  it("keeps invalid product lookup query shapes out of cache", () => {
    expect(isPublicProductSearchCacheable("https://api.example.test/products/search?search=&page=1&limit=100")).toBe(true);
    expect(isPublicProductSearchCacheable("https://api.example.test/products/search?limit=101")).toBe(false);
    expect(isPublicProductSearchCacheable("https://api.example.test/products/search?page=")).toBe(false);
  });
});
