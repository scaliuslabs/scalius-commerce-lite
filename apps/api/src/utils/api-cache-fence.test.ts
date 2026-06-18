import { describe, expect, it, vi } from "vitest";
import {
  API_CACHE_FENCE_GLOBAL_SCOPE,
  deleteVersionedCacheKeyFamily,
  getApiCacheFenceScopeForPattern,
  getApiCacheFenceScopesForKey,
  withApiCacheFenceToken,
} from "./api-cache-fence";

function createKvStore(initialKeys: string[] = []) {
  const store = new Set(initialKeys);
  const kv = {
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
      keys: [...store]
        .filter((name) => !prefix || name.startsWith(prefix))
        .map((name) => ({ name })),
      list_complete: true,
    })),
  };
  return { kv, store };
}

describe("api cache fences", () => {
  it("derives stable scopes for global, prefix, exact, and query variants", () => {
    expect(
      getApiCacheFenceScopesForKey(
        "api:products:/api/v1/products/search?limit=20&page=2",
        "api:products:",
      ),
    ).toEqual([
      API_CACHE_FENCE_GLOBAL_SCOPE,
      "api:products:",
      "api:products:/api/v1/products/search",
      "api:products:/api/v1/products/search?",
    ]);
  });

  it("matches known prefixes without crossing category/category-slug boundaries", () => {
    const scopes = getApiCacheFenceScopesForKey(
      "api:attributes:category-slug/api/v1/attributes/category-slug/drinks",
      "api:attributes:category-slug",
      ["api:attributes:category", "api:attributes:category-slug"],
    );

    expect(scopes).toContain("api:attributes:category-slug");
    expect(scopes).not.toContain("api:attributes:category");
  });

  it("normalizes invalidation patterns into fence scopes", () => {
    expect(getApiCacheFenceScopeForPattern("api:search:*")).toBe("api:search:");
    expect(getApiCacheFenceScopeForPattern("api:products:/sku?*")).toBe(
      "api:products:/sku?",
    );
  });

  it("adds a compact fence token to physical cache keys", () => {
    expect(
      withApiCacheFenceToken("api:products:/api/v1/products", {
        token: "abcdef0123456789",
      }),
    ).toBe("api:products:/api/v1/products#f:abcdef0123456789");
  });

  it("deletes an exact cache key family without deleting sibling slugs", async () => {
    const { kv, store } = createKvStore([
      "sc:api:products:/api/v1/products/phone",
      "sc:api:products:/api/v1/products/phone#f:old",
      "sc:api:products:/api/v1/products/phone-case#f:old",
    ]);

    await deleteVersionedCacheKeyFamily(
      "api:products:/api/v1/products/phone",
      kv as unknown as KVNamespace,
    );

    expect(kv.delete).toHaveBeenCalledWith(
      "sc:api:products:/api/v1/products/phone",
    );
    expect(kv.delete).toHaveBeenCalledWith(
      "sc:api:products:/api/v1/products/phone#f:old",
    );
    expect(store.has("sc:api:products:/api/v1/products/phone-case#f:old")).toBe(
      true,
    );
  });
});
