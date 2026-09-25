import { describe, expect, it } from "vitest";
import { DEFAULT_BUDGETS, bindingCheckTarget, discoverPaths, evaluateBudgets, isLocalBase, median } from "./storefront-perf.mjs";

describe("storefront perf check", () => {
  it("finds a category and a product on the home page", () => {
    const html = `<a href="/about">About</a><a href="/categories/bags?sort=new">Bags</a>
      <a href="/products/linen-shirt">Linen</a><a href="/products/other">Other</a>`;

    expect(discoverPaths(html)).toEqual(["/", "/categories/bags", "/products/linen-shirt", "/search?q=a", "/cart"]);
    expect(discoverPaths("<p>empty store</p>")).toEqual(["/", "/search?q=a", "/cart"]);
  });

  it("takes the median of the finite samples", () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 20, null, 40, 30])).toBe(25);
    expect(median([])).toBeNull();
  });

  it("judges cached pages on hit and miss TTFB and every page on LCP and CLS", () => {
    const fast = {
      path: "/", cacheable: true, ttfbHit: 20, ttfbMiss: 250,
      phone: { lcp: 1400, cls: 0 }, desktop: { lcp: 900, cls: 0.02 },
    };
    expect(evaluateBudgets(fast)).toEqual([]);

    const slow = {
      path: "/products/x", cacheable: true, ttfbHit: 80, ttfbMiss: 900,
      phone: { lcp: 5500, cls: 0.2 }, desktop: { lcp: 1100, cls: 0 },
    };
    expect(evaluateBudgets(slow)).toEqual([
      "/products/x: ttfb hit ms 80 > 50",
      "/products/x: ttfb miss ms 900 > 300",
      "/products/x: phone LCP ms 5500 > 1500",
      "/products/x: phone CLS 0.2 > 0.1",
    ]);
  });

  it("fails a page whose first response is a server error", () => {
    const row = { path: "/", status: 503, cacheable: true, ttfbHit: 10, ttfbMiss: null, phone: null, desktop: null };

    expect(evaluateBudgets(row)).toEqual(["/: first response status 503"]);
  });

  it("subtracts the edge round trip only for remote bases", () => {
    expect(isLocalBase("http://localhost:4391")).toBe(true);
    expect(isLocalBase("http://127.0.0.1:4322")).toBe(true);
    expect(isLocalBase("https://storefront.scalius.com")).toBe(false);
    expect(isLocalBase("https://localhost.example.com")).toBe(false);
  });

  it("holds an always-rendered page to the miss budget", () => {
    const cart = { path: "/cart", cacheable: false, ttfbHit: 280, ttfbMiss: null, phone: null, desktop: null };

    expect(evaluateBudgets(cart)).toEqual([]);
    expect(evaluateBudgets({ ...cart, ttfbHit: DEFAULT_BUDGETS.ttfbMissMs + 1 })).toHaveLength(1);
  });

  it("checks a local storefront's binding before measuring, never a remote one", () => {
    expect(bindingCheckTarget({ base: "http://localhost:4601" })).toEqual({ storefrontUrl: "http://localhost:4601" });
    expect(bindingCheckTarget({ base: "http://localhost:4601", mediaUrl: "http://localhost:9001/api/v1/media" }))
      .toEqual({ storefrontUrl: "http://localhost:4601", mediaUrl: "http://localhost:9001/api/v1/media" });
    expect(bindingCheckTarget({ base: "https://storefront.scalius.com" })).toBeNull();
    expect(bindingCheckTarget({ base: "http://localhost:4601", bindingCheck: false })).toBeNull();
  });
});
