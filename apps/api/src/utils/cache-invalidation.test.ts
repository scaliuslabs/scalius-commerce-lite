import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_CACHE_GROUPS,
  INVALIDATION_GROUPS,
  WIDGET_CACHE_GROUPS,
  getGroupsForPath,
  getStorefrontPrefixesForGroups,
  invalidateApiAndScheduleStorefrontGroups,
  invalidateApiAndStorefrontGroups,
  invalidateCatalogCaches,
  normalizeStorefrontPurgeUrl,
  purgeStorefrontForGroups,
  purgeStorefrontForPrefixes,
  triggerStorefrontPurgeForGroups,
  triggerStorefrontPurgeForPrefixes,
} from "./cache-invalidation";

describe("catalog cache groups", () => {
  it("maps catalog admin writes to every storefront cache they can affect", () => {
    expect(getGroupsForPath("/api/v1/admin/products/prod_123")).toEqual([
      "products",
      "search",
      "collections",
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
    expect(getGroupsForPath("/api/v1/admin/inventory/stock-set")).toEqual([
      "products",
      "search",
      "collections",
    ]);
    expect(getGroupsForPath("/api/v1/admin/widgets/wid_123")).toEqual(["widgets"]);
    expect(getGroupsForPath("/api/v1/admin/attributes/attr_123")).toEqual([
      "attributes",
      "products",
    ]);

    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.products])).toEqual(
      expect.arrayContaining([
        "product_slug_",
        "all_products_",
        "collection_by_id_",
        "global_all_collections",
        "widgets_scope_",
      ]),
    );
    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.collections])).toEqual(
      expect.arrayContaining(["collection_by_id_", "widgets_scope_", "storefront_homepage_"]),
    );
    expect(getStorefrontPrefixesForGroups([...CATALOG_CACHE_GROUPS.categories])).toEqual(
      expect.arrayContaining([
        "category_slug_",
        "global_navigation_",
        "storefront_layout_",
      ]),
    );
    expect(getStorefrontPrefixesForGroups([...WIDGET_CACHE_GROUPS])).toEqual(
      expect.arrayContaining([
        "widget_",
        "global_homepage_widgets",
        "page_render_",
        "widgets_scope_",
        "storefront_homepage_",
      ]),
    );
    expect(getStorefrontPrefixesForGroups([...WIDGET_CACHE_GROUPS])).not.toEqual(
      expect.arrayContaining([
        "product_slug_",
        "category_slug_",
        "collection_by_id_",
        "global_seo_settings",
      ]),
    );
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

  it("can be awaited by content writes that need immediate storefront consistency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await purgeStorefrontForGroups([...WIDGET_CACHE_GROUPS], {
      PURGE_URL: "https://storefront.example.com/api/purge-cache",
      PURGE_TOKEN: "secret-token",
    } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">);

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init?.body));
    expect(body).not.toHaveProperty("token");
    expect(body).toMatchObject({
      groups: ["widgets"],
      bumpVersion: true,
    });
    expect(body.prefixes).toEqual(
      expect.arrayContaining(["widget_", "page_render_", "widgets_scope_"]),
    );
  });

  it("can purge exact storefront prefixes without expanding to coarse groups", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await purgeStorefrontForPrefixes(
      ["widget_wid_1", "widgets_scope_product_prod_1"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["widgets"], bumpVersion: false },
    );

    expect(result).toEqual({ attempted: true, ok: true, status: 200 });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["widgets"],
      prefixes: ["widget_wid_1", "widgets_scope_product_prod_1"],
      bumpVersion: false,
    });
  });

  it("schedules exact storefront prefix purges through waitUntil", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    const waitUntil = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    triggerStorefrontPurgeForPrefixes(
      ["widget_wid_1", "widgets_scope_product_prod_1"],
      {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Pick<Env, "PURGE_URL" | "PURGE_TOKEN">,
      { groups: ["widgets"], bumpVersion: false },
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["widgets"],
      prefixes: ["widget_wid_1", "widgets_scope_product_prod_1"],
      bumpVersion: false,
    });
  });

  it("invalidates public checkout config KV cache with the checkout group", () => {
    const checkoutGroup = INVALIDATION_GROUPS.checkout;
    expect(checkoutGroup).toBeDefined();
    expect(checkoutGroup!.kvPrefixes).toEqual(
      expect.arrayContaining(["api:checkout:config:"]),
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
      "layout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/currency")).toEqual([
      "layout",
      "checkout",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/hero-sliders")).toEqual([
      "homepage",
    ]);
    expect(getGroupsForPath("/api/v1/admin/settings/seo")).toEqual(["homepage"]);
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
      bumpVersion: true,
    });
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
      "[Cache] Storefront group purge failed:",
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

  it("schedules product catalog storefront purges with dependent collection caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    const waitUntil = vi.fn();

    vi.stubGlobal("fetch", fetchMock);

    await invalidateCatalogCaches("products", {
      env: {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Env,
      executionCtx: { waitUntil } as unknown as ExecutionContext,
    });

    expect(waitUntil).toHaveBeenCalledTimes(1);
    const purgePromise = waitUntil.mock.calls[0]?.[0] as Promise<unknown>;
    await purgePromise;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body));

    expect(body).toMatchObject({
      groups: ["products", "search", "collections"],
      bumpVersion: true,
    });
    expect(body.prefixes).toEqual(
      expect.arrayContaining([
        "product_slug_",
        "all_products_",
        "collection_by_id_",
        "global_all_collections",
        "widgets_scope_",
      ]),
    );
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
      "[Cache] Storefront group purge failed:",
      expect.any(Error),
    );
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
