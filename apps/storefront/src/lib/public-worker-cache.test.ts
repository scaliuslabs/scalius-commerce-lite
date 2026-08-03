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
      cacheKey: "/about?campaign=sale&ref=footer",
      tags: ["pages", "layout"],
    });
    expect(right?.cacheKey).toBe(left?.cacheKey);
  });

  it.each([
    ["home", "/", {}],
    ["product", "/products/fish", {}],
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

  it("adds edge-only caching metadata to successful public responses", () => {
    const policy = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about"),
    )!;
    const response = decoratePublicStorefrontResponse(
      new Response("page", {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "X-Cache-Status": "MISS; v=1; build=test",
        },
      }),
      policy,
    );

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBe(
      "public, max-age=3600, must-revalidate",
    );
    expect(response.headers.get("Cache-Tag")).toBe("pages,layout");
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
    ).toEqual(["pages", "layout"]);
  });
});
