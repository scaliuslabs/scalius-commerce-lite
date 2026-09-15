import { describe, expect, it, vi } from "vitest";

import {
  applyPublicStorefrontPreconnectHint,
  decoratePublicStorefrontResponse,
  exposePublicStorefrontResponse,
  getPublicStorefrontCachePolicy,
  normalizePublicStorefrontCacheTags,
  recoverCurrentStorefrontBuild,
  responseHasStorefrontBuild,
  warmPublicStorefrontCache,
} from "./public-worker-cache";

describe("public storefront Worker cache policy", () => {
  it("adds only a stable HTTPS CDN preconnect candidate", () => {
    const response = new Response("page", {
      headers: { Link: "</_astro/app.js>; rel=preload; as=script" },
    });

    applyPublicStorefrontPreconnectHint(response, "cloud.example.com/media");
    applyPublicStorefrontPreconnectHint(response, "https://cloud.example.com");

    expect(response.headers.get("Link")).toBe(
      "</_astro/app.js>; rel=preload; as=script, <https://cloud.example.com>; rel=preconnect; crossorigin",
    );
  });

  it.each([
    "http://cloud.example.com",
    "https://user:secret@cloud.example.com",
    "not a host",
    "",
  ])("rejects unsafe Early Hints origin %j", (configuredCdnUrl) => {
    const response = new Response("page");
    applyPublicStorefrontPreconnectHint(response, configuredCdnUrl);
    expect(response.headers.get("Link")).toBeNull();
  });

  it("maps equivalent CMS query forms to one native cache URL", () => {
    const left = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about/?ref=footer&campaign=sale"),
    );
    const right = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/about?campaign=sale&ref=footer"),
    );

    expect(left).toMatchObject({
      canonicalUrl: "https://shop.example/about?campaign=sale",
      edgeTtlSeconds: 365 * 86_400,
      tags: ["pages", "products", "layout", "media"],
    });
    expect(right?.canonicalUrl).toBe(left?.canonicalUrl);
  });

  it.each([
    ["https://shop.example", "https://shop.example/products/fish"],
    ["https://preview.example", "https://preview.example/products/fish"],
  ])("retains the request host in the canonical inner request for %s", (origin, canonicalUrl) => {
    expect(getPublicStorefrontCachePolicy(
      new Request(`${origin}/products/fish`),
    )?.canonicalUrl).toBe(canonicalUrl);
  });

  it.each([
    ["checkout", "/checkout", {}],
    ["recovery", "/payment-recovery", {}],
    ["cookie", "/about", { Cookie: "_fbp=fb.1.1; cs_tok=private" }],
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
        has: (name: string) => normalizedHeaders.has(name.toLowerCase()),
      },
    } as unknown as Request;

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
  ])("keeps availability-bearing public route %s resident for the one-year edge maximum", (path, tags) => {
    const policy = getPublicStorefrontCachePolicy(
      new Request(`https://shop.example${path}`),
    );
    expect(policy?.edgeTtlSeconds).toBe(365 * 86_400);
    expect(policy?.tags).toEqual(tags);
  });

  it.each([
    ["/robots.txt", ["discovery", "products", "categories", "collections", "pages", "layout"]],
    ["/llms.txt", ["discovery"]],
    ["/sitemap.xml", ["discovery", "products", "categories", "collections", "pages", "layout"]],
    ["/blog/feed.xml", ["pages", "products", "discovery"]],
    ["/.well-known/ucp", ["discovery", "products", "layout"]],
  ])("keeps mutation-purged content route %s resident for the one-year edge maximum", (path, tags) => {
    const policy = getPublicStorefrontCachePolicy(
      new Request(`https://shop.example${path}`),
    );
    expect(policy?.edgeTtlSeconds).toBe(365 * 86_400);
    expect(policy?.tags).toEqual(tags);
  });

  it("keeps tracking-cookie visitors on the shared cache lane", () => {
    const policy = getPublicStorefrontCachePolicy(
      new Request("https://shop.example/products/fish", {
        headers: { Cookie: "_fbp=fb.1.1; _fbc=fb.1.2.abc; _ga=GA1.1; scalius_gclid=x" },
      }),
    );
    expect(policy?.canonicalUrl).toBe("https://shop.example/products/fish");
  });

  it("re-renders the homepage through the cache-enabled entrypoint after a purge", async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.url).toBe("https://shop.example/");
      expect(request.headers.has("Cookie")).toBe(false);
      return new Response("<html/>", { headers: { "Content-Type": "text/html" } });
    });
    await warmPublicStorefrontCache("https://shop.example", { fetch }, { delaysMs: [0] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("warms again after the purge propagation delays", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async () => new Response("<html/>"));
      const warm = warmPublicStorefrontCache("https://shop.example", { fetch });
      expect(fetch).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(4_000);
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(fetch).toHaveBeenCalledTimes(2);
      await warm;
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips warm-up paths that are not public cache candidates and swallows failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetch = vi.fn(async () => {
      throw new Error("render failed");
    });
    await warmPublicStorefrontCache(
      "https://shop.example",
      { fetch },
      { paths: ["/checkout", "/"], delaysMs: [0] },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
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
      `public, max-age=${365 * 86_400}, must-revalidate`,
    );
    expect(response.headers.get("Cache-Tag")).toBe(
      "pages,products,layout,media",
    );
  });

  it("keeps native cache directives inside the cache-enabled entrypoint", () => {
    const response = exposePublicStorefrontResponse(
      new Response("page", {
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Cloudflare-CDN-Cache-Control": "public, max-age=86400",
          "Cache-Tag": "products,layout",
          "X-Cache-Status": "NATIVE",
        },
      }),
    );

    expect(response.headers.get("Cloudflare-CDN-Cache-Control")).toBeNull();
    expect(response.headers.get("Cache-Tag")).toBeNull();
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("X-Cache-Status")).toBe("NATIVE");
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

  it("detects a response produced by a superseded storefront build", () => {
    expect(responseHasStorefrontBuild(
      new Response("current", {
        headers: { "X-Storefront-Build": "src-current" },
      }),
      "src-current",
    )).toBe(true);
    expect(responseHasStorefrontBuild(
      new Response("old", {
        headers: { "X-Storefront-Build": "src-old" },
      }),
      "src-current",
    )).toBe(false);
    expect(responseHasStorefrontBuild(new Response("unstamped"), "src-current"))
      .toBe(false);
  });

  it("purges once, retries once, then renders directly on a repeated build mismatch", async () => {
    const purge = vi.fn(async () => undefined);
    const refetch = vi.fn(async () =>
      new Response("still stale", {
        headers: { "X-Storefront-Build": "src-old" },
      }),
    );
    const renderDirect = vi.fn(async () =>
      new Response("current direct", {
        headers: { "X-Storefront-Build": "src-current" },
      }),
    );

    const response = await recoverCurrentStorefrontBuild({
      response: new Response("stale", {
        headers: { "X-Storefront-Build": "src-old" },
      }),
      expectedBuildId: "src-current",
      purge,
      refetch,
      renderDirect,
    });

    expect(purge).toHaveBeenCalledOnce();
    expect(refetch).toHaveBeenCalledOnce();
    expect(renderDirect).toHaveBeenCalledOnce();
    await expect(response.text()).resolves.toBe("current direct");
  });
});
