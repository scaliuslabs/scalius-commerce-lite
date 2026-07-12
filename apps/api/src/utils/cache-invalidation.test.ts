import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_CACHE_GROUPS,
  D1_CACHE_SUBJECT_ID_CHUNK_SIZE,
  INVALIDATION_GROUPS,
  MAX_STOREFRONT_EXACT_HTML_PATHS,
  collectCmsShortcodePageInvalidation,
  collectCollectionCacheInvalidation,
  collectProductAvailabilityCacheInvalidation,
  createStorefrontCacheWarmMessageForPurge,
  getCatalogStorefrontHtmlPaths,
  getGroupsForPath,
  getProductAvailabilityApiCacheKeys,
  getProductAvailabilityApiCachePatterns,
  getProductAvailabilityStorefrontPrefixes,
  getStorefrontWarmPathsForPurge,
  getStorefrontPrefixesForGroups,
  invalidateGroups,
  invalidateProductAvailabilityCacheSubjects,
  invalidateApiAndScheduleStorefrontGroups,
  invalidateApiAndStorefrontGroups,
  invalidateCatalogCaches,
  normalizeStorefrontHtmlPaths,
  normalizeStorefrontPurgeUrl,
  purgeStorefrontForGroups,
  purgeStorefrontForPrefixes,
  resolveCmsShortcodePageTargets,
  resolveCollectionCacheTargets,
  resolveProductAvailabilityCacheSubjects,
  triggerStorefrontPurgeForGroups,
  triggerStorefrontPurgeForPrefixes,
  warmStorefrontHtmlPaths,
} from "./cache-invalidation";
import { PRODUCT_API_CACHE_NAMESPACE } from "./product-api-cache";

describe("catalog cache groups", () => {
  it("maps catalog admin writes to every storefront cache they can affect", () => {
    expect(getGroupsForPath("/api/v1/admin/products/prod_123")).toEqual([
      "products",
      "search",
      "collections",
      "attributes",
    ]);
    expect(getGroupsForPath("/api/v1/admin/categories/cat_123")).toEqual([
      "categories",
      "products",
      "search",
      "collections",
      "layout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/discounts/disc_123")).toEqual([
      "products",
      "search",
      "collections",
    ]);
    expect(getGroupsForPath("/api/v1/admin/inventory/stock-set")).toEqual([]);
    expect(getGroupsForPath("/api/v1/admin/attributes/attr_123")).toEqual([
      "attributes",
      "products",
    ]);

    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.products])).toEqual(
      expect.arrayContaining([
        "product_slug_",
        "all_products_",
        "category_products_",
        "collection_by_id_",
        "filterable_attrs_",
        "global_all_collections",
      ]),
    );
    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.collections])).toEqual(
      expect.arrayContaining(["collection_by_id_", "storefront_homepage_"]),
    );
    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.categories])).toEqual(
      expect.arrayContaining([
        "category_slug_",
        "global_navigation_",
        "storefront_layout_",
      ]),
    );
  });

  it("builds bounded canonical storefront listing warm paths for catalog writes", () => {
    expect(getCatalogStorefrontHtmlPaths("products")).toEqual(["/search"]);
    expect(getCatalogStorefrontHtmlPaths("discounts")).toEqual(["/search"]);
    expect(getCatalogStorefrontHtmlPaths("collections")).toEqual([]);
    expect(
      getCatalogStorefrontHtmlPaths("products", [
        "/products/fish?size=m&color=red&utm_source=ad",
        "/products/fish",
      ]),
    ).toEqual(["/search", "/products/fish"]);
    expect(
      getCatalogStorefrontHtmlPaths("categories", [
        "/categories/fish?page=1&sortBy=newest&utm_source=ad",
        "/categories/fish",
        "https://external.example/categories/rice",
      ]),
    ).toEqual(["/search", "/categories/fish"]);
  });
});

