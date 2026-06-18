import { describe, expect, it } from "vitest";

import { resolveCacheNamespace } from "./cache-namespace";

describe("resolveCacheNamespace", () => {
  it("keeps localhost namespaces local for development", () => {
    expect(
      resolveCacheNamespace(
        { STOREFRONT_URL: "https://storefront.example.com" },
        "localhost",
      ),
    ).toBe("localhost");
  });

  it("uses the configured storefront hostname for production requests", () => {
    expect(
      resolveCacheNamespace(
        { STOREFRONT_URL: "https://storefront.example.com" },
        "www.example.com",
      ),
    ).toBe("storefront.example.com");
  });

  it("lets an explicit cache namespace override storefront URL", () => {
    expect(
      resolveCacheNamespace(
        {
          CACHE_NAMESPACE: "merchant-primary.example.com",
          STOREFRONT_URL: "https://storefront.example.com",
        },
        "www.example.com",
      ),
    ).toBe("merchant-primary.example.com");
  });
});
