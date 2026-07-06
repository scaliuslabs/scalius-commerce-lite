import { describe, expect, it } from "vitest";

import {
  applyBrowserCachePolicyForPublicResponse,
  getPublicDiscoveryCacheControl,
} from "./public-discovery-cache";

describe("public discovery cache policy", () => {
  it("preserves public browser caching for generated discovery assets", () => {
    expect(getPublicDiscoveryCacheControl("/robots.txt")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap.xml")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap-products.xml")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(getPublicDiscoveryCacheControl("/api/facebook-feed.xml")).toBe(
      "public, max-age=3600, stale-while-revalidate=43200",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap.xsl")).toBe(
      "public, max-age=86400, stale-while-revalidate=604800",
    );
  });

  it("keeps HTML responses in the browser revalidation lane", () => {
    expect(getPublicDiscoveryCacheControl("/products/fish")).toBeNull();
    expect(getPublicDiscoveryCacheControl("/")).toBeNull();
  });

  it("removes no-store headers only for discovery assets", () => {
    const discoveryResponse = new Response("ok", {
      headers: {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });

    applyBrowserCachePolicyForPublicResponse(
      discoveryResponse,
      "/sitemap.xml",
    );

    expect(discoveryResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=3600, stale-while-revalidate=86400",
    );
    expect(discoveryResponse.headers.has("Pragma")).toBe(false);
    expect(discoveryResponse.headers.has("Expires")).toBe(false);

    const htmlResponse = new Response("ok");
    applyBrowserCachePolicyForPublicResponse(htmlResponse, "/products/fish");
    expect(htmlResponse.headers.get("Cache-Control")).toBe(
      "no-cache, no-store, must-revalidate",
    );
    expect(htmlResponse.headers.get("Pragma")).toBe("no-cache");
    expect(htmlResponse.headers.get("Expires")).toBe("0");
  });
});
