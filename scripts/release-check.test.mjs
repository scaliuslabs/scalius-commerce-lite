import { describe, expect, it } from "vitest";

import {
  evaluateDiscoveryCacheHeaders,
  evaluateFeedContinuationLink,
  evaluateRequiredDocs,
  evaluateUcpProfile,
  normalizeHttpBaseUrl,
  parseReleaseCheckArgs,
  requestHeaders,
  shouldRetryFeedGeneration,
} from "./release-check.mjs";

function catalogOnlyUcpProfile() {
  const version = "2026-01";
  return {
    ucp: {
      version,
      services: {
        "dev.ucp.shopping": [
          {
            version,
            transport: "rest",
            endpoint: "https://storefront.example.test/ucp",
            spec: `https://ucp.dev/${version}/specification/overview`,
            schema: `https://ucp.dev/${version}/services/shopping/rest.openapi.json`,
          },
        ],
      },
      capabilities: {
        "dev.ucp.shopping.catalog.search": [
          {
            version,
            spec: `https://ucp.dev/${version}/specification/catalog/search`,
            schema: `https://ucp.dev/${version}/schemas/shopping/catalog_search.json`,
          },
        ],
        "dev.ucp.shopping.catalog.lookup": [
          {
            version,
            spec: `https://ucp.dev/${version}/specification/catalog/lookup`,
            schema: `https://ucp.dev/${version}/schemas/shopping/catalog_lookup.json`,
          },
        ],
      },
      supported_versions: {
        [version]: "https://storefront.example.test/.well-known/ucp",
      },
    },
  };
}

describe("release check arguments", () => {
  it("can inspect normal cache behavior without requesting a bypass", () => {
    expect(requestHeaders("application/xml")).toEqual({
      Accept: "application/xml",
      "Cache-Control": "no-cache",
    });
    expect(requestHeaders("application/xml", { bypassCache: false })).toEqual({
      Accept: "application/xml",
    });
  });

  it("retries only the cold feed-generation transition state", () => {
    expect(shouldRetryFeedGeneration({
      ok: false,
      cacheStatus: "BYPASS_GENERATION",
    })).toBe(true);
    expect(shouldRetryFeedGeneration({
      ok: false,
      cacheStatus: "MISS; v=1; build=x",
    })).toBe(false);
    expect(shouldRetryFeedGeneration({
      ok: true,
      cacheStatus: "HIT; v=1; build=x; gen=0",
    })).toBe(false);
  });

  it("normalizes explicit URLs and operational flags", () => {
    expect(parseReleaseCheckArgs([
      "--api-base-url", "https://api.example.test/",
      "--storefront-url", "https://storefront.example.test/",
      "--dashboard-url", "https://dashboard.example.test/",
      "--timeout-ms", "5000",
      "--skip-live",
      "--skip-wrangler",
    ])).toMatchObject({
      apiBaseUrl: "https://api.example.test",
      storefrontUrl: "https://storefront.example.test",
      dashboardUrl: "https://dashboard.example.test",
      timeoutMs: 5000,
      skipLive: true,
      skipWrangler: true,
    });
  });

  it("rejects credentialed and non-http URLs", () => {
    expect(() => normalizeHttpBaseUrl("https://user:pass@example.test"))
      .toThrow("must not include credentials");
    expect(() => normalizeHttpBaseUrl("file:///tmp/store"))
      .toThrow("must use http or https");
  });
});

describe("release documentation gate", () => {
  it("checks the current operations and architecture documents", () => {
    const seen = [];
    const result = evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl(path) {
        seen.push(path);
        return true;
      },
    });

    expect(result).toEqual({ ok: true, checkedFiles: 7, missing: [] });
    expect(seen).toEqual(expect.arrayContaining([
      "/repo/audit/README.md",
      "/repo/audit/OPERATIONAL_RUNBOOK.md",
      "/repo/docs/codex/PLATFORM-GOAL.md",
      "/repo/docs/ARCHITECTURE.md",
    ]));
  });

  it("reports missing required files", () => {
    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      required: ["README.md", "audit/README.md"],
      fileExistsImpl: (path) => path.endsWith("README.md") && !path.includes("audit/"),
    })).toEqual({
      ok: false,
      checkedFiles: 2,
      missing: ["audit/README.md"],
    });
  });
});

