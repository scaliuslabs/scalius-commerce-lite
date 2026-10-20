import { describe, expect, it } from "vitest";

import {
  checkUcpDiscovery,
  evaluateDiscoveryCacheHeaders,
  evaluateFeedContinuationLink,
  evaluateProductJsonLdHtml,
  evaluateRequiredDocs,
  evaluateRobotsTxt,
  evaluateSitemapIndexSections,
  evaluateUcpMcpTools,
  evaluateUcpProfile,
  firstUcpSearchCandidate,
  normalizeHttpBaseUrl,
  parseReleaseCheckArgs,
  requestHeaders,
  responseFailureContext,
} from "./release-check.mjs";

function catalogOnlyUcpProfile() {
  const version = "2026-08-25";
  const service = (transport, endpoint, schema) => ({
    version,
    transport,
    endpoint,
    spec: `https://ucp.dev/${version}/specification/overview`,
    schema: `https://ucp.dev/${version}/services/shopping/${schema}`,
  });
  return {
    ucp: {
      version,
      services: {
        "dev.ucp.shopping": [
          service("rest", "https://storefront.example.test/ucp", "rest.openapi.json"),
          service("mcp", "https://storefront.example.test/ucp/mcp", "mcp.openrpc.json"),
        ],
      },
      capabilities: {
        "dev.ucp.shopping.catalog.search": [
          {
            version,
            spec: `https://ucp.dev/${version}/specification/shopping/catalog/search`,
            schema: `https://ucp.dev/${version}/schemas/shopping/catalog_search.json`,
          },
        ],
        "dev.ucp.shopping.catalog.lookup": [
          {
            version,
            spec: `https://ucp.dev/${version}/specification/shopping/catalog/lookup`,
            schema: `https://ucp.dev/${version}/schemas/shopping/catalog_lookup.json`,
          },
        ],
      },
      payment_handlers: {},
    },
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

function mcpTools(names = ["search_catalog", "lookup_catalog", "get_product"]) {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      tools: names.map((name) => ({
        name,
        inputSchema: { type: "object", required: ["meta", "catalog"] },
        annotations: READ_ONLY,
      })),
    },
  };
}

