import { describe, expect, it } from "vitest";
import {
  isValidCanonicalPath,
  isValidResourceCanonicalPath,
  normalizeCanonicalPath,
  normalizeResourceCanonicalPath,
} from "./seo-canonical";

describe("SEO canonical path helpers", () => {
  it("normalizes clean same-store canonical paths", () => {
    expect(normalizeCanonicalPath(" /products/main-shoe ")).toBe(
      "/products/main-shoe",
    );
    expect(normalizeCanonicalPath("/")).toBe("/");
  });

  it("treats blank values as no override", () => {
    expect(normalizeCanonicalPath(" ")).toBeNull();
    expect(normalizeCanonicalPath(null)).toBeNull();
  });

  it("rejects absolute, protocol-relative, query, fragment, and unsafe paths", () => {
    for (const value of [
      "https://shop.example.com/products/main-shoe",
      "//shop.example.com/products/main-shoe",
      "/products/main-shoe?variant=red",
      "/products/main-shoe#details",
      "/products/main shoe",
      "/products\\main-shoe",
    ]) {
      expect(isValidCanonicalPath(value), value).toBe(false);
      expect(normalizeCanonicalPath(value), value).toBeNull();
    }
  });

  it("validates resource canonical paths against reachable route shapes", () => {
    expect(isValidResourceCanonicalPath("product", "/products/main-shoe")).toBe(
      true,
    );
    expect(
      isValidResourceCanonicalPath("category", "/categories/summer-shoes"),
    ).toBe(true);
    expect(
      isValidResourceCanonicalPath("collection", "/collections/summer-edit"),
    ).toBe(true);
    expect(
      isValidResourceCanonicalPath(
        "collection",
        "/collections/V1StGXR8_Z5jdHi6B-myT",
      ),
    ).toBe(true);
    expect(isValidResourceCanonicalPath("page", "/returns")).toBe(true);

    expect(isValidResourceCanonicalPath("product", "/fish/hilsa")).toBe(false);
    expect(isValidResourceCanonicalPath("product", "/shop/linen-shirt")).toBe(
      false,
    );
    expect(
      isValidResourceCanonicalPath("category", "/categories/summer/sale"),
    ).toBe(false);
    expect(isValidResourceCanonicalPath("collection", "/collections")).toBe(
      false,
    );
    expect(isValidResourceCanonicalPath("page", "/company/about")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/products")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/health")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/order-success")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/payment-recovery")).toBe(false);
    expect(isValidResourceCanonicalPath("page", "/sitemap.xml")).toBe(false);
  });

  it("normalizes blank resource canonical paths while rejecting non-routable overrides", () => {
    expect(
      normalizeResourceCanonicalPath("product", " /products/main-shoe "),
    ).toBe("/products/main-shoe");
    expect(normalizeResourceCanonicalPath("product", " ")).toBeNull();
    expect(
      normalizeResourceCanonicalPath("product", "/shop/main-shoe"),
    ).toBeNull();
  });
});
