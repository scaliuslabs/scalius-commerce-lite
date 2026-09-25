import { describe, expect, it } from "vitest";

import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
  withCacheIdentity,
  withoutCacheIdentity,
} from "./public-cache-policy";
import { publicReadCacheKey } from "./public-read";

describe("public API cache policy", () => {
  it.each([
    "/api/v1/products",
    "/api/v1/products/fresh-hilsa",
    "/api/v1/categories/example/products",
    "/api/v1/collections/featured",
    "/api/v1/storefront/homepage",
    "/api/v1/storefront/layout",
    "/api/v1/categories",
    "/api/v1/storefront/pages/slug/about",
    "/api/v1/checkout/config",
    "/api/v1/hero/sliders?type=mobile",
  ])("caches the anonymous public read %s", (path) => {
    expect(getPublicApiCachePolicy(new Request(`https://api.example.com${path}`)))
      .toEqual({ canonicalUrl: `https://api.example.com${path}` });
  });

  it.each([
    ["POST", "/api/v1/products", {}],
    ["GET", "/api/v1/orders/status/status-token", {}],
    ["GET", "/api/v1/admin/products", {}],
    ["GET", "/api/v1/checkout/validate-cart", {}],
    ["GET", "/api/v1/customer-auth/me", {}],
    ["GET", "/api/v1/products", { Cookie: "cs_tok=secret" }],
    ["GET", "/api/v1/products", { Authorization: "Bearer secret" }],
    ["GET", "/api/v1/products", { "X-API-Token": "secret" }],
    ["GET", "/api/v1/hero/sliders", {}],
    ["GET", "/api/v1/hero/sliders?type=tablet", {}],
    ["GET", "/api/v1/products?__cg=forged", {}],
    ["GET", "/api/v1/products?__cv=forged", {}],
  ])("never caches %s %s", (method, path, headers) => {
    expect(
      getPublicApiCachePolicy(new Request(`https://api.example.com${path}`, { method, headers })),
    ).toBeNull();
  });

  it("rejects unbounded query-cardinality inputs", () => {
    const params = new URLSearchParams();
    for (let index = 0; index < 31; index += 1) params.set(`key${index}`, "value");
    expect(getPublicApiCachePolicy(new Request(`https://api.example.com/api/v1/pages?${params}`)))
      .toBeNull();
  });

  it("maps equivalent query orders to one canonical URL", () => {
    const canonical = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/pages?page=2&tag=sale"),
    );
    const permuted = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/pages?tag=sale&page=2"),
    );
    expect(canonical?.canonicalUrl).toBe("https://api.example.com/api/v1/pages?page=2&tag=sale");
    expect(permuted).toEqual(canonical);
  });

  it("puts the cache generation and Worker version in the cache key and removes both before the app", () => {
    const keyed = withCacheIdentity("https://api.example.com/api/v1/pages?page=2", "a1b2", "ver-1");
    expect(keyed).toBe("https://api.example.com/api/v1/pages?page=2&__cg=a1b2&__cv=ver-1");
    expect(withCacheIdentity("https://api.example.com/api/v1/pages?page=2", "c3d4", "ver-1")).not.toBe(keyed);
    expect(withCacheIdentity("https://api.example.com/api/v1/pages?page=2", "a1b2", "ver-2")).not.toBe(keyed);

    const appRequest = withoutCacheIdentity(new Request(keyed));
    expect(appRequest.url).toBe("https://api.example.com/api/v1/pages?page=2");
    expect(getPublicApiCachePolicy(appRequest)).not.toBeNull();
  });

  it("keys the same read at the same generation differently for different code", () => {
    // The lead's reproduction: a deploy changed the homepage payload shape
    // with no data write, so the generation stayed and the old payload was
    // served. The Worker version is what tells the two apart.
    const read = () => new Request("https://api.example.com/api/v1/storefront/homepage");
    const before = publicReadCacheKey(read(), { CF_VERSION_METADATA: { id: "ver-1" } }, "gen1");
    const after = publicReadCacheKey(read(), { CF_VERSION_METADATA: { id: "ver-2" } }, "gen1");

    expect(before).toBe("https://api.example.com/api/v1/storefront/homepage?__cg=gen1&__cv=ver-1");
    expect(after).not.toBe(before);
    expect(publicReadCacheKey(read(), { CF_VERSION_METADATA: { id: "ver-1" } }, "gen1")).toBe(before);
  });

  it("caches nothing without a generation or a Worker version", () => {
    const read = new Request("https://api.example.com/api/v1/products");
    expect(publicReadCacheKey(read, { CF_VERSION_METADATA: { id: "ver-1" } }, null)).toBeNull();
    expect(publicReadCacheKey(read, {}, "gen1")).toBeNull();
  });

  it("gives the edge a bounded lifetime without extending browser freshness", () => {
    const response = decoratePublicApiResponse(
      new Response("{}", { headers: { "Cache-Control": "public, max-age=0" } }),
    );
    expect(response.headers.get("Cache-Control")).toBe("public, max-age=0, no-cache, must-revalidate");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe("public, max-age=86400");
    expect(response.headers.has("Cache-Tag")).toBe(false);
  });

  it("does not make an error or private response cacheable", () => {
    const error = new Response("unavailable", { status: 503 });
    const privateResponse = new Response("{}", { headers: { "Cache-Control": "private, no-store" } });
    expect(decoratePublicApiResponse(error)).toBe(error);
    expect(decoratePublicApiResponse(privateResponse)).toBe(privateResponse);
  });
});
