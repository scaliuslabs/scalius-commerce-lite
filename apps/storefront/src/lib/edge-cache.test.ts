import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/build-id", () => ({ BUILD_ID: "test-build" }));

import { clearMemoryCache, setEdgeCacheContext, withEdgeCache } from "./edge-cache";

describe("withEdgeCache", () => {
  beforeEach(() => {
    clearMemoryCache();
    setEdgeCacheContext(null, null, "localhost", null);
  });

  afterEach(() => {
    clearMemoryCache();
    setEdgeCacheContext(null, null, "localhost", null);
  });

  it("dedupes concurrent fetches even when KV versioning is unavailable", async () => {
    let resolveFirstFetch: ((value: string) => void) | undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveFirstFetch = resolve;
        }),
    );

    const first = withEdgeCache("layout_data", fetcher);
    const duplicate = withEdgeCache("layout_data", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveFirstFetch?.("fresh-layout");

    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      "fresh-layout",
      "fresh-layout",
    ]);

    fetcher.mockResolvedValueOnce("next-layout");
    await expect(withEdgeCache("layout_data", fetcher)).resolves.toBe(
      "next-layout",
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("uses checkout family generations in L2 cache keys", async () => {
    const cache = {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    };
    const kvStore = {
      get: vi.fn(async () => "family-gen"),
      put: vi.fn(async () => undefined),
    };
    const fetcher = vi.fn(async () => ["zone-1"]);

    setEdgeCacheContext(
      cache as unknown as Cache,
      "4",
      "storefront.example.com",
      null,
      kvStore as unknown as KVNamespace,
      "storefront.example.com",
    );
    const result = await withEdgeCache("shipping_zones_city_1", fetcher);

    expect(result).toEqual(["zone-1"]);
    expect(kvStore.get).toHaveBeenCalledWith(
      "g:storefront.example.com:shipping_zones_",
    );
    expect(cache.match).toHaveBeenCalledWith(
      "https://storefront.example.com/_api-cache/shipping_zones_city_1?v=4&build=test-build&g=family-gen",
    );
    expect(cache.put).toHaveBeenCalledWith(
      "https://storefront.example.com/_api-cache/shipping_zones_city_1?v=4&build=test-build&g=family-gen",
      expect.any(Response),
    );
  });
});
