import { describe, expect, it } from "vitest";
import { MAX_RUNS, compareTable, discoverComparePages, parseCompareArgs } from "./storefront-compare.mjs";

describe("storefront comparison", () => {
  it("takes labelled sites and caps the runs at three", () => {
    const args = parseCompareArgs(["--site", "ours=https://shop.example", "--site", "dawn=https://dawn.example/", "--runs", "9"]);
    expect(args.sites).toEqual([
      { label: "ours", home: "https://shop.example/" },
      { label: "dawn", home: "https://dawn.example/" },
    ]);
    expect(args.runs).toBe(MAX_RUNS);
    expect(() => parseCompareArgs([])).toThrow(/at least one --site/);
    expect(() => parseCompareArgs(["--site", "https://no-label.example"])).toThrow(/label/);
  });

  it("finds a listing, a product and the cart on Scalius, Shopify and WooCommerce home pages", () => {
    const pages = (html, home) => Object.fromEntries(discoverComparePages(html, home).map((entry) => [entry.page, entry.url]));
    expect(pages('<a href="/categories/bags">B</a><a href="/products/tote?x=1">T</a><a href="/products/tote">T</a>', "https://shop.example/"))
      .toEqual({ home: "https://shop.example/", listing: "https://shop.example/categories/bags", product: "https://shop.example/products/tote", cart: "https://shop.example/cart" });
    expect(pages('<a href="https://other.example/products/x">X</a><a href="/collections/all">A</a><a href="/cart">C</a>', "https://dawn.example/"))
      .toEqual({ home: "https://dawn.example/", listing: "https://dawn.example/collections/all", cart: "https://dawn.example/cart" });
    expect(pages('<a href="https://woo.example/store/shop/">S</a><a href="https://woo.example/store/product/hat/">H</a><a href="https://woo.example/store/basket/">B</a>', "https://woo.example/store/"))
      .toEqual({ home: "https://woo.example/store/", listing: "https://woo.example/store/shop/", product: "https://woo.example/store/product/hat/", cart: "https://woo.example/store/basket/" });
  });

  it("prints one Markdown row per page", () => {
    const table = compareTable([{ site: "ours", page: "home", serverMs: 3, pageMs: 28, floorMs: 25, phone: { lcp: 1200, cls: 0, transferKb: 200 }, desktop: { lcp: 300, cls: 0 } }]);
    expect(table.split("\n")).toHaveLength(3);
    expect(table).toContain("| ours | home | 3 / 28 / 25 | 1200 | 0 | 200 | 300 | 0 |");
  });
});
