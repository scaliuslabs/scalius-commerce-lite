import { describe, expect, it } from "vitest";

import {
  applyBrowserCachePolicyForPublicResponse,
  getPublicDiscoveryCacheControl,
  isSuccessfulPublicDiscoveryResponse,
} from "./public-discovery-cache";

describe("public discovery cache policy", () => {
  it("requires browser revalidation for generated discovery assets", () => {
    expect(getPublicDiscoveryCacheControl("/robots.txt")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap.xml")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap-products.xml")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/api/product-feed.xml")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/api/facebook-feed.xml")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/sitemap.xsl")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(getPublicDiscoveryCacheControl("/llms.txt")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
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
      "public, max-age=0, no-cache, must-revalidate",
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

  it("recognizes only successful public discovery responses", () => {
    const sitemapResponse = new Response("<urlset />", {
      status: 200,
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Set-Cookie": "astro=unused",
      },
    });
    const unavailableResponse = new Response("unavailable", {
      status: 503,
      headers: { "Content-Type": "application/xml; charset=utf-8" },
    });
    const htmlResponse = new Response("<html></html>", {
      status: 200,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });

    expect(isSuccessfulPublicDiscoveryResponse(sitemapResponse, "/sitemap-products.xml")).toBe(true);
    expect(isSuccessfulPublicDiscoveryResponse(unavailableResponse, "/sitemap-products.xml")).toBe(false);
    expect(isSuccessfulPublicDiscoveryResponse(htmlResponse, "/products/fish")).toBe(false);

    applyBrowserCachePolicyForPublicResponse(sitemapResponse, "/sitemap-products.xml");
    expect(sitemapResponse.headers.get("Cache-Control")).toBe(
      "public, max-age=0, no-cache, must-revalidate",
    );
    expect(sitemapResponse.headers.has("Set-Cookie")).toBe(false);
  });
});
