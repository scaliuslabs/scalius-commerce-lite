import { describe, expect, it } from "vitest";

import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
  normalizePublicApiCacheTags,
} from "./public-cache-policy";

describe("public API cache gateway policy", () => {
  it.each([
    ["/api/v1/products", ["products", "search", "discovery"]],
    ["/api/v1/products/fresh-hilsa", ["products", "search", "discovery"]],
    ["/api/v1/categories/example/products", ["categories", "products", "search"]],
    ["/api/v1/collections/featured", ["collections", "products", "search"]],
    ["/api/v1/storefront/homepage", ["homepage", "products", "categories", "collections"]],
    ["/api/v1/categories", ["categories"]],
    ["/api/v1/categories/example", ["categories"]],
    ["/api/v1/storefront/pages/slug/about", ["pages", "layout"]],
    ["/api/v1/checkout/config", ["checkout"]],
  ])("allows declared anonymous reads for %s", (path, tags) => {
    const policy = getPublicApiCachePolicy(
      new Request(`https://api.example.com${path}`),
    );

    expect(policy?.tags).toEqual(tags);
    expect(policy?.edgeTtlSeconds).toBeGreaterThan(0);
    expect(policy?.cacheKey).toBe(path);
  });

  it.each([
    ["POST", "/api/v1/products", {}],
    ["GET", "/api/v1/orders/status/status-token", {}],
    ["GET", "/api/v1/admin/products", {}],
    ["GET", "/api/v1/checkout/validate-cart", {}],
    ["GET", "/api/v1/products", { Cookie: "cs_tok=secret" }],
    ["GET", "/api/v1/products", { Authorization: "Bearer secret" }],
    ["GET", "/api/v1/products", { "X-API-Token": "secret" }],
    ["GET", "/api/v1/hero/sliders", {}],
    ["GET", "/api/v1/hero/sliders?type=tablet", {}],
  ])("keeps private or undeclared request %s %s off the cache lane", (method, path, headers) => {
    expect(
      getPublicApiCachePolicy(
        new Request(`https://api.example.com${path}`, { method, headers }),
      ),
    ).toBeNull();
  });

  it("caches only explicit device-specific hero projections", () => {
    expect(
      getPublicApiCachePolicy(
        new Request("https://api.example.com/api/v1/hero/sliders?type=mobile"),
      )?.tags,
    ).toEqual(["homepage"]);
  });

  it.each([
    "/api/v1/products",
    "/api/v1/products/fresh-hilsa",
    "/api/v1/categories/fish/products",
    "/api/v1/collections/featured",
    "/api/v1/storefront/homepage",
  ])("bounds availability-bearing %s responses to five seconds", (path) => {
    expect(
      getPublicApiCachePolicy(
        new Request(`https://api.example.com${path}`),
      )?.edgeTtlSeconds,
    ).toBe(5);
  });

  it("rejects unbounded query-cardinality inputs", () => {
    const params = new URLSearchParams();
    for (let index = 0; index < 31; index += 1) {
      params.set(`key${index}`, "value");
    }

    expect(
      getPublicApiCachePolicy(
        new Request(`https://api.example.com/api/v1/pages?${params}`),
      ),
    ).toBeNull();
  });

  it("gives Cloudflare an edge TTL and tags without extending browser freshness", () => {
    const policy = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/categories"),
    );
    expect(policy).not.toBeNull();

    const response = decoratePublicApiResponse(
      new Response("{}", {
        headers: {
          "Cache-Control": "public, max-age=0, no-cache, must-revalidate",
        },
      }),
      policy!,
    );

    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
      "public, max-age=3600, must-revalidate",
    );
    expect(response.headers.get("Cache-Tag")).toBe("categories");
  });

  it("canonicalizes query order and trailing slashes for one edge key", () => {
    const left = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/pages/?tag=sale&page=2"),
    );
    const right = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/pages?page=2&tag=sale"),
    );

    expect(left?.cacheKey).toBe("/api/v1/pages?page=2&tag=sale");
    expect(right?.cacheKey).toBe(left?.cacheKey);
  });

  it("accepts only cache tags owned by the public API lane", () => {
    expect(
      normalizePublicApiCacheTags([
        "layout",
        "private-orders",
        "layout",
        "checkout",
      ]),
    ).toEqual(["layout", "checkout"]);
  });

  it("does not make an error or private response cacheable", () => {
    const policy = {
      cacheKey: "/api/v1/checkout/config",
      edgeTtlSeconds: 60,
      tags: ["checkout"],
    };
    const error = new Response("unavailable", { status: 503 });
    const privateResponse = new Response("{}", {
      headers: { "Cache-Control": "private, no-store" },
    });

    expect(decoratePublicApiResponse(error, policy)).toBe(error);
    expect(decoratePublicApiResponse(privateResponse, policy)).toBe(
      privateResponse,
    );
  });
});
