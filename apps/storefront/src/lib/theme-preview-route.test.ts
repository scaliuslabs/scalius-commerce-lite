import { describe, expect, it } from "vitest";

import {
  createThemePreviewDeviceUrl,
  normalizeThemePreviewDashboardOrigin,
  normalizeThemePreviewDevice,
  normalizeThemePreviewRoutePath,
} from "./theme-preview-route";

describe("theme preview route selection", () => {
  it("keeps real public routes and harmless search state", () => {
    expect(normalizeThemePreviewRoutePath("/products/quiet-keyboard")).toBe(
      "/products/quiet-keyboard",
    );
    expect(normalizeThemePreviewRoutePath("/search?q=keyboard")).toBe(
      "/search?q=keyboard",
    );
    expect(normalizeThemePreviewRoutePath("/categories/home-living?page=2")).toBe(
      "/categories/home-living?page=2",
    );
    expect(normalizeThemePreviewRoutePath("/about-us")).toBe("/about-us");
  });

  it("fails unsafe, private, recursive, and discovery paths back to home", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/",
      "/checkout",
      "/account/orders",
      "/api/product-feed.xml",
      "/theme-preview",
      "/sitemap-products.xml",
      "/ucp/catalog/search",
      "/products/too/deep",
      "/products/encoded%2Fsegment",
      "/about-us/more",
      "/products/x#token",
      "/products\\x",
    ]) {
      expect(normalizeThemePreviewRoutePath(value)).toBe("/");
    }
  });

  it("keeps the device vocabulary bounded", () => {
    expect(normalizeThemePreviewDevice("desktop")).toBe("desktop");
    expect(normalizeThemePreviewDevice("mobile")).toBe("mobile");
    expect(normalizeThemePreviewDevice("tablet")).toBe("full");
  });

  it("updates only the addressable preview device", () => {
    expect(
      createThemePreviewDeviceUrl(
        "https://storefront.example.test/theme-preview?path=%2Fsearch%3Fq%3Dlamp&device=desktop",
        "mobile",
      ),
    ).toBe(
      "https://storefront.example.test/theme-preview?path=%2Fsearch%3Fq%3Dlamp&device=mobile",
    );
    expect(
      createThemePreviewDeviceUrl(
        "https://storefront.example.test/theme-preview?path=%2Fproducts%2Flamp",
        "tablet",
      ),
    ).toBe(
      "https://storefront.example.test/theme-preview?path=%2Fproducts%2Flamp&device=full",
    );
  });

  it("accepts one explicit http(s) dashboard origin and strips paths", () => {
    expect(
      normalizeThemePreviewDashboardOrigin("https://dashboard.example.test/admin"),
    ).toBe("https://dashboard.example.test");
    expect(normalizeThemePreviewDashboardOrigin("javascript:alert(1)")).toBe("");
    expect(
      normalizeThemePreviewDashboardOrigin("https://user:secret@dashboard.example.test"),
    ).toBe("");
  });
});
