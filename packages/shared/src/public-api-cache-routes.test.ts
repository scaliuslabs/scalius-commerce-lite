import { describe, expect, it } from "vitest";
import {
  MAX_STOREFRONT_BATCH_PARTS,
  isPublicApiCacheRoute,
  parseStorefrontBatchParts,
  storefrontBatchPart,
  storefrontBatchPath,
} from "./public-api-cache-routes";

const origin = "https://api.internal";
const url = (path: string) => new URL(path, origin);

describe("public API cache routes", () => {
  it("accepts the storefront's cached reads and nothing private", () => {
    expect(isPublicApiCacheRoute(url("/api/v1/storefront/layout"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/products/linen-shirt"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/checkout/config"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/hero/sliders?type=mobile"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/hero/sliders?type=tablet"))).toBe(false);
    expect(isPublicApiCacheRoute(url("/api/v1/storefront/layout/extra"))).toBe(false);
    expect(isPublicApiCacheRoute(url("/api/v1/orders/receipt/order_1"))).toBe(false);
    expect(isPublicApiCacheRoute(url("/api/v1/admin/products"))).toBe(false);
    // The active checkout copy (cart and checkout) is one fixed entry.
    expect(isPublicApiCacheRoute(url("/api/v1/checkout-languages/active"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/checkout-languages/active?x=1"))).toBe(false);
    expect(isPublicApiCacheRoute(url("/api/v1/checkout-languages"))).toBe(false);
    expect(isPublicApiCacheRoute(url(`/api/v1/products?q=${"x".repeat(513)}`))).toBe(false);
    // The homepage read is one fixed entry: a query string never reaches the cache.
    expect(isPublicApiCacheRoute(url("/api/v1/storefront/homepage"))).toBe(true);
    expect(isPublicApiCacheRoute(url("/api/v1/storefront/homepage?product=36~newest"))).toBe(false);
    expect(isPublicApiCacheRoute(url("/api/v1/storefront/homepage?utm_source=x"))).toBe(false);
  });
});

describe("storefront read batch", () => {
  it("round-trips parts in order through the batch URL", () => {
    const parts = [
      storefrontBatchPart(url("/api/v1/storefront/layout"))!,
      storefrontBatchPart(url("/api/v1/categories/bags/products?page=2&sort=newest"))!,
    ];
    const batch = url(storefrontBatchPath(parts));

    expect(parseStorefrontBatchParts(batch)?.map((part) => `${part.pathname}${part.search}`)).toEqual([
      "/api/v1/storefront/layout",
      "/api/v1/categories/bags/products?page=2&sort=newest",
    ]);
  });

  it("carries only public cached reads", () => {
    expect(storefrontBatchPart(url("/api/v1/orders/status/cst_x"))).toBeNull();
    expect(parseStorefrontBatchParts(url(storefrontBatchPath(["/api/v1/admin/orders"])))).toBeNull();
    expect(parseStorefrontBatchParts(url(storefrontBatchPath(["/api/v1/products/../admin/orders"])))).toBeNull();
    expect(parseStorefrontBatchParts(url(storefrontBatchPath(["https://evil.test/api/v1/products"])))).toBeNull();
    expect(parseStorefrontBatchParts(url(storefrontBatchPath(["//evil.test/api/v1/products"])))).toBeNull();
    expect(parseStorefrontBatchParts(url(`${storefrontBatchPath(["/api/v1/products"])}&cookie=1`))).toBeNull();
  });

  it("bounds the number of parts", () => {
    const parts = Array.from({ length: MAX_STOREFRONT_BATCH_PARTS + 1 }, (_, index) => `/api/v1/products/p${index}`);

    expect(parseStorefrontBatchParts(url(storefrontBatchPath(parts)))).toBeNull();
    expect(parseStorefrontBatchParts(url(storefrontBatchPath(parts.slice(1))))).toHaveLength(MAX_STOREFRONT_BATCH_PARTS);
    expect(parseStorefrontBatchParts(url("/api/v1/storefront/batch"))).toBeNull();
  });
});
