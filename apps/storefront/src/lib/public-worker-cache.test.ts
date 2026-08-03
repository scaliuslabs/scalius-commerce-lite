import { describe, expect, it } from "vitest";

import {
  decoratePublicStorefrontResponse,
  getPublicStorefrontCachePolicy,
  normalizePublicStorefrontCacheTags,
} from "./public-worker-cache";

describe("public storefront Worker cache policy", () => {
  it("allows anonymous CMS pages with deterministic query keys", () => {
    const left = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about/?ref=footer&campaign=sale"),
    );
    const right = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about?campaign=sale&ref=footer"),
    );

    expect(left).toMatchObject({
      cacheKey: "/about?campaign=sale",
      tags: ["pages", "products", "layout", "media"],
    });
    expect(right?.cacheKey).toBe(left?.cacheKey);
  });

  it.each([
    ["checkout", "/checkout", {}],
    ["recovery", "/payment-recovery", {}],
    ["cookie", "/about", { Cookie: "session=private" }],
    ["authorization", "/about", { Authorization: "Bearer private" }],
  ])("keeps $0 request off the cache lane", (_label, path, headers) => {
    const normalizedHeaders = new Map(
      Object.entries(headers).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    );
    const request = {
      method: "GET",
      url: `https://shop.example${path}`,
      headers: {
        get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
      },
    } as Request;

    expect(
      getPublicStorefrontCachePolicy(request),
    ).toBeNull();
  });

  it.each([
    ["/", ["homepage", "layout", "media", "products"]],
    ["/products/fish", ["products", "product-schema", "layout", "media"]],
    ["/categories/fish", ["categories", "products", "layout", "media"]],
    ["/collections/featured", ["collections", "products", "layout", "media"]],
    ["/search?q=fish", ["search", "products", "layout", "media"]],
    ["/blog/news", ["pages", "products", "layout", "media"]],
    ["/api/product-feed.xml", ["discovery", "products", "layout", "media"]],
  ])("caches anonymous public route %s for five seconds", (path, tags) => {
    const policy = getPublicStorefrontCachePolicy(
      new Request(`https://shop.example${path}`),
    );
    expect(policy?.edgeTtlSeconds).toBe(5);
    expect(policy?.tags).toEqual(tags);
  });

  it("keeps product variant-specific HTML off the shared cache lane", () => {
    expect(
      getPublicStorefrontCachePolicy(
        new Request("https://shop.example/products/fish?size=large"),
      ),
    ).toBeNull();
  });

  it("adds edge-only caching metadata to successful public responses", () => {
    const policy = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about"),
    )!;
    const response = decoratePublicStorefrontResponse(
      new Response("page", {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "X-Cache-Status": "NATIVE",
        },
      }),
      policy,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
      "public, max-age=5, must-revalidate",
    );
    expect(response.headers.get("Cache-Tag")).toBe(
      "pages,products,layout,media",
    );
  });

  it("does not cache a no-store response that failed the inner public gate", () => {
    const policy = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about"),
    )!;
    const response = new Response("private", {
      headers: { "Cache-Control": "private, no-store" },
    });

    expect(decoratePublicStorefrontResponse(response, policy)).toBe(response);
  });

  it("filters purge tags to the storefront lane's owned groups", () => {
    expect(
      normalizePublicStorefrontCacheTags([
        "pages",
        "products",
        "layout",
        "pages",
      ]),
    ).toEqual(["pages", "products", "layout"]);
  });
});
