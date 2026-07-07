import { describe, expect, it } from "vitest";
import {
  normalizeCatalogDiscoveryBaseUrl,
  resolveCatalogDiscoveryImageUrl,
} from "./catalog-discovery-media";

describe("catalog discovery media helpers", () => {
  it("normalizes absolute http(s) storefront origins only", () => {
    expect(normalizeCatalogDiscoveryBaseUrl("https://shop.example.com/")).toBe(
      "https://shop.example.com",
    );
    expect(normalizeCatalogDiscoveryBaseUrl("http://shop.example.com")).toBe(
      "http://shop.example.com",
    );
    expect(normalizeCatalogDiscoveryBaseUrl("/relative")).toBeNull();
    expect(normalizeCatalogDiscoveryBaseUrl("https://shop.example.com/base")).toBeNull();
    expect(normalizeCatalogDiscoveryBaseUrl("https://shop.example.com?preview=1")).toBeNull();
    expect(normalizeCatalogDiscoveryBaseUrl("ftp://shop.example.com")).toBeNull();
  });

  it("resolves catalog image URLs to absolute http(s) URLs", () => {
    expect(
      resolveCatalogDiscoveryImageUrl("/products/fish.jpg", "https://shop.example.com"),
    ).toBe("https://shop.example.com/products/fish.jpg");
    expect(
      resolveCatalogDiscoveryImageUrl(
        "https://cdn.example.com/products/fish.jpg",
        "https://shop.example.com",
      ),
    ).toBe("https://cdn.example.com/products/fish.jpg");
  });

  it("validates transformed image URLs after optimization", () => {
    expect(
      resolveCatalogDiscoveryImageUrl("/products/fish.jpg", "https://shop.example.com", {
        transformImageUrl: () => "/cdn-cgi/image/width=1200/products/fish.jpg",
      }),
    ).toBe("https://shop.example.com/cdn-cgi/image/width=1200/products/fish.jpg");
    expect(
      resolveCatalogDiscoveryImageUrl("/products/fish.jpg", "https://shop.example.com", {
        transformImageUrl: () => "",
      }),
    ).toBeNull();
  });

  it("rejects unsafe or non-http image sources", () => {
    for (const value of [
      "",
      "   ",
      "data:image/svg+xml,%3Csvg%3E",
      "javascript:alert(1)",
      "ftp://cdn.example.com/fish.jpg",
      "//cdn.example.com/fish.jpg",
      "products\\fish.jpg",
      "products/\u0000fish.jpg",
    ]) {
      expect(resolveCatalogDiscoveryImageUrl(value, "https://shop.example.com")).toBeNull();
    }
  });
});