describe("CMS shortcode page invalidation", () => {
  function cmsPageDb(rows: Array<{ id: string; slug: string; content: string }>) {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => Promise.resolve(rows)),
    };
    return {
      select: vi.fn(() => query),
      query,
    };
  }

  it("collects exact page render prefixes and HTML paths for shortcode pages", () => {
    const targets = [
      { id: "page_1", slug: "combo-offer" },
      { id: "page_1_duplicate", slug: "combo-offer" },
      { id: "page_2", slug: "gift-guide" },
    ];

    expect(collectCmsShortcodePageInvalidation(targets)).toEqual({
      apiPatterns: [
        "api:storefront:page:/api/v1/storefront/pages/slug/combo-offer*",
        "api:storefront:page:/api/v1/storefront/pages/slug/gift-guide*",
      ],
      storefrontPrefixes: [
        "page_render_combo-offer_",
        "page_render_gift-guide_",
      ],
      storefrontHtmlPaths: ["/combo-offer", "/gift-guide"],
      bumpVersion: false,
    });
  });

  it("requests a global HTML bump when shortcode references exceed the exact warm cap", () => {
    const targets = Array.from(
      { length: MAX_STOREFRONT_EXACT_HTML_PATHS + 1 },
      (_, index) => ({ id: `page_${index}`, slug: `promo-${index}` }),
    );

    expect(collectCmsShortcodePageInvalidation(targets).bumpVersion).toBe(true);
  });

  it("resolves published CMS pages that reference affected product slugs", async () => {
    const db = cmsPageDb([
      {
        id: "page_1",
        slug: "combo-offer",
        content: '<p>[product slug="phone"]</p>',
      },
      {
        id: "page_3",
        slug: "other-product",
        content: '<p>[product slug="rice"]</p>',
      },
      {
        id: "page_4",
        slug: "case-sensitive",
        content: '<p>[Product slug="phone"]</p>',
      },
    ]);

    await expect(
      resolveCmsShortcodePageTargets(db as never, {
        productSlugs: ["phone"],
      }),
    ).resolves.toEqual([
      { id: "page_1", slug: "combo-offer" },
    ]);
    expect(db.select).toHaveBeenCalledTimes(1);
    expect(db.query.where).toHaveBeenCalledTimes(1);
  });
});