describe("release check arguments", () => {
  it("reports bounded route and Cloudflare correlation metadata", () => {
    expect(responseFailureContext({
      url: "https://storefront.example.test/search?q=private",
      statusCode: 503,
      headers: new Headers({ "cf-ray": "abc123-DAC" }),
    })).toBe("route=/search status=503 cf-ray=abc123-DAC");
  });

  it("can inspect normal cache behavior without requesting a bypass", () => {
    expect(requestHeaders("application/xml")).toEqual({
      Accept: "application/xml",
      "Cache-Control": "no-cache",
    });
    expect(requestHeaders("application/xml", { bypassCache: false })).toEqual({
      Accept: "application/xml",
    });
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

  it("defaults every origin to the repository demo without reading Wrangler vars", () => {
    expect(parseReleaseCheckArgs([])).toMatchObject({
      apiBaseUrl: "https://api.scalius.com",
      storefrontUrl: "https://storefront.scalius.com",
      dashboardUrl: "https://dashboard.scalius.com",
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
  it("checks the public contributor and architecture documents", () => {
    const seen = [];
    const result = evaluateRequiredDocs({
      rootDir: "/repo",
      fileExistsImpl(path) {
        seen.push(path);
        return true;
      },
    });

    expect(result).toEqual({ ok: true, checkedFiles: 5, missing: [] });
    expect(seen).toEqual(expect.arrayContaining([
      "/repo/docs/ARCHITECTURE.md",
      "/repo/README.md",
      "/repo/CONTRIBUTING.md",
      "/repo/SECURITY.md",
      "/repo/CODE_OF_CONDUCT.md",
    ]));
  });

  it("reports missing required files", () => {
    expect(evaluateRequiredDocs({
      rootDir: "/repo",
      required: ["README.md", "SECURITY.md"],
      fileExistsImpl: (path) => path.endsWith("README.md"),
    })).toEqual({
      ok: false,
      checkedFiles: 2,
      missing: ["SECURITY.md"],
    });
  });
});

describe("release discovery policy", () => {
  const origin = "https://storefront.example.test";

  it("requires exactly one canonical Sitemap line in robots.txt", () => {
    const expectedSitemapUrl = `${origin}/sitemap.xml`;
    const check = (body) =>
      evaluateRobotsTxt(body, { storefrontOrigin: origin, expectedSitemapUrl });

    expect(check(`User-agent: *\nAllow: /\n\nSitemap: ${expectedSitemapUrl}`).ok).toBe(true);
    expect(check("User-agent: *\nAllow: /").ok).toBe(false);
    expect(check(`Sitemap: ${expectedSitemapUrl}\nSitemap: ${expectedSitemapUrl}`).ok).toBe(false);
    expect(check("Sitemap: /sitemap.xml").ok).toBe(false);
  });

  it("requires the sitemap index to advertise every section", () => {
    const sections = [
      "/sitemap-static.xml",
      "/sitemap-products.xml?page=1",
      "/sitemap-categories.xml",
      "/sitemap-brands.xml",
      "/sitemap-collections.xml",
      "/sitemap-pages.xml",
      "/sitemap-articles.xml",
    ].map((path) => `${origin}${path}`);

    expect(evaluateSitemapIndexSections(sections, { storefrontOrigin: origin }).ok).toBe(true);
    expect(evaluateSitemapIndexSections(sections.slice(1), { storefrontOrigin: origin })).toMatchObject({
      ok: false,
      errors: ["sitemap index must advertise the static pages sitemap."],
    });
  });

  it("requires the brands sitemap in the index", () => {
    const sections = [
      "/sitemap-static.xml",
      "/sitemap-products.xml?page=1",
      "/sitemap-categories.xml",
      "/sitemap-collections.xml",
      "/sitemap-pages.xml",
      "/sitemap-articles.xml",
    ].map((path) => `${origin}${path}`);

    expect(evaluateSitemapIndexSections(sections, { storefrontOrigin: origin })).toMatchObject({
      ok: false,
      errors: ["sitemap index must advertise the brands sitemap."],
    });
  });

  it("accepts a Product JSON-LD brand only as a named Brand, and its absence", () => {
    const productHtml = (brand) => `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Ceiling Fan",
      image: [`${origin}/media/fan.webp`],
      ...(brand === undefined ? {} : { brand }),
      offers: {
        "@type": "Offer",
        url: `${origin}/products/ceiling-fan`,
        price: "4500",
        priceCurrency: "BDT",
        availability: "https://schema.org/InStock",
      },
    })}</script>`;
    const check = (brand) => evaluateProductJsonLdHtml(productHtml(brand), { storefrontOrigin: origin });

    expect(check(undefined).ok).toBe(true);
    expect(check({ "@type": "Brand", name: "Walton" }).ok).toBe(true);
    expect(check({ "@type": "Brand", name: "Generic" }).errors)
      .toEqual(["Product JSON-LD brand must not be a placeholder: Generic"]);
    expect(check({ "@type": "Brand", name: "  " }).ok).toBe(false);
    expect(check("Walton").ok).toBe(false);
  });

  it("accepts public cache headers with a positive TTL", () => {
    expect(evaluateDiscoveryCacheHeaders(
      new Headers({ "Cache-Control": "public, max-age=60" }),
    )).toMatchObject({ ok: true, errors: [] });
  });

  it("accepts public discovery responses that require browser revalidation", () => {
    expect(evaluateDiscoveryCacheHeaders(
      new Headers({
        "Cache-Control": "public, max-age=0, no-cache, must-revalidate",
      }),
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

  it("requires the 2026-08-25 profile shape: version, MCP binding, empty payment handler registry", () => {
    const origin = { storefrontOrigin: "https://storefront.example.test" };
    expect(evaluateUcpProfile(catalogOnlyUcpProfile(), origin)).toMatchObject({
      ok: true,
      version: "2026-08-25",
      mcpEndpoint: "https://storefront.example.test/ucp/mcp",
    });

    const withoutRegistry = catalogOnlyUcpProfile();
    delete withoutRegistry.ucp.payment_handlers;
    expect(evaluateUcpProfile(withoutRegistry, origin).errors.join(" ")).toContain("ucp.payment_handlers");

    const withHandler = catalogOnlyUcpProfile();
    withHandler.ucp.payment_handlers = { "com.example.pay": [{ id: "pay", version: "2026-08-25" }] };
    expect(evaluateUcpProfile(withHandler, origin).errors.join(" ")).toContain("must not advertise payment handlers");

    const withoutMcp = catalogOnlyUcpProfile();
    withoutMcp.ucp.services["dev.ucp.shopping"].pop();
    expect(evaluateUcpProfile(withoutMcp, origin).errors.join(" ")).toContain("MCP");

    const oldVersion = catalogOnlyUcpProfile();
    oldVersion.ucp.version = "2026-04-08";
    expect(evaluateUcpProfile(oldVersion, origin).errors.join(" ")).toContain("must be 2026-08-25");

    const selfListed = catalogOnlyUcpProfile();
    selfListed.ucp.supported_versions = { "2026-08-25": "https://storefront.example.test/.well-known/ucp" };
    expect(evaluateUcpProfile(selfListed, origin).errors.join(" ")).toContain("only older versions");

    const oldSpecPath = catalogOnlyUcpProfile();
    oldSpecPath.ucp.capabilities["dev.ucp.shopping.catalog.search"][0].spec = "https://ucp.dev/2026-08-25/specification/catalog/search";
    expect(evaluateUcpProfile(oldSpecPath, origin).ok).toBe(false);
  });

  it("accepts exactly the three read-only UCP MCP tools", () => {
    expect(evaluateUcpMcpTools(mcpTools())).toMatchObject({ ok: true, tools: ["search_catalog", "lookup_catalog", "get_product"] });
    expect(evaluateUcpMcpTools(mcpTools(["search_catalog", "lookup_catalog", "get_product", "create_checkout"])).ok).toBe(false);
    expect(evaluateUcpMcpTools(mcpTools(["search_catalog", "lookup_catalog"])).ok).toBe(false);

    const writable = mcpTools();
    writable.result.tools[1].annotations = { readOnlyHint: false, destructiveHint: true };
    expect(evaluateUcpMcpTools(writable).errors.join(" ")).toContain("lookup_catalog");
    expect(evaluateUcpMcpTools({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Method not found" } }).ok).toBe(false);
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

describe("release UCP catalog candidate", () => {
  it("uses only a candidate actually returned by catalog search", () => {
    expect(firstUcpSearchCandidate({ products: [] })).toBeNull();
    expect(firstUcpSearchCandidate({
      products: [{
        id: "ucp-product-1",
        url: "https://storefront.example.test/products/example",
        variants: [{ id: "ucp-variant-1" }],
      }],
    })).toEqual({
      id: "ucp-variant-1",
      productId: "ucp-product-1",
      variantId: "ucp-variant-1",
    });
  });

  function jsonResponse(payload) {
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "application/json",
      },
    });
  }

  function llmsResponse() {
    return new Response([
      "https://storefront.example.test/.well-known/ucp",
      "https://storefront.example.test/ucp/mcp",
      "dev.ucp.shopping.catalog.search",
      "dev.ucp.shopping.catalog.lookup",
      "UCP-Agent:",
      "Checkout capabilities are not advertised",
    ].join("\n"), {
      status: 200,
      headers: {
        "Cache-Control": "public, max-age=60",
        "Content-Type": "text/plain",
      },
    });
  }

  const options = {
    storefrontUrl: "https://storefront.example.test",
    timeoutMs: 1_000,
  };

  /** The MCP endpoint: tools/list, and search_catalog answering with `searchPayload` (the REST body). */
  function mcpResponse(init, searchPayload) {
    const message = JSON.parse(init.body);
    if (message.method === "tools/list") return jsonResponse(mcpTools());
    expect(message).toMatchObject({
      method: "tools/call",
      params: { name: "search_catalog", arguments: { meta: { "ucp-agent": { profile: expect.stringMatching(/^https:/) } } } },
    });
    expect(init.headers["Mcp-Name"]).toBe("search_catalog");
    return jsonResponse({ jsonrpc: "2.0", id: message.id, result: { structuredContent: searchPayload } });
  }

  it("skips lookup and product reads when search has no eligible candidate", async () => {
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (url.endsWith("/.well-known/ucp")) return jsonResponse(catalogOnlyUcpProfile());
      if (url.endsWith("/llms.txt")) return llmsResponse();
      if (url.endsWith("/catalog/search")) return jsonResponse({ products: [] });
      if (url.endsWith("/ucp/mcp")) return mcpResponse(init, { products: [] });
      throw new Error(`Unexpected UCP request: ${url}`);
    };

    const result = await checkUcpDiscovery(options, {
      fetchImpl,
      productUrl: "https://storefront.example.test/products/example-product",
      logger: null,
    });

    expect(urls).toEqual([
      "https://storefront.example.test/.well-known/ucp",
      "https://storefront.example.test/llms.txt",
      "https://storefront.example.test/ucp/mcp",
      "https://storefront.example.test/ucp/catalog/search",
      "https://storefront.example.test/ucp/mcp",
    ]);
    expect(result.mcp).toMatchObject({ tools: ["search_catalog", "lookup_catalog", "get_product"], search: { matchesRest: true } });
    expect(result.catalog).toMatchObject({
      search: { productCount: 0 },
      lookup: { status: "skipped" },
      product: { status: "skipped" },
    });
  });

  it("keeps lookup correlation and product validation for a real search candidate", async () => {
    const variantId = "gid://scalius/ProductVariant/variant-1";
    const searchPayload = {
      products: [{ id: "gid://scalius/Product/product-1", variants: [{ id: variantId }] }],
    };
    const urls = [];
    const fetchImpl = async (url, init) => {
      urls.push(url);
      if (url.endsWith("/.well-known/ucp")) return jsonResponse(catalogOnlyUcpProfile());
      if (url.endsWith("/llms.txt")) return llmsResponse();
      if (url.endsWith("/ucp/mcp")) return mcpResponse(init, searchPayload);
      if (url.endsWith("/catalog/search")) return jsonResponse(searchPayload);
      if (url.endsWith("/catalog/lookup")) {
        return jsonResponse({
          products: [{ variants: [{ inputs: [{ id: variantId }] }] }],
        });
      }
      if (url.endsWith("/catalog/product")) {
        return jsonResponse({
          ucp: { status: "success" },
          product: {
            id: "gid://scalius/Product/product-1",
            variants: [{ id: variantId }],
          },
        });
      }
      throw new Error(`Unexpected UCP request: ${url}`);
    };

    const result = await checkUcpDiscovery(options, {
      fetchImpl,
      productUrl: "https://storefront.example.test/products/example-product",
      logger: null,
    });

    expect(urls).toEqual([
      "https://storefront.example.test/.well-known/ucp",
      "https://storefront.example.test/llms.txt",
      "https://storefront.example.test/ucp/mcp",
      "https://storefront.example.test/ucp/catalog/search",
      "https://storefront.example.test/ucp/mcp",
      "https://storefront.example.test/ucp/catalog/lookup",
      "https://storefront.example.test/ucp/catalog/product",
    ]);
    expect(result.catalog).toMatchObject({
      search: { productCount: 1 },
      lookup: { inputId: variantId, productCount: 1 },
      product: { inputId: variantId, firstVariantId: variantId, variantCount: 1 },
    });
  });
});

describe("release UCP MCP parity", () => {
  it("fails when MCP search_catalog does not answer with the REST products", async () => {
    const restPayload = { products: [{ id: "gid://scalius/product/p1", variants: [{ id: "gid://scalius/product-variant/v1" }] }] };
    const fetchImpl = async (url, init) => {
      const json = (payload) => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "Cache-Control": "public, max-age=60", "Content-Type": "application/json" },
      });
      if (url.endsWith("/.well-known/ucp")) return json(catalogOnlyUcpProfile());
      if (url.endsWith("/llms.txt")) {
        return new Response("https://storefront.example.test/.well-known/ucp https://storefront.example.test/ucp/mcp dev.ucp.shopping.catalog.search dev.ucp.shopping.catalog.lookup UCP-Agent: not advertised", {
          status: 200,
          headers: { "Cache-Control": "public, max-age=60", "Content-Type": "text/plain" },
        });
      }
      if (url.endsWith("/catalog/search")) return json(restPayload);
      if (url.endsWith("/ucp/mcp")) {
        const message = JSON.parse(init.body);
        return json(message.method === "tools/list"
          ? mcpTools()
          : { jsonrpc: "2.0", id: message.id, result: { structuredContent: { products: [] } } });
      }
      throw new Error(`Unexpected UCP request: ${url}`);
    };

    await expect(checkUcpDiscovery({ storefrontUrl: "https://storefront.example.test", timeoutMs: 1_000 }, {
      fetchImpl,
      productUrl: "https://storefront.example.test/products/p1",
      logger: null,
    })).rejects.toThrow("differ from the REST catalog search");
  });
});

describe("public API reads", () => {
  it("asks the API itself for the reads a storefront page renders from, homepage first", async () => {
    const { PUBLIC_API_READS } = await import("./release-check.mjs");
    expect(PUBLIC_API_READS[0]).toBe("/storefront/homepage");
    for (const read of ["/storefront/layout", "/checkout/config", "/products?limit=24"]) expect(PUBLIC_API_READS).toContain(read);
  });
});

describe("theme apps", () => {
  // The demo after a deploy: the theme still drew with Noor, but Noor had dropped off the layout.
  const theme = {
    apps: { skins: { header: { app: "scalius.noor/noor_header", values: {} }, "product-card": { app: "scalius.noor/noor_card", values: {} } } },
    pages: { home: { sections: [
      { id: "hero", type: "hero", skin: { app: "scalius.noor/section_hero", values: {} } },
      { id: "app", type: "app", app: "acme.reviews/reviews", values: {} },
    ] } },
  };

  it("fails when the published theme draws with an app that is not active, naming it", async () => {
    const { evaluateThemeApps } = await import("./release-check.mjs");
    const evaluation = evaluateThemeApps({ theme, appExtensions: [{ pluginId: "acme.reviews" }] });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.referenced).toEqual(["acme.reviews", "scalius.noor"]);
    expect(evaluation.inactive).toEqual(["scalius.noor"]);
    expect(evaluation.errors[0]).toContain("scalius.noor");
  });

  it("passes when every app the theme draws with is active, and when it draws with none", async () => {
    const { evaluateThemeApps } = await import("./release-check.mjs");
    expect(evaluateThemeApps({ theme, appExtensions: [{ pluginId: "scalius.noor" }, { pluginId: "acme.reviews" }] }).ok).toBe(true);
    expect(evaluateThemeApps({ theme: { pages: {} }, appExtensions: [] })).toMatchObject({ ok: true, referenced: [] });
    expect(evaluateThemeApps({ appExtensions: [] }).ok).toBe(false);
  });
});
