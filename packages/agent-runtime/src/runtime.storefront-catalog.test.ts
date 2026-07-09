import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_PROFILE_URL,
  UCP_VERSION,
} from "./storefront-runtime";
import type { FetchLike } from "./storefront-runtime";
import {
  UNSAFE_TERMS,
  boot,
  catalogCategoriesContext,
  createEnv,
  expectValidationToolError,
  fetchCall,
  firstContentBlock,
  isRecord,
  json,
  mockJsonFetch,
  parseRequestBody,
  requestUrl,
} from "./runtime-test-support";

describe("storefront catalog MCP server", () => {
  it("lists storefront catalog and read-only cart validation tools", async () => {
    const { client } = await boot();

    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "cart_validate",
      "catalog_categories",
      "catalog_lookup",
      "catalog_product",
      "catalog_profile",
      "catalog_search",
      "storefront_discovery_policy",
    ]);

    for (const tool of result.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
    }

    const serialized = JSON.stringify(result.tools).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
  });

  it("rejects unbounded catalog and cart validation inputs before storefront fetches", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const { client } = await boot(fetchImpl);

    await expectValidationToolError(client.callTool({
      name: "catalog_search",
      arguments: { query: "", limit: 5 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_search",
      arguments: { query: "khaki", limit: 11 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_lookup",
      arguments: { ids: Array.from({ length: 11 }, (_, index) => `prod_${index}`) },
    }));
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: Array.from({ length: 11 }, (_, index) => ({
          productId: `prod_${index}`,
          quantity: 1,
          unitPrice: 100,
        })),
      },
    }));
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          quantity: 1,
          unitPrice: 100,
        }],
      },
    }));
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          variantId: "default",
          quantity: 1,
          unitPrice: 100,
        }],
      },
    }));
    await expectValidationToolError(client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          quantity: 1,
          unitPrice: 100,
          customerPhone: "+8801700000000",
          discountCode: "SAVE20",
        }],
      },
    }));
    await expectValidationToolError(client.callTool({
      name: "storefront_discovery_policy",
      arguments: {
        includePrivate: true,
        customerEmail: "customer@example.test",
        paymentToken: "secret",
      },
    }));

    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects unbounded or private catalog category inputs before API fetches", async () => {
    const storefrontFetch = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const apiFetch = mockJsonFetch({
      success: true,
      data: { categories: [] },
    });
    const { client } = await boot(storefrontFetch, createEnv(apiFetch));

    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { limit: 0 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { limit: 51 },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: { slug: "x".repeat(101) },
    }));
    await expectValidationToolError(client.callTool({
      name: "catalog_categories",
      arguments: {
        limit: 5,
        includePrivate: true,
        includeProducts: true,
        Authorization: "Bearer must-not-forward",
        customerEmail: "customer@example.test",
        paymentToken: "secret",
      },
    }));

    expect(storefrontFetch).not.toHaveBeenCalled();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it("summarizes public storefront discovery policy through API binding with compact safe output", async () => {
    const storefrontFetch = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        discovery: {
          sitemap: {
            enabled: true,
            staticPages: true,
            products: true,
            categories: true,
            collections: false,
            pages: true,
          },
          feeds: {
            productCatalogEnabled: true,
            includeUnavailableProducts: false,
            variantStrategy: "variants",
            title: "Demo feed",
            description: "Public products",
            privateNote: "must-not-leak",
          },
          robots: { advertiseSitemap: true, rawRobotsTxt: "must-not-leak" },
          structuredData: {
            organization: true,
            websiteSearch: true,
            products: true,
            productGroups: true,
            offerShippingDetails: true,
            breadcrumbs: true,
            collections: false,
          },
        },
        returnPolicy: {
          enabled: true,
          country: "BD",
          category: "https://schema.org/MerchantReturnFiniteReturnWindow",
          returnWindowDays: 7,
          returnFees: "https://schema.org/FreeReturn",
          returnMethod: "https://schema.org/ReturnByMail",
          policyUrl: "/returns",
          rawProviderError: "must-not-leak",
        },
        robotsTxt: "must-not-leak",
        checkout: "must-not-leak",
        payment: "must-not-leak",
      },
    }));
    const { client } = await boot(storefrontFetch, createEnv(apiFetch));

    const result = await client.callTool({
      name: "storefront_discovery_policy",
      arguments: {},
    });

    expect(storefrontFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "http://api.internal/api/v1/seo",
    ]);
    for (const [, init] of apiFetch.mock.calls) {
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const headers = new Headers(init?.headers);
      expect(headers.get("Accept")).toBe("application/json");
      expect(headers.get("Cookie")).toBeNull();
      expect(headers.get("Authorization")).toBeNull();
      expect([...headers.keys()].sort()).toEqual(["accept"]);
    }

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      storefrontDiscoveryPolicy: {
        source: { path: "/api/v1/seo" },
        returnPolicy: {
          enabled: true,
          country: "BD",
          returnWindowDays: 7,
          policyUrl: "https://storefront.example.test/returns",
        },
        discovery: {
          sitemap: {
            enabled: true,
            sections: {
              staticPages: true,
              products: true,
              categories: true,
              collections: false,
              pages: true,
            },
            urls: [
              { type: "index", url: "https://storefront.example.test/sitemap.xml" },
              { type: "static", url: "https://storefront.example.test/sitemap-static.xml" },
              { type: "products", url: "https://storefront.example.test/sitemap-products.xml" },
              { type: "categories", url: "https://storefront.example.test/sitemap-categories.xml" },
              { type: "pages", url: "https://storefront.example.test/sitemap-pages.xml" },
            ],
          },
          feeds: {
            productCatalogEnabled: true,
            includeUnavailableProducts: false,
            variantStrategy: "variants",
            urls: [
              { type: "google", url: "https://storefront.example.test/api/product-feed.xml" },
              { type: "facebook", url: "https://storefront.example.test/api/facebook-feed.xml" },
            ],
          },
          robots: {
            advertiseSitemap: true,
            robotsUrl: "https://storefront.example.test/robots.txt",
          },
          structuredData: { products: true },
        },
        limits: {
          readOnly: true,
          canMutate: false,
          includesCustomerData: false,
          includesPaymentData: false,
          includesCheckoutData: false,
        },
      },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("robotstxt");
    expect(serialized).not.toContain("rawrobotstxt");
  });

  it("keeps disabled storefront return policy compact", async () => {
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        discovery: {},
        returnPolicy: {
          enabled: false,
          country: "BD",
          policyUrl: "https://storefront.example.test/returns",
        },
      },
    }));
    const { client } = await boot(undefined, createEnv(apiFetch));

    const result = await client.callTool({
      name: "storefront_discovery_policy",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      storefrontDiscoveryPolicy: {
        returnPolicy: { enabled: false },
      },
    });
    expect(Object.keys(
      ((result.structuredContent as Record<string, unknown>).storefrontDiscoveryPolicy as Record<string, unknown>)
        .returnPolicy as Record<string, unknown>,
    )).toEqual(["enabled"]);
  });

  it("fails storefront_discovery_policy closed when public policy is unavailable", async () => {
    const apiFetch = vi.fn<FetchLike>()
      .mockResolvedValue(json({ success: false, error: { code: "SERVICE_UNAVAILABLE" } }, 503));
    const { client } = await boot(undefined, createEnv(apiFetch));

    const result = await client.callTool({
      name: "storefront_discovery_policy",
      arguments: {},
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: "public_seo_unavailable" },
      storefrontDiscoveryPolicy: {
        source: { path: "/api/v1/seo" },
        returnPolicy: { enabled: false },
        limits: {
          readOnly: true,
          canMutate: false,
          includesCustomerData: false,
          includesPaymentData: false,
          includesCheckoutData: false,
        },
      },
    });
  });

  it("calls storefront UCP search with bounded body and safe profile header", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({
      ucp: { status: "success", version: UCP_VERSION },
      products: [{ id: "gid://scalius/product/prod_1", title: "Khaki Shoes" }],
    }));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_search",
      arguments: { query: "khaki", limit: 3, category: "shoes" },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      products: [{ title: "Khaki Shoes" }],
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/ucp/catalog/search");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("UCP-Agent")).toBe(`profile="${DEFAULT_AGENT_PROFILE_URL}"`);
    expect(parseRequestBody(init)).toMatchObject({
      ucp: { version: UCP_VERSION },
      query: "khaki",
      pagination: { limit: 3 },
      filters: { categories: ["shoes"] },
    });
  });

  it("calls the public categories API binding with safe GET headers and compact output", async () => {
    const storefrontFetch = vi.fn<FetchLike>().mockResolvedValue(json({ ucp: { status: "success" } }));
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        categories: [
          {
            id: "cat_drinks",
            name: "Drinks",
            slug: "drinks",
            description: "<p>Cold &amp; fizzy</p><script>checkout payment customer@example.test</script>",
            canonicalPath: "/categories/beverages",
            noIndex: true,
            excludeFromSitemap: false,
            updatedAt: "2026-07-07T10:30:00.000Z",
            imageUrl: "https://cdn.example.test/private-category.jpg",
            metaTitle: "must-not-leak",
            metaDescription: "must-not-leak",
            createdAt: "must-not-leak",
            customerEmail: "customer@example.test",
            orderCount: 12,
            paymentStatus: "paid",
            privateNote: "must-not-leak",
          },
          {
            id: "cat_over_limit",
            name: "Over Limit",
            slug: "over-limit",
          },
        ],
        ignored: "must-not-leak",
      },
      rawMessage: "must-not-leak",
    }));
    const { client } = await boot(storefrontFetch, createEnv(apiFetch));

    const result = await client.callTool({
      name: "catalog_categories",
      arguments: { limit: 1 },
    });

    expect(storefrontFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/categories");
    expect(init?.method).toBe("GET");
    expect(init?.body).toBeUndefined();
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Cookie")).toBeNull();
    expect(headers.get("Authorization")).toBeNull();
    expect([...headers.keys()].sort()).toEqual(["accept"]);

    expect(result.isError).toBeUndefined();
    const context = catalogCategoriesContext(result as Record<string, unknown>);
    expect(context).toEqual({
      categories: [{
        id: "cat_drinks",
        name: "Drinks",
        slug: "drinks",
        path: "/categories/beverages",
        url: "https://storefront.example.test/categories/beverages",
        description: "Cold & fizzy",
        updatedAt: "2026-07-07T10:30:00.000Z",
        discovery: {
          noIndex: true,
          excludeFromSitemap: false,
        },
      }],
    });
    const category = (context.categories as Array<Record<string, unknown>>)[0];
    expect(Object.keys(category ?? {}).sort()).toEqual([
      "description",
      "discovery",
      "id",
      "name",
      "path",
      "slug",
      "updatedAt",
      "url",
    ]);
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
    expect(serialized).not.toContain("imageurl");
    expect(serialized).not.toContain("cdn.example.test");
    expect(serialized).not.toContain("meta");
    expect(serialized).not.toContain("must-not-leak");
  });

  it("reads a single category slug through the public category API route", async () => {
    const apiFetch = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        category: {
          id: "cat_summer",
          name: "Summer Sale",
          slug: "summer-sale",
          description: "Seasonal picks",
          canonicalPath: "https://evil.example.test/categories/summer-sale",
          noIndex: false,
          excludeFromSitemap: true,
          updatedAt: "2026-07-08T08:00:00.000Z",
        },
      },
    }));
    const { client } = await boot(undefined, createEnv(apiFetch));

    const result = await client.callTool({
      name: "catalog_categories",
      arguments: { slug: "summer-sale" },
    });

    const [input, init] = fetchCall(apiFetch);
    expect(requestUrl(input)).toBe("http://api.internal/api/v1/categories/summer-sale");
    expect(init?.method).toBe("GET");
    const headers = new Headers(init?.headers);
    expect([...headers.keys()].sort()).toEqual(["accept"]);

    const context = catalogCategoriesContext(result as Record<string, unknown>);
    expect(context).toEqual({
      categories: [{
        id: "cat_summer",
        name: "Summer Sale",
        slug: "summer-sale",
        path: "/categories/summer-sale",
        url: "https://storefront.example.test/categories/summer-sale",
        description: "Seasonal picks",
        updatedAt: "2026-07-08T08:00:00.000Z",
        discovery: {
          noIndex: false,
          excludeFromSitemap: true,
        },
      }],
    });
  });

  it("keeps catalog_categories upstream failures sanitized without leaking bodies", async () => {
    const leak = "raw upstream checkout order payment customer@example.test private receipt token";
    const cases: Array<() => Response> = [
      () => json({ success: false, error: { code: "server_error", message: leak } }, 500),
      () => json({ success: false, error: { code: "not_found", message: leak } }, 404),
      () => new Response(`not json ${leak}`, {
        status: 200,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      }),
      () => json({ success: true, data: { categories: "not-an-array", message: leak } }),
    ];

    for (const makeResponse of cases) {
      const apiFetch = vi.fn<FetchLike>().mockImplementation(() => Promise.resolve(makeResponse()));
      const { client } = await boot(undefined, createEnv(apiFetch));

      const result = await client.callTool({
        name: "catalog_categories",
        arguments: { limit: 5 },
      });

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        catalogCategories: {
          categories: [],
        },
        error: {
          code: "temporarily_unavailable",
          message: "Storefront categories are temporarily unavailable.",
        },
      });
      const serialized = JSON.stringify(result).toLowerCase();
      expect(serialized).not.toContain(leak);
      expect(serialized).not.toContain("customer@example.test");
      expect(serialized).not.toContain("receipt");
      for (const unsafeTerm of UNSAFE_TERMS) {
        expect(serialized).not.toContain(unsafeTerm);
      }
    }
  });

  it("preserves UCP application errors as MCP tool errors", async () => {
    const body = {
      ucp: { status: "error", version: UCP_VERSION },
      messages: [{ type: "error", code: "not_found", content: "Product was not found." }],
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(body));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_product",
      arguments: { id: "missing-product" },
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual(body);
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("not_found"),
    });

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/ucp/catalog/product");
    expect(parseRequestBody(init)).toMatchObject({
      ucp: { version: UCP_VERSION },
      id: "missing-product",
    });
  });

  it("allows a safe catalog-only storefront UCP profile with GET", async () => {
    const safeProfile = {
      ucp: {
        version: UCP_VERSION,
        capabilities: {
          "dev.ucp.shopping.catalog.search": [{
            version: UCP_VERSION,
            description: "Catalog-only discovery with no checkout or payment support.",
          }],
          "dev.ucp.shopping.catalog.lookup": [{ version: UCP_VERSION }],
          "dev.ucp.shopping.catalog.product": [{ version: UCP_VERSION }],
        },
      },
      signing_keys: [{ kid: "catalog-key", use: "sig" }],
    };
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(safeProfile));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "catalog_profile",
      arguments: {},
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      ucp: { version: UCP_VERSION },
    });
    expect(result.structuredContent).toEqual(safeProfile);
    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/.well-known/ucp");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("UCP-Agent")).toBe(`profile="${DEFAULT_AGENT_PROFILE_URL}"`);
  });

  it("fails catalog_profile closed when the upstream UCP profile advertises transaction capabilities", async () => {
    const unsafeProfiles = [
      {
        profile: {
          ucp: {
            version: UCP_VERSION,
            capabilities: {
              "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.cart.mutation": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }],
              "dev.ucp.shopping.order": [{ version: UCP_VERSION }],
            },
          },
        },
        leakedTerms: [
          "dev.ucp.shopping.cart.mutation",
          "dev.ucp.shopping.checkout",
          "dev.ucp.shopping.order",
        ],
      },
      {
        profile: {
          ucp: {
            version: UCP_VERSION,
            capabilities: {
              "dev.ucp.shopping.catalog.search": [{ version: UCP_VERSION }],
            },
            payment_handlers: {
              "com.example.unsafe": [{
                id: "sslcommerz_payment_handler",
                available_instruments: [{ type: "card" }],
              }],
            },
          },
        },
        leakedTerms: [
          "payment_handlers",
          "sslcommerz_payment_handler",
        ],
      },
    ];

    for (const { profile, leakedTerms } of unsafeProfiles) {
      const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json(profile));
      const { client } = await boot(fetchImpl);

      const result = await client.callTool({
        name: "catalog_profile",
        arguments: {},
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ucp: { status: "error", version: UCP_VERSION },
        messages: [{
          type: "error",
          code: "ucp_profile_not_catalog_only",
          content: "Storefront catalog is temporarily unavailable.",
          severity: "recoverable",
        }],
      });

      const contentBlock = firstContentBlock(result);
      expect(contentBlock).toMatchObject({
        type: "text",
        text: expect.stringContaining("ucp_profile_not_catalog_only"),
      });
      const text = isRecord(contentBlock) && typeof contentBlock.text === "string"
        ? contentBlock.text
        : "";
      for (const leakedTerm of leakedTerms) {
        expect(text).not.toContain(leakedTerm);
      }

      const [input, init] = fetchCall(fetchImpl);
      expect(requestUrl(input)).toBe("https://storefront.example.test/.well-known/ucp");
      expect(init?.method).toBe("GET");
    }
  });

  it("validates a bounded cart snapshot through the storefront proxy", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(json({
      success: true,
      data: {
        valid: false,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "The price changed before checkout.",
          productName: "Khaki Shoes",
          variantLabel: "Size: 42",
          requestedQuantity: 2,
          submittedPrice: 100,
          currentPrice: 120,
        }],
        items: [],
        subtotal: 0,
        hasFreeDeliveryProduct: false,
      },
    }));
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          variantId: "var_1",
          slug: "khaki-shoes",
          name: "Khaki Shoes",
          quantity: 2,
          unitPrice: 100,
          options: [{ name: "Size", value: "42" }],
        }],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      cartValidation: {
        valid: false,
        issueCount: 1,
        issues: [{
          index: 0,
          productId: "prod_1",
          variantId: "var_1",
          code: "PRICE_CHANGED",
          action: "refresh_item",
          message: "Unit price changed.",
          productName: "Khaki Shoes",
          variantLabel: "Size: 42",
          requestedQuantity: 2,
          submittedPrice: 100,
          currentPrice: 120,
        }],
        items: [],
        subtotal: 0,
      },
    });
    expect(firstContentBlock(result)).toMatchObject({
      type: "text",
      text: expect.stringContaining("PRICE_CHANGED"),
    });
    const serialized = JSON.stringify(result).toLowerCase();
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }

    const [input, init] = fetchCall(fetchImpl);
    expect(requestUrl(input)).toBe("https://storefront.example.test/api/checkout/validate-cart");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init?.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect([...headers.keys()].sort()).toEqual(["accept", "content-type"]);
    expect(parseRequestBody(init)).toEqual({
      items: [{
        productId: "prod_1",
        variantId: "var_1",
        quantity: 2,
        price: 100,
        productName: "Khaki Shoes",
        variantLabel: "Size: 42",
      }],
    });
  });

  it("keeps storefront validation failures fail-closed and cheap", async () => {
    const fetchImpl = vi.fn<FetchLike>().mockRejectedValue(
      new Error("raw checkout order payment customer@example.test"),
    );
    const { client } = await boot(fetchImpl);

    const result = await client.callTool({
      name: "cart_validate",
      arguments: {
        items: [{
          productId: "prod_1",
          variantId: "var_1",
          quantity: 1,
          unitPrice: 100,
        }],
      },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      cartValidation: {
        valid: false,
        issueCount: 0,
        issues: [],
      },
      error: {
        code: "temporarily_unavailable",
        message: "Storefront cart validation is temporarily unavailable.",
      },
    });
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain("raw checkout order payment customer@example.test");
    for (const unsafeTerm of UNSAFE_TERMS) {
      expect(serialized).not.toContain(unsafeTerm);
    }
  });
});