describe("triggerStorefrontPurgeForGroups", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("posts the matching storefront cache prefixes and HTML bump flag", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForGroups(
      ["pages"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;

    expect(String(url)).toBe("https://storefront.example.com/api/purge-cache");
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["pages"],
      prefixes: ["page_slug_", "page_render_", "all_pages_"],
      bumpVersion: true,
    });
  });

  it("purges page and layout prefixes when page writes pass both dependent groups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await purgeStorefrontForGroups(["pages", "layout"], {
      PURGE_URL: "https://storefront.example.com/api/purge-cache",
      PURGE_TOKEN: "secret-token",
    } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">);

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["pages", "layout"],
      prefixes: [
        "page_slug_",
        "page_render_",
        "all_pages_",
        "storefront_layout_",
        "global_header_data",
        "global_footer_data",
        "global_navigation_",
        "global_analytics_config",
        "global_security_settings",
      ],
      bumpVersion: true,
    });
  });

  it("can purge exact storefront prefixes without expanding to coarse groups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await purgeStorefrontForPrefixes(
      ["product_slug_fish", "product_variants_prod_1"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["products"], bumpVersion: false },
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["products"],
      prefixes: ["product_slug_fish", "product_variants_prod_1"],
      bumpVersion: false,
    });
  });

  it("can suppress storefront-side warming for queue-driven purge messages", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await purgeStorefrontForPrefixes(
      ["product_slug_fish"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      {
        groups: ["products"],
        bumpVersion: false,
        exactKeys: ["product_variants_prod_1"],
        htmlPaths: ["/products/fish"],
        operationId: "purge_op_1",
        warm: false,
      },
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      operationId: "purge_op_1",
      groups: ["products"],
      prefixes: ["product_slug_fish"],
      exactKeys: ["product_variants_prod_1"],
      htmlPaths: ["/products/fish"],
      bumpVersion: false,
      warm: false,
    });
  });

  it("caps and sanitizes exact storefront HTML paths before sending purge payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const noisyPaths = [
      "/products/p0",
      "/products/p0",
      "/products/p0?size=m",
      "/products/p0?color=red&utm_source=ad",
      "https://external.example/products/p1",
      "//external.example/products/p2",
      ...Array.from(
        { length: MAX_STOREFRONT_EXACT_HTML_PATHS + 5 },
        (_, index) => `/products/p${index}`,
      ),
    ];

    expect(normalizeStorefrontHtmlPaths(noisyPaths)).toHaveLength(
      MAX_STOREFRONT_EXACT_HTML_PATHS,
    );

    const result = await purgeStorefrontForPrefixes(
      ["product_slug_p0"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["products"], bumpVersion: false, htmlPaths: noisyPaths },
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { htmlPaths: string[] };
    expect(body.htmlPaths).toHaveLength(MAX_STOREFRONT_EXACT_HTML_PATHS);
    expect(body.htmlPaths[0]).toBe("/products/p0");
    expect(body.htmlPaths).not.toContain("/products/p0?size=m");
    expect(body.htmlPaths).not.toContain("/products/p0?color=red&utm_source=ad");
    expect(body.htmlPaths).not.toContain("https://external.example/products/p1");
    expect(body.htmlPaths).not.toContain("//external.example/products/p2");
    expect(new Set(body.htmlPaths).size).toBe(body.htmlPaths.length);
  });

  it("dedupes storefront HTML paths by canonical cache key before applying the cap", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const noisyPaths = [
      ...Array.from(
        { length: MAX_STOREFRONT_EXACT_HTML_PATHS + 5 },
        (_, index) => `/products/fish?size=${index}`,
      ),
      "/products/phone",
    ];

    expect(normalizeStorefrontHtmlPaths(noisyPaths, 2)).toEqual([
      "/products/fish",
      "/products/phone",
    ]);

    const result = await purgeStorefrontForPrefixes(
      ["product_slug_fish"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["products"], bumpVersion: false, htmlPaths: noisyPaths },
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as { htmlPaths: string[] };
    expect(body.htmlPaths.slice(0, 2)).toEqual([
      "/products/fish",
      "/products/phone",
    ]);
    expect(body.htmlPaths).not.toContain("/products/fish?size=0");
  });

  it("schedules exact storefront prefix purges through waitUntil", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForPrefixes(
      ["product_slug_fish", "product_variants_prod_1"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["products"], bumpVersion: false },
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["products"],
      prefixes: ["product_slug_fish", "product_variants_prod_1"],
      bumpVersion: false,
    });
  });

  it("invalidates public checkout config KV cache with the checkout group", () => {
    const checkoutGroup = INVALIDATION_GROUPS.checkout;
    expect(checkoutGroup).toBeDefined();
    expect(checkoutGroup!.kvPrefixes).toEqual(
      expect.arrayContaining([
        "api:checkout:config:",
        "api:checkout:config:v2:",
      ]),
    );
  });

  it("maps payment settings writes to the checkout cache group", () => {
    expect(getGroupsForPath("/api/v1/admin/settings/payment-methods")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/stripe")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/sslcommerz")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/polar")).toEqual([
      "checkout",
    ]);
  });

  it("maps settings and reference-data writes to their storefront cache groups", () => {
    expect(getGroupsForPath("/api/v1/admin/settings/shipping-methods")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/delivery-locations")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/checkout-languages")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/allowed-countries")).toEqual([
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/navigation")).toEqual(["layout"]);
    expect(getGroupsForPath("/api/v1/admin/analytics")).toEqual(["layout"]);
    expect(getGroupsForPath("/api/v1/admin/settings/header")).toEqual(["layout"]);
    expect(getGroupsForPath("/api/v1/admin/settings/footer")).toEqual(["layout"]);
    expect(getGroupsForPath("/api/v1/admin/settings/theme")).toEqual(["layout"]);
    expect(getGroupsForPath("/api/v1/admin/settings/storefront-url")).toEqual([
      "homepage",
      "layout",
      "discovery",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/currency")).toEqual([
      "layout",
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/hero-sliders")).toEqual([
      "homepage",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/seo")).toEqual([
      "homepage",
      "layout",
      "discovery",
    ]);
    expect(getStorefrontPrefixesForGroups(["discovery"])).toEqual([
      "global_seo_settings",
      "feed_products_",
      "sitemap_products_",
    ]);
    expect(getGroupsForPath("/api/v1/admin/pages/about-us")).toEqual([
      "pages",
      "layout",
    ]);
  });

  it("sends checkout prefixes without marking the purge as HTML-affecting", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await purgeStorefrontForGroups(["checkout"], {
      PURGE_URL: "https://storefront.example.com/api/purge-cache",
      PURGE_TOKEN: "secret-token",
    } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">);

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["checkout"],
      prefixes: [
        "global_shipping_cities",
        "shipping_zones_",
        "shipping_areas_",
        "global_shipping_methods",
        "checkout_config",
        "global_checkout_language",
      ],
      bumpVersion: false,
    });
  });

  it("invalidates API KV prefixes before awaiting the matching storefront purge", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateApiAndStorefrontGroups(["layout"], {
      CACHE: kv,
      PURGE_URL: "https://storefront.example.com/api/purge-cache",
      PURGE_TOKEN: "secret-token",
    } as unknown as Env);

    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:header:" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:footer:" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:navigation:" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groups: ["layout"],
      prefixes: expect.arrayContaining(["storefront_layout_", "global_header_data"]),
      bumpVersion: true,
    });
  });

  it("bumps API cache fences before listing group cache keys", async () => {
    const calls: string[] = [];
    const kv = {
      put: vi.fn(async () => {
        calls.push("put");
      }),
      list: vi.fn(async () => {
        calls.push("list");
        return { keys: [], list_complete: true };
      }),
      delete: vi.fn(),
    };

    await invalidateGroups(["layout"], kv as unknown as KVNamespace);

    expect(kv.put).toHaveBeenCalledWith(
      "sc:_api_cache_fence:api%3Aheader%3A",
      expect.any(String),
      { expirationTtl: 86400 * 30 },
    );
    expect(calls.indexOf("put")).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf("list")).toBeGreaterThan(calls.indexOf("put"));
  });

  it("invalidates API KV prefixes before scheduling the matching storefront purge", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateApiAndScheduleStorefrontGroups(["layout"], {
      env: {
        CACHE: kv,
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as unknown as Env,
      executionCtx: { waitUntil } as unknown as ExecutionContext,
    });

    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:header:" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:footer:" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:navigation:" });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groups: ["layout"],
      bumpVersion: true,
    });
  });

  it("enqueues scheduled storefront purges when the durable cache queue is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const queueSend = vi.fn<(message: unknown) => Promise<void>>(async () => undefined);
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateApiAndScheduleStorefrontGroups(["layout"], {
      env: {
        CACHE: kv,
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
        STOREFRONT_CACHE_QUEUE: { send: queueSend },
      } as unknown as Env,
      executionCtx: { waitUntil } as unknown as ExecutionContext,
    }, {
      htmlPaths: ["/about-us?utm_source=test"],
    });

    expect(queueSend).toHaveBeenCalledTimes(1);
    expect(waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(queueSend.mock.calls[0]?.[0]).toMatchObject({
      type: "storefront.cache_purge",
      operationId: expect.any(String),
      groups: ["layout"],
      prefixes: expect.arrayContaining(["storefront_layout_", "global_header_data"]),
      htmlPaths: ["/about-us"],
      bumpVersion: true,
      source: "api-groups",
      requestedAt: expect.any(Number),
    });
  });

  it("falls back to direct scheduled purge when the durable cache queue send fails", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invalidateApiAndScheduleStorefrontGroups(["checkout"], {
        env: {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
          STOREFRONT_CACHE_QUEUE: {
            send: vi.fn(async () => {
              throw new Error("queue unavailable");
            }),
          },
        } as unknown as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      }),
    ).resolves.toBeUndefined();

    expect(consoleError).toHaveBeenCalledWith(
      "[Cache] Failed to enqueue storefront cache purge:",
      expect.any(Error),
    );
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groups: ["checkout"],
      prefixes: expect.arrayContaining(["checkout_config"]),
      bumpVersion: false,
    });
  });

  it("does not fail scheduled non-catalog writes when the storefront purge rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network connection lost"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invalidateApiAndScheduleStorefrontGroups(["pages", "layout"], {
        env: {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
        } as unknown as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      }),
    ).resolves.toBeUndefined();

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await expect(purgePromise).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[Cache] Storefront prefix purge failed:",
      expect.any(Error),
    );
  });

  it("does not purge when config or valid groups are missing", () => {
    const fetchMock = vi.fn();
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForGroups(
      ["not-a-real-group"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );
    triggerStorefrontPurgeForGroups(
      ["pages"],
      {} as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("derives bounded warm-only queue messages from completed purge messages", () => {
    const warmMessage = createStorefrontCacheWarmMessageForPurge({
      type: "storefront.cache_purge",
      operationId: "purge_op_1",
      groups: ["products"],
      prefixes: ["product_slug_fish"],
      exactKeys: ["product_variants_prod_1"],
      htmlPaths: ["/products/fish?utm_source=ad", "/products/fish"],
      bumpVersion: true,
      source: "catalog:products",
      requestedAt: 1_790_000_000_000,
    });

    expect(getStorefrontWarmPathsForPurge({
      type: "storefront.cache_purge",
      operationId: "checkout_op_1",
      groups: ["checkout"],
      prefixes: ["checkout_config", "global_shipping_methods"],
      bumpVersion: false,
      source: "api-groups",
      requestedAt: 1_790_000_000_000,
    })).toEqual([]);
    expect(warmMessage).toMatchObject({
      type: "storefront.cache_warm",
      operationId: "purge_op_1",
      paths: ["/", "/products/fish"],
      source: "catalog:products:warm",
      requestedAt: expect.any(Number),
    });
  });

  it("warms storefront paths and reports only retryable failures as retry-worthy", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/products/fish") {
        return new Response("ok", { status: 200 });
      }
      if (pathname === "/gone") {
        return new Response("gone", { status: 404 });
      }
      return new Response("busy", { status: 503 });
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await warmStorefrontHtmlPaths(
      ["/products/fish?utm_source=ad", "/gone", "/busy"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
    );

    expect(result).toMatchObject({
      attempted: true,
      ok: false,
      paths: ["/products/fish", "/gone", "/busy"],
      successful: 1,
      skipped: 1,
      retryableFailures: ["/busy (503)"],
      skippedFailures: ["/gone (404)"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL("/products/fish", "https://storefront.example.com"),
      expect.objectContaining({
        headers: expect.objectContaining({
          "Cache-Control": "no-cache",
          "X-Cache-Warm": "true",
        }),
      }),
    );
  });

  it("warms storefront paths in small batches instead of fanning out every path", async () => {
    const pendingResponses: Array<{
      path: string;
      resolve: (response: Response) => void;
    }> = [];
    const fetchMock = vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      pendingResponses.push({
        path: new URL(String(input)).pathname,
        resolve,
      });
    }));

    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = warmStorefrontHtmlPaths(
      ["/one", "/two", "/three"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(pendingResponses.map((pending) => pending.path)).toEqual(["/one", "/two"]);

    pendingResponses[0]?.resolve(new Response("ok", { status: 200 }));
    pendingResponses[1]?.resolve(new Response("ok", { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(pendingResponses.map((pending) => pending.path)).toEqual(["/one", "/two", "/three"]);

    pendingResponses[2]?.resolve(new Response("ok", { status: 200 }));
    await expect(resultPromise).resolves.toMatchObject({
      attempted: true,
      ok: true,
      successful: 3,
    });
  });

  it("schedules product catalog storefront purges with dependent collection caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateCatalogCaches("products", {
      env: {
        CACHE: kv,
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as unknown as Env,
      executionCtx: { waitUntil } as unknown as ExecutionContext,
    });

    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:attributes:filterable" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:attributes:category" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:attributes:category-slug" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:attributes:search-filters" });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:categories:" });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));

    expect(body).toMatchObject({
      groups: ["products", "search", "collections", "attributes"],
      bumpVersion: true,
      htmlPaths: ["/search"],
    });
    expect(body.prefixes).toEqual(
      expect.arrayContaining([
        "product_slug_",
        "all_products_",
        "collection_by_id_",
        "filterable_attrs_",
        "global_all_collections",
      ]),
    );
  });

  it("invalidates category-products API cache when discounts change product cards", async () => {
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
      put: vi.fn(),
    };

    await invalidateCatalogCaches("discounts", {
      env: {
        CACHE: kv,
      } as unknown as Env,
    });

    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:categories:" });
    expect(kv.list).toHaveBeenCalledWith({
      prefix: `sc:${PRODUCT_API_CACHE_NAMESPACE}`,
    });
    expect(kv.list).not.toHaveBeenCalledWith({ prefix: "sc:api:products:" });
    expect(kv.put).toHaveBeenCalledWith(
      "sc:_api_cache_fence:api%3Aproducts%3Av2%3A",
      expect.any(String),
      { expirationTtl: 86400 * 30 },
    );
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:search:" });
  });

  it("schedules category catalog purges with canonical listing HTML warm paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateCatalogCaches("categories", {
      env: {
        CACHE: kv,
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as unknown as Env,
      executionCtx: { waitUntil } as unknown as ExecutionContext,
    }, {
      htmlPaths: [
        "/categories/fish?page=1&sortBy=newest&utm_source=ad",
        "/categories/fish",
      ],
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groups: ["categories", "products", "search", "collections", "layout"],
      bumpVersion: true,
      htmlPaths: ["/search", "/categories/fish"],
    });
  });

  it("does not fail catalog writes when the scheduled storefront purge rejects", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network connection lost"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      invalidateCatalogCaches("discounts", {
        env: {
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
        } as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      }),
    ).resolves.toBeUndefined();

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await expect(purgePromise).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      "[Cache] Storefront prefix purge failed:",
      expect.any(Error),
    );
  });

  it("builds targeted product availability cache keys without overbroad slug prefixes", () => {
    const subjects = [
      { productId: "prod_1", slug: "phone" },
      { productId: "prod_2", slug: "phone-case" },
      { productId: "prod_1", slug: "phone" },
    ];

    expect(collectProductAvailabilityCacheInvalidation(subjects)).toEqual({
      apiKeys: [
        "api:products:v2:/api/v1/products",
        "api:products:v2:/api/v1/products/feed",
        "api:products:v2:/api/v1/products/sitemap",
        "api:products:v2:/api/v1/products/phone",
        "api:products:v2:/api/v1/products/phone-case",
        "api:products:v2:/api/v1/products/search",
      ],
      apiPatterns: [
        "api:products:v2:/api/v1/products?*",
        "api:products:v2:/api/v1/products/feed?*",
        "api:products:v2:/api/v1/products/sitemap?*",
        "api:products:v2:/api/v1/products/phone?*",
        "api:products:v2:/api/v1/products/phone-case?*",
        "api:products:v2:/api/v1/products/search?*",
        "api:search:*",
      ],
      storefrontPrefixes: [
        "product_slug_phone",
        "product_variants_prod_1",
        "product_slug_phone-case",
        "product_variants_prod_2",
        "all_products_",
        "category_products_",
        "feed_products_",
        "sitemap_products_",
      ],
      storefrontHtmlPaths: ["/products/phone", "/products/phone-case"],
    });

    expect(getProductAvailabilityApiCacheKeys(subjects)).toEqual([
      "api:products:v2:/api/v1/products",
      "api:products:v2:/api/v1/products/feed",
      "api:products:v2:/api/v1/products/sitemap",
      "api:products:v2:/api/v1/products/phone",
      "api:products:v2:/api/v1/products/phone-case",
      "api:products:v2:/api/v1/products/search",
    ]);
    expect(getProductAvailabilityApiCachePatterns(subjects)).toEqual([
      "api:products:v2:/api/v1/products?*",
      "api:products:v2:/api/v1/products/feed?*",
      "api:products:v2:/api/v1/products/sitemap?*",
      "api:products:v2:/api/v1/products/phone?*",
      "api:products:v2:/api/v1/products/phone-case?*",
      "api:products:v2:/api/v1/products/search?*",
      "api:search:*",
    ]);
    expect(getProductAvailabilityStorefrontPrefixes(subjects)).toEqual([
      "product_slug_phone",
      "product_variants_prod_1",
      "product_slug_phone-case",
      "product_variants_prod_2",
      "all_products_",
      "category_products_",
      "feed_products_",
      "sitemap_products_",
    ]);
  });

  it("builds exact collection detail invalidation without clearing unrelated collections", () => {
    expect(collectCollectionCacheInvalidation([
      { id: "col_manual" },
      { id: "col_dynamic" },
      { id: "col_manual" },
    ])).toEqual({
      apiKeys: [
        "api:collections:/api/v1/collections/col_manual",
        "api:collections:/api/v1/collections/col_dynamic",
      ],
      apiPatterns: [
        "api:collections:/api/v1/collections/col_manual?*",
        "api:collections:/api/v1/collections/col_dynamic?*",
      ],
      storefrontPrefixes: [
        "collection_by_id_col_manual::",
        "collection_by_id_col_dynamic::",
      ],
      storefrontHtmlPaths: [
        "/collections/col_manual",
        "/collections/col_dynamic",
      ],
    });
  });

  it("invalidates product availability exact cache families without deleting sibling slugs", async () => {
    const store = new Set([
      "sc:api:products:v2:/api/v1/products/phone",
      "sc:api:products:v2:/api/v1/products/phone#f:old",
      "sc:api:products:v2:/api/v1/products/phone-case#f:old",
      "sc:api:products:/api/v1/products/phone#f:retired",
    ]);
    const kv = {
      put: vi.fn(),
      list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
        keys: [...store]
          .filter((name) => !prefix || name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };

    await invalidateProductAvailabilityCacheSubjects(
      [{ productId: "prod_1", slug: "phone" }],
      { env: { CACHE: kv } as unknown as Env },
    );

    expect(store.has("sc:api:products:v2:/api/v1/products/phone")).toBe(false);
    expect(store.has("sc:api:products:v2:/api/v1/products/phone#f:old")).toBe(false);
    expect(store.has("sc:api:products:v2:/api/v1/products/phone-case#f:old")).toBe(
      true,
    );
    expect(
      store.has("sc:api:products:/api/v1/products/phone#f:retired"),
    ).toBe(true);
  });

  it("invalidates targeted product availability API KV before scheduling storefront prefixes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateProductAvailabilityCacheSubjects(
      [{ productId: "prod_1", slug: "phone" }],
      {
        env: {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
        } as unknown as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      },
    );

    expect(kv.delete).toHaveBeenCalledWith("sc:api:products:v2:/api/v1/products/phone");
    expect(kv.delete).toHaveBeenCalledWith("sc:api:products:v2:/api/v1/products");
    expect(kv.delete).toHaveBeenCalledWith("sc:api:products:v2:/api/v1/products/feed");
    expect(kv.delete).toHaveBeenCalledWith("sc:api:products:v2:/api/v1/products/sitemap");
    expect(kv.delete).toHaveBeenCalledWith("sc:api:products:v2:/api/v1/products/search");
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:products:v2:/api/v1/products?",
    });
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:products:v2:/api/v1/products/feed?",
    });
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:products:v2:/api/v1/products/sitemap?",
    });
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:products:v2:/api/v1/products/phone?",
    });
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:products:v2:/api/v1/products/search?",
    });
    expect(kv.list).toHaveBeenCalledWith({ prefix: "sc:api:search:" });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["products"],
      prefixes: [],
      exactKeys: [
        "product_slug_phone",
        "product_variants_prod_1",
        "all_products_",
        "category_products_",
        "feed_products_",
        "sitemap_products_",
      ],
      htmlPaths: ["/products/phone"],
      bumpVersion: false,
    });
  });

  it("adds CMS shortcode page paths to product availability purges", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };
    const pageQuery = {
      from: vi.fn(() => pageQuery),
      where: vi.fn(() =>
        Promise.resolve([
          {
            id: "page_1",
            slug: "stock-alert",
            content: '<p>[product slug="phone"]</p>',
          },
        ]),
      ),
    };
    const db = {
      select: vi.fn(() => pageQuery),
      selectDistinct: vi.fn(() => {
        const collectionQuery = {
          from: vi.fn(() => collectionQuery),
          where: vi.fn(() => Promise.resolve([])),
        };
        return collectionQuery;
      }),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateProductAvailabilityCacheSubjects(
      [{ productId: "prod_1", slug: "phone" }],
      {
        env: {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
        } as unknown as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      },
      db as never,
    );

    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:storefront:page:/api/v1/storefront/pages/slug/stock-alert",
    });
    expect(waitUntil).toHaveBeenCalledTimes(1);

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["products"],
      prefixes: ["page_render_stock-alert_"],
      exactKeys: [
        "product_slug_phone",
        "product_variants_prod_1",
        "all_products_",
        "category_products_",
        "feed_products_",
        "sitemap_products_",
      ],
      htmlPaths: ["/products/phone", "/stock-alert"],
      bumpVersion: false,
    });
  });

  it("invalidates only collection detail caches affected by availability", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    const kv = {
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      delete: vi.fn(),
    };
    const pageQuery = {
      from: vi.fn(() => pageQuery),
      where: vi.fn(() => Promise.resolve([])),
    };
    const collectionQuery = {
      from: vi.fn(() => collectionQuery),
      where: vi.fn(() => Promise.resolve([
        { id: "col_manual" },
        { id: "col_dynamic" },
      ])),
    };
    const db = {
      select: vi.fn(() => pageQuery),
      selectDistinct: vi.fn(() => collectionQuery),
    };

    vi.stubGlobal("fetch", fetchMock);

    await invalidateProductAvailabilityCacheSubjects(
      [{ productId: "prod_1", slug: "phone", categoryId: "cat_1" }],
      {
        env: {
          CACHE: kv,
          PURGE_URL: "https://storefront.example.com/api/purge-cache",
          PURGE_TOKEN: "secret-token",
        } as unknown as Env,
        executionCtx: { waitUntil } as unknown as ExecutionContext,
      },
      db as never,
    );

    expect(kv.delete).toHaveBeenCalledWith(
      "sc:api:collections:/api/v1/collections/col_manual",
    );
    expect(kv.delete).toHaveBeenCalledWith(
      "sc:api:collections:/api/v1/collections/col_dynamic",
    );
    expect(kv.list).toHaveBeenCalledWith({
      prefix: "sc:api:collections:/api/v1/collections/col_manual?",
    });
    expect(kv.list).not.toHaveBeenCalledWith({ prefix: "sc:api:collections:" });

    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      groups: ["products", "collections"],
      exactKeys: expect.arrayContaining([
        "collection_by_id_col_manual::",
        "collection_by_id_col_dynamic::",
      ]),
      htmlPaths: expect.arrayContaining([
        "/collections/col_manual",
        "/collections/col_dynamic",
      ]),
      bumpVersion: false,
    });
  });

  it("resolves manual, dynamic, and featured collection dependencies in one D1-safe query", async () => {
    const query = {
      from: vi.fn(() => query),
      where: vi.fn(() => Promise.resolve([
        { id: "col_manual" },
        { id: "col_dynamic" },
        { id: "col_featured" },
        { id: "col_manual" },
      ])),
    };
    const selectDistinct = vi.fn(() => query);

    await expect(resolveCollectionCacheTargets(
      { selectDistinct } as never,
      {
        productIds: Array.from({ length: 150 }, (_, index) => `prod_${index}`),
        categoryIds: Array.from({ length: 150 }, (_, index) => `cat_${index}`),
      },
    )).resolves.toEqual([
      { id: "col_manual" },
      { id: "col_dynamic" },
      { id: "col_featured" },
    ]);
    expect(selectDistinct).toHaveBeenCalledTimes(1);
  });

  it("resolves product availability subjects across order, product, and variant inputs", async () => {
    const responses = [
      [
        { productId: "prod_1", slug: "phone" },
        { productId: "prod_2", slug: "case" },
      ],
      [{ productId: "prod_3", slug: "charger" }],
      [
        { productId: "prod_2", slug: "case" },
        { productId: "prod_4", slug: "cable" },
      ],
    ];
    const selectDistinct = vi.fn(() => {
      const rows = responses.shift() ?? [];
      const query = {
        from: vi.fn(() => query),
        innerJoin: vi.fn(() => query),
        where: vi.fn(() => Promise.resolve(rows)),
      };
      return query;
    });

    await expect(
      resolveProductAvailabilityCacheSubjects(
        { selectDistinct } as never,
        {
          orderIds: ["order_1", "order_1"],
          productIds: ["prod_3"],
          variantIds: ["var_2"],
        },
      ),
    ).resolves.toEqual([
      { productId: "prod_1", slug: "phone" },
      { productId: "prod_2", slug: "case" },
      { productId: "prod_3", slug: "charger" },
      { productId: "prod_4", slug: "cable" },
    ]);
    expect(selectDistinct).toHaveBeenCalledTimes(3);
  });

  it("chunks product availability subject lookups below D1's binding limit", async () => {
    const where = vi.fn(() => Promise.resolve([]));
    const selectDistinct = vi.fn(() => {
      const query = {
        from: vi.fn(() => query),
        innerJoin: vi.fn(() => query),
        where,
      };
      return query;
    });

    await resolveProductAvailabilityCacheSubjects(
      { selectDistinct } as never,
      {
        productIds: Array.from(
          { length: D1_CACHE_SUBJECT_ID_CHUNK_SIZE + 1 },
          (_, index) => `prod_${index}`,
        ),
      },
    );

    expect(selectDistinct).toHaveBeenCalledTimes(2);
    expect(where).toHaveBeenCalledTimes(2);
  });
});

describe("normalizeStorefrontPurgeUrl", () => {
  it("removes legacy URL credential params while preserving ordinary params", () => {
    expect(
      normalizeStorefrontPurgeUrl(
        "https://storefront.example.com/api/purge-cache?token=secret&mode=fast&access_token=other-secret",
      ),
    ).toBe("https://storefront.example.com/api/purge-cache?mode=fast");
  });
});
