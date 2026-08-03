import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ADMIN_PATH_TO_GROUPS,
  CATALOG_CACHE_GROUPS,
  INVALIDATION_GROUPS,
  SETTINGS_CACHE_DEPENDENCIES,
  getGroupsForPath,
  invalidateApiAndStorefrontGroups,
  invalidateCatalogCaches,
  invalidateGroups,
  invalidateProductAvailabilityCaches,
  normalizeStorefrontPurgeUrl,
  purgeStorefrontForGroups,
} from "./cache-invalidation";

describe("cache invalidation domains", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps every mutation mapping inside the declared domain set", () => {
    for (const groups of Object.values(ADMIN_PATH_TO_GROUPS)) {
      expect(groups.every((group) => group in INVALIDATION_GROUPS)).toBe(true);
    }
    for (const dependency of Object.values(SETTINGS_CACHE_DEPENDENCIES)) {
      expect(dependency.groups.every((group) => group in INVALIDATION_GROUPS)).toBe(true);
    }
    for (const groups of Object.values(CATALOG_CACHE_GROUPS)) {
      expect(groups.every((group) => group in INVALIDATION_GROUPS)).toBe(true);
    }
  });

  it("maps a concrete admin mutation to its bounded cache domains", () => {
    expect(getGroupsForPath("/api/v1/admin/products/p_1")).toEqual(
      CATALOG_CACHE_GROUPS.products,
    );
    expect(getGroupsForPath("/api/v1/unknown")).toEqual([]);
  });

  it("strips bearer-like query values from the storefront purge URL", () => {
    expect(
      normalizeStorefrontPurgeUrl(
        "https://shop.example/api/purge-cache?token=secret&mode=fast",
      ),
    ).toBe("https://shop.example/api/purge-cache?mode=fast");
  });

  it("deduplicates and validates storefront cache domains", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      purgeStorefrontForGroups(["products", "unknown", "products"], {
        PURGE_URL: "https://shop.example/api/purge-cache?token=old",
        PURGE_TOKEN: "new-secret",
      } as never),
    ).resolves.toEqual({ attempted: true, ok: true, status: 204 });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://shop.example/api/purge-cache",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer new-secret" }),
        body: JSON.stringify({ groups: ["products"] }),
      }),
    );
  });

  it("makes missing storefront configuration an explicit bounded skip", async () => {
    await expect(purgeStorefrontForGroups(["products"])).resolves.toEqual({
      attempted: false,
      ok: false,
      skippedReason: "missing-config",
    });
  });

  it("purges the native API entrypoint by validated tags", async () => {
    const purgeGroups = vi.fn().mockResolvedValue(undefined);
    await invalidateGroups(["products", "unknown", "products"], undefined, {
      cleanupExecutionCtx: {
        waitUntil: vi.fn(),
        exports: { PublicApi: { purgeGroups } },
      },
    });
    expect(purgeGroups).toHaveBeenCalledWith(["products"]);
  });

  it("purges API and storefront entrypoints together", async () => {
    const purgeGroups = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await invalidateApiAndStorefrontGroups(
      ["layout", "layout"],
      {
        PURGE_URL: "https://shop.example/api/purge-cache",
        PURGE_TOKEN: "secret",
      } as never,
      {
        cleanupExecutionCtx: {
          waitUntil: vi.fn(),
          exports: { PublicApi: { purgeGroups } },
        },
      },
    );

    expect(purgeGroups).toHaveBeenCalledWith(["layout"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates a catalog domain without KV scans or path expansion", async () => {
    const purgeGroups = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await invalidateCatalogCaches("products", {
      env: {
        PURGE_URL: "https://shop.example/api/purge-cache",
        PURGE_TOKEN: "secret",
      } as never,
      executionCtx: {
        waitUntil: vi.fn(),
        exports: { PublicApi: { purgeGroups } },
      },
    });

    expect(purgeGroups).toHaveBeenCalledWith(CATALOG_CACHE_GROUPS.products);
  });

  it("uses one coarse product tag for post-commit availability changes", async () => {
    const purgeGroups = vi.fn().mockResolvedValue(undefined);
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await invalidateProductAvailabilityCaches(
      {} as never,
      { orderIds: ["order_1"] },
      {
        env: {
          PURGE_URL: "https://shop.example/api/purge-cache",
          PURGE_TOKEN: "secret",
        } as never,
        executionCtx: {
          waitUntil: vi.fn(),
          exports: { PublicApi: { purgeGroups } },
        },
      },
    );

    expect(purgeGroups).toHaveBeenCalledWith(["products"]);
  });
});
