import { describe, expect, it } from "vitest";
import {
  isValidCanonicalPath,
  normalizeCanonicalPath,
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
});
