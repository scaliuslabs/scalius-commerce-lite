import { describe, expect, it, vi } from "vitest";
import {
  buildExactCacheGenerationKey,
  bumpExactCacheGenerations,
  cacheGenerationKeyForLogicalKey,
  htmlPathCacheKeyFromPath,
  productSlugCacheKeyFromPath,
  resolveExactCacheGeneration,
  shouldUseExactCacheGeneration,
} from "./cache-generations";

describe("exact cache generations", () => {
  it("recognizes product exact cache keys and product HTML paths", () => {
    expect(shouldUseExactCacheGeneration("product_slug_fish")).toBe(true);
    expect(shouldUseExactCacheGeneration("product_variants_prod_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("feed_products_page=2&limit=5")).toBe(true);
    expect(shouldUseExactCacheGeneration("sitemap_products_page=2")).toBe(true);
    expect(shouldUseExactCacheGeneration("all_products_default")).toBe(true);
    expect(shouldUseExactCacheGeneration("category_products_shoes_default")).toBe(true);
    expect(shouldUseExactCacheGeneration("collection_by_id_col_1::page=2")).toBe(true);
    expect(shouldUseExactCacheGeneration("page_slug_about-us")).toBe(true);
    expect(shouldUseExactCacheGeneration("page_render_about-us_build")).toBe(true);
    expect(shouldUseExactCacheGeneration("all_pages_default")).toBe(true);
    expect(shouldUseExactCacheGeneration("sitemap_pages_")).toBe(true);
    expect(shouldUseExactCacheGeneration("page_html_")).toBe(true);
    expect(shouldUseExactCacheGeneration("html_path_/categories/drinks")).toBe(true);
    expect(shouldUseExactCacheGeneration("checkout_config")).toBe(true);
    expect(shouldUseExactCacheGeneration("global_shipping_methods")).toBe(true);
    expect(shouldUseExactCacheGeneration("shipping_zones_city_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("shipping_areas_zone_1")).toBe(true);
    expect(cacheGenerationKeyForLogicalKey("shipping_zones_city_1")).toBe(
      "shipping_zones_",
    );
    expect(cacheGenerationKeyForLogicalKey("shipping_areas_zone_1")).toBe(
      "shipping_areas_",
    );
    expect(cacheGenerationKeyForLogicalKey("feed_products_page=2&limit=5")).toBe(
      "feed_products_",
    );
    expect(cacheGenerationKeyForLogicalKey("sitemap_products_page=2")).toBe(
      "sitemap_products_",
    );
    expect(cacheGenerationKeyForLogicalKey("all_products_default")).toBe(
      "all_products_",
    );
    expect(cacheGenerationKeyForLogicalKey("category_products_shoes_default")).toBe(
      "category_products_",
    );
    expect(cacheGenerationKeyForLogicalKey("collection_by_id_col_1::page=2")).toBe(
      "collection_by_id_col_1::",
    );
    expect(cacheGenerationKeyForLogicalKey("collection_by_id_col_1::")).toBe(
      "collection_by_id_col_1::",
    );
    expect(cacheGenerationKeyForLogicalKey("page_slug_about-us")).toBe(
      "page_slug_",
    );
    expect(cacheGenerationKeyForLogicalKey("page_render_about-us_build")).toBe(
      "page_render_",
    );
    expect(cacheGenerationKeyForLogicalKey("all_pages_default")).toBe(
      "all_pages_",
    );

    expect(productSlugCacheKeyFromPath("/products/fish?size=m")).toBe(
      "product_slug_fish",
    );
    expect(productSlugCacheKeyFromPath("/categories/fish")).toBeNull();

    expect(htmlPathCacheKeyFromPath("/products/fish?size=m")).toBe(
      "product_slug_fish",
    );
    expect(htmlPathCacheKeyFromPath("/categories/drinks?sortBy=newest")).toBe(
      "html_path_/categories/drinks",
    );
    expect(htmlPathCacheKeyFromPath("/collections/col_1")).toBe(
      "html_path_/collections/col_1",
    );
    expect(htmlPathCacheKeyFromPath("/about-us")).toBe("page_html_");
    expect(htmlPathCacheKeyFromPath("/api/product-feed.xml")).toBe(
      "feed_products_",
    );
    expect(htmlPathCacheKeyFromPath("/api/product-feed.xml?page=2&limit=50")).toBe(
      "feed_products_",
    );
    expect(htmlPathCacheKeyFromPath("/api/facebook-feed.xml")).toBe(
      "feed_products_",
    );
    expect(htmlPathCacheKeyFromPath("/sitemap-products.xml?page=2")).toBe(
      "sitemap_products_",
    );
    expect(htmlPathCacheKeyFromPath("/sitemap-pages.xml?page=2")).toBe(
      "sitemap_pages_",
    );
    expect(htmlPathCacheKeyFromPath("/")).toBeNull();
    expect(htmlPathCacheKeyFromPath("/search?q=fish")).toBeNull();
    expect(htmlPathCacheKeyFromPath("/sitemap.xml")).toBeNull();
  });

  it("uses default generation when the exact key has not been bumped", async () => {
    const store = {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
    };

    const result = await resolveExactCacheGeneration({
      store,
      hostname: "storefront.example.com",
      logicalKey: "product_slug_fish",
      timeoutMs: 100,
    });

    expect(result).toEqual({ status: "available", generation: "0" });
    expect(store.get).toHaveBeenCalledWith(
      "g:storefront.example.com:product_slug_fish",
    );
    expect(store.put).not.toHaveBeenCalled();
  });

  it("bumps unique generation keys with a shared new generation value", async () => {
    const store = {
      get: vi.fn(),
      put: vi.fn(async () => undefined),
    };

    const result = await bumpExactCacheGenerations({
      store,
      hostname: "storefront.example.com",
      logicalKeys: ["product_slug_fish", "product_slug_fish", "product_variants_prod_1"],
    });

    expect(result).toHaveLength(2);
    expect(new Set(result.map((item) => item.generation)).size).toBe(1);
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "product_slug_fish"),
      expect.any(String),
    );
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "product_variants_prod_1"),
      expect.any(String),
    );
  });

  it("bumps all feed product cache pages as one generation family", async () => {
    const store = {
      get: vi.fn(),
      put: vi.fn(async () => undefined),
    };

    const result = await bumpExactCacheGenerations({
      store,
      hostname: "storefront.example.com",
      logicalKeys: ["feed_products_page=1", "feed_products_page=2"],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.logicalKey).toBe("feed_products_");
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "feed_products_"),
      expect.any(String),
    );
  });

  it("bumps all product sitemap cache pages as one generation family", async () => {
    const store = {
      get: vi.fn(),
      put: vi.fn(async () => undefined),
    };

    const result = await bumpExactCacheGenerations({
      store,
      hostname: "storefront.example.com",
      logicalKeys: ["sitemap_products_page=1", "sitemap_products_page=2"],
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.logicalKey).toBe("sitemap_products_");
    expect(store.put).toHaveBeenCalledOnce();
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "sitemap_products_"),
      expect.any(String),
    );
  });

  it("bumps product listing cache pages by list family", async () => {
    const store = {
      get: vi.fn(),
      put: vi.fn(async () => undefined),
    };

    const result = await bumpExactCacheGenerations({
      store,
      hostname: "storefront.example.com",
      logicalKeys: [
        "all_products_default",
        "all_products_page=2",
        "category_products_shoes_default",
        "category_products_bags_page=2",
      ],
    });

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.logicalKey)).toEqual([
      "all_products_",
      "category_products_",
    ]);
    expect(store.put).toHaveBeenCalledTimes(2);
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "all_products_"),
      expect.any(String),
    );
    expect(store.put).toHaveBeenCalledWith(
      buildExactCacheGenerationKey("storefront.example.com", "category_products_"),
      expect.any(String),
    );
  });
});