describe("release discovery policy", () => {
  it("accepts public cache headers with a positive TTL", () => {
    expect(evaluateDiscoveryCacheHeaders(
      new Headers({ "Cache-Control": "public, max-age=60" }),
    )).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts only the catalog search and lookup UCP capabilities", () => {
    const profile = catalogOnlyUcpProfile();
    expect(evaluateUcpProfile(profile, {
      storefrontOrigin: "https://storefront.example.test",
    })).toMatchObject({
      ok: true,
      endpoint: "https://storefront.example.test/ucp",
      capabilities: [
        "dev.ucp.shopping.catalog.search",
        "dev.ucp.shopping.catalog.lookup",
      ],
    });

    profile.ucp.capabilities["dev.ucp.shopping.checkout"] = [{
      version: "2026-01",
      spec: "https://ucp.dev/2026-01/specification/checkout",
      schema: "https://ucp.dev/2026-01/schemas/shopping/checkout.json",
    }];
    const unsafe = evaluateUcpProfile(profile, {
      storefrontOrigin: "https://storefront.example.test",
    });
    expect(unsafe.ok).toBe(false);
    expect(unsafe.errors.join(" ")).toMatch(/only catalog search\/lookup|checkout\/cart\/order\/payment/);
  });
});

describe("release feed continuation", () => {
  const initialUrl = "https://storefront.example.test/api/product-feed.xml?limit=5";

  it("accepts and returns the feed-owned opaque next link", () => {
    expect(evaluateFeedContinuationLink(
      '<https://storefront.example.test/api/product-feed.xml?limit=5&cursor=feed-v1.abc.cHJvZF8x>; rel="next"',
      {
        initialUrl,
        storefrontOrigin: "https://storefront.example.test",
      },
    )).toEqual({
      ok: true,
      errors: [],
      continuationUrl:
        "https://storefront.example.test/api/product-feed.xml?limit=5&cursor=feed-v1.abc.cHJvZF8x",
    });
  });

  it("treats an absent next link as a truthful final feed window", () => {
    expect(evaluateFeedContinuationLink(null, {
      initialUrl,
      storefrontOrigin: "https://storefront.example.test",
    })).toEqual({ ok: true, errors: [], continuationUrl: null });
  });

  it("rejects offset, malformed, off-origin, and wrong-feed continuations", () => {
    const unsafeLinks = [
      '<https://storefront.example.test/api/product-feed.xml?page=2&limit=5>; rel="next"',
      '<https://storefront.example.test/api/product-feed.xml?cursor=page%3A2&limit=5>; rel="next"',
      '<https://evil.example/api/product-feed.xml?cursor=feed-v1.abc.cHJvZF8x&limit=5>; rel="next"',
      '<https://storefront.example.test/api/facebook-feed.xml?cursor=feed-v1.abc.cHJvZF8x&limit=5>; rel="next"',
      '<https://storefront.example.test/api/product-feed.xml?cursor=feed-v1.abc.cHJvZF8x&limit=10>; rel="next"',
    ];

    for (const link of unsafeLinks) {
      expect(evaluateFeedContinuationLink(link, {
        initialUrl,
        storefrontOrigin: "https://storefront.example.test",
      })).toMatchObject({ ok: false, continuationUrl: null });
    }
  });

  it("rejects duplicate and malformed rel=next declarations", () => {
    expect(evaluateFeedContinuationLink(
      '<https://storefront.example.test/api/product-feed.xml?cursor=feed-v1.abc.cHJvZF8x&limit=5>; rel="next", ' +
        '<https://storefront.example.test/api/product-feed.xml?cursor=feed-v1.abd.cHJvZF8y&limit=5>; rel="next"',
      { initialUrl, storefrontOrigin: "https://storefront.example.test" },
    )).toMatchObject({ ok: false, continuationUrl: null });
    expect(evaluateFeedContinuationLink('not-a-link; rel="next"', {
      initialUrl,
      storefrontOrigin: "https://storefront.example.test",
    })).toMatchObject({ ok: false, continuationUrl: null });
  });
});
