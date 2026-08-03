import { describe, expect, it } from "vitest";

import {
  decoratePublicApiResponse,
  getPublicApiCachePolicy,
} from "./public-cache-policy";

describe("public API cache gateway policy", () => {
  it.each([
    ["/api/v1/products", ["products", "search", "product-schema"]],
    ["/api/v1/products/example", ["products", "search", "product-schema"]],
    ["/api/v1/storefront/homepage", ["homepage", "layout", "products", "categories", "collections"]],
    ["/api/v1/checkout/config", ["checkout"]],
  ])("allows declared anonymous reads for %s", (path, tags) => {
    const policy = getPublicApiCachePolicy(
      new Request(`https://api.example.com${path}`),
    );

    expect(policy?.tags).toEqual(tags);
    expect(policy?.edgeTtlSeconds).toBeGreaterThan(0);
  });

  it.each([
    ["POST", "/api/v1/products", {}],
    ["GET", "/api/v1/orders/status/status-token", {}],
    ["GET", "/api/v1/admin/products", {}],
    ["GET", "/api/v1/checkout/validate-cart", {}],
    ["GET", "/api/v1/products", { Cookie: "cs_tok=secret" }],
    ["GET", "/api/v1/products", { Authorization: "Bearer secret" }],
    ["GET", "/api/v1/products", { "X-API-Token": "secret" }],
  ])("keeps private or undeclared request %s %s off the cache lane", (method, path, headers) => {
    expect(
      getPublicApiCachePolicy(
        new Request(`https://api.example.com${path}`, { method, headers }),
      ),
    ).toBeNull();
  });

  it("gives Cloudflare an edge TTL and tags without extending browser freshness", () => {
    const policy = getPublicApiCachePolicy(
      new Request("https://api.example.com/api/v1/products"),
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
    expect(response.headers.get("Cache-Tag")).toBe(
      "products,search,product-schema",
    );
  });

  it("does not make an error or private response cacheable", () => {
    const policy = { edgeTtlSeconds: 60, tags: ["checkout"] };
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
