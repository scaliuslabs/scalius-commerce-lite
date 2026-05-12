import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_CACHE_GROUPS,
  getGroupsForPath,
  getStorefrontPrefixesForGroups,
  invalidateCatalogCaches,
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

    expect(String(url)).toBe(
      "https://storefront.example.com/api/purge-cache?token=secret-token",
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      groups: ["pages"],
      prefixes: ["page_slug_", "page_render_", "all_pages_"],
      bumpVersion: true,
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

  it("schedules product catalog purges with dependent collection caches", async () => {
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
