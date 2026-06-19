import { describe, expect, it } from "vitest";
import {
  canonicalizeStorefrontHtmlCachePath,
  normalizeStorefrontHtmlCachePaths,
} from "./storefront-cache-path";

describe("storefront HTML cache path canonicalization", () => {
  it("canonicalizes product selection and tracking variants to one HTML path", () => {
    expect(canonicalizeStorefrontHtmlCachePath("/products/fish?size=m")).toBe(
      "/products/fish",
    );
    expect(
      canonicalizeStorefrontHtmlCachePath("/products/fish?color=red&utm_source=ad"),
    ).toBe("/products/fish");
  });

  it("sorts surviving query params and elides listing defaults", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/categories/drinks?sortBy=newest&page=1&brand=Fresh&q=%20hilsa%20%20fish%20",
      ),
    ).toBe("/categories/drinks?brand=Fresh&q=hilsa+fish");
  });

  it("collapses repeated query params to the last rendered value", () => {
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/search?q=apple&q=banana&sortBy=price-desc&sortBy=newest&page=2&page=1",
      ),
    ).toBe("/search?q=banana");
    expect(
      canonicalizeStorefrontHtmlCachePath(
        "/categories/drinks?brand=Fresh&brand=Local&color=Red&color=Blue",
      ),
    ).toBe("/categories/drinks?brand=Local&color=Blue");
  });

  it("dedupes after canonicalization before applying the path cap", () => {
    const paths = [
      ...Array.from({ length: 25 }, (_, index) => `/products/fish?size=${index}`),
      "/products/phone",
    ];

    expect(normalizeStorefrontHtmlCachePaths(paths, 2)).toEqual([
      "/products/fish",
      "/products/phone",
    ]);
  });

  it("rejects absolute, protocol-relative, and empty paths", () => {
    expect(
      normalizeStorefrontHtmlCachePaths([
        "",
        "https://evil.example/products/fish",
        "//evil.example/products/fish",
        "/products/fish",
      ], 20),
    ).toEqual(["/products/fish"]);
  });
});
