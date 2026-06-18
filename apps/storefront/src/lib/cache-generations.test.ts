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
    expect(shouldUseExactCacheGeneration("widget_wid_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("widgets_scope_product_prod_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("page_render_about-us_build")).toBe(true);
    expect(shouldUseExactCacheGeneration("html_path_/categories/drinks")).toBe(true);
    expect(shouldUseExactCacheGeneration("checkout_config")).toBe(true);
    expect(shouldUseExactCacheGeneration("global_shipping_methods")).toBe(true);
    expect(shouldUseExactCacheGeneration("shipping_zones_city_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("shipping_areas_zone_1")).toBe(true);
    expect(shouldUseExactCacheGeneration("all_products_default")).toBe(false);
    expect(cacheGenerationKeyForLogicalKey("shipping_zones_city_1")).toBe(
      "shipping_zones_",
    );
    expect(cacheGenerationKeyForLogicalKey("shipping_areas_zone_1")).toBe(
      "shipping_areas_",
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
    expect(htmlPathCacheKeyFromPath("/about-us")).toBe("html_path_/about-us");
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
});
