import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_CACHE_GROUPS,
  INVALIDATION_GROUPS,
  WIDGET_CACHE_GROUPS,
  getGroupsForPath,
  getStorefrontPrefixesForGroups,
  invalidateCatalogCaches,
  normalizeStorefrontPurgeUrl,
  purgeStorefrontForGroups,
  triggerStorefrontPurgeForGroups,
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
    expect(getGroupsForPath("/api/v1/admin/widgets/wid_123")).toEqual([
      "homepage",
      "pages",
      "products",
      "categories",
      "collections",
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
    expect(getStorefrontPrefixesForGroups([...WIDGET_CACHE_GROUPS])).toEqual(
      expect.arrayContaining([
        "global_homepage_widgets",
        "page_render_",
        "product_slug_",
        "category_slug_",
        "collection_by_id_",
        "widgets_scope_",
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
      groups: ["homepage", "pages", "products", "categories", "collections"],
      bumpVersion: true,
    });
    expect(body.prefixes).toEqual(
      expect.arrayContaining(["page_render_", "widgets_scope_", "collection_by_id_"]),
    );
  });

  it("invalidates public checkout config KV cache with the checkout group", () => {
    const checkoutGroup = INVALIDATION_GROUPS.checkout;
    expect(checkoutGroup).toBeDefined();
    expect(checkoutGroup!.kvPrefixes).toEqual(
      expect.arrayContaining(["api:checkout:config:"]),
    );
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

  it("purges product catalog caches with dependent collection caches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));

    vi.stubGlobal("fetch", fetchMock);

    await invalidateCatalogCaches("products", {
      env: {
        PURGE_URL: "https://storefront.example.com/api/purge-cache",
        PURGE_TOKEN: "secret-token",
      } as Env,
    });

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
