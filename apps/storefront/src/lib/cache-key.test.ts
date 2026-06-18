import { describe, expect, it } from "vitest";
import {
  buildCanonicalQueryString,
  buildHtmlCacheBaseUrl,
  canonicalizeUrlSearchParams,
} from "./cache-key";

describe("storefront cache key canonicalization", () => {
  it("sorts surviving HTML query params and removes tracking noise", () => {
    const url = new URL(
      "https://storefront.example.com/search?sortBy=price-desc&utm_source=ad&q=fish&page=2&fbclid=abc",
    );

    expect(buildHtmlCacheBaseUrl(url).toString()).toBe(
      "https://storefront.example.com/search?page=2&q=fish&sortBy=price-desc",
    );
    expect(url.searchParams.get("utm_source")).toBe("ad");
  });

  it("removes product client-side selection params from HTML cache keys", () => {
    const url = new URL(
      "https://storefront.example.com/products/fish?color=red&utm_campaign=sale&size=large&variant=keep",
    );

    expect(buildHtmlCacheBaseUrl(url).toString()).toBe(
      "https://storefront.example.com/products/fish?variant=keep",
    );
  });

  it("drops empty query values by default", () => {
    const url = new URL(
      "https://storefront.example.com/categories/laptop?q=&sortBy=newest&page=1",
    );

    expect(buildHtmlCacheBaseUrl(url).toString()).toBe(
      "https://storefront.example.com/categories/laptop",
    );
  });

  it("keeps category attribute filters while eliding category URL defaults", () => {
    const url = new URL(
      "https://storefront.example.com/categories/shoes?size=M&sortBy=newest&color=Red&page=1",
    );

    expect(buildHtmlCacheBaseUrl(url).toString()).toBe(
      "https://storefront.example.com/categories/shoes?color=Red&size=M",
    );
  });

  it("elides search URL defaults while preserving the search query and filters", () => {
    const first = buildHtmlCacheBaseUrl(
      new URL("https://storefront.example.com/search?sortBy=newest&page=1&q=boots&brand=Nike"),
    );
    const second = buildHtmlCacheBaseUrl(
      new URL("https://storefront.example.com/search?brand=Nike&q=boots"),
    );

    expect(first.toString()).toBe(second.toString());
    expect(first.toString()).toBe(
      "https://storefront.example.com/search?brand=Nike&q=boots",
    );
  });

  it("can preserve empty values when a caller needs exact query semantics", () => {
    const url = new URL("https://storefront.example.com/search?q=&page=1");

    expect(
      canonicalizeUrlSearchParams(url, { dropEmptyValues: false }).toString(),
    ).toBe("https://storefront.example.com/search?page=1&q=");
  });

  it("builds stable product-list query strings from option objects", () => {
    expect(
      buildCanonicalQueryString({
        sort: "newest",
        page: 1,
        limit: 20,
        search: "fish",
      }, {
        defaultParams: { page: 1, limit: 20, sort: "newest" },
      }),
    ).toBe("search=fish");
  });

  it("sorts repeated values so equivalent set filters share L2 keys", () => {
    expect(
      buildCanonicalQueryString({
        color: ["red", "blue"],
        size: ["xl", "m"],
      }),
    ).toBe("color=blue&color=red&size=m&size=xl");
  });
});
