import { describe, expect, it } from "vitest";
import type { ProductFacet } from "@/lib/api";
import {
  buildProductListHref,
  countActiveProductListFilters,
  isIndexableProductListView,
  isMissingProductListPage,
  productListCanonicalUrl,
  productListMetaDescription,
  resolveProductListQueryState,
} from "./product-list-query";

const facets: ProductFacet[] = [
  {
    id: "attr_color",
    name: "Color",
    slug: "color",
    values: [{ value: "Red", count: 2 }, { value: "Blue", count: 1 }],
  },
  {
    id: "attr_size",
    name: "Size",
    slug: "size",
    values: [{ value: "M", count: 2 }, { value: "L", count: 1 }],
  },
];

describe("product list query canonicalization", () => {
  it("keeps unfiltered default category URLs on the parallel fast path", () => {
    const url = new URL("https://storefront.example.com/categories/shoes?page=1&sortBy=newest&utm_source=ad");
    const state = resolveProductListQueryState({ url });
    expect(state.options).toEqual({ page: 1, limit: 20, sort: "newest" });
    expect(state.currentFilters).toEqual({});
    expect(state.redirectPath).toBe(null);
  });

  it("drops unknown render-affecting params before they fragment HTML or L2 keys", () => {
    const url = new URL("https://storefront.example.com/search?q= fish  curry &foo=1&page=2");
    const state = resolveProductListQueryState({ url, facets });
    expect(state.options).toMatchObject({ page: 2, limit: 20, sort: "newest", search: "fish curry" });
    expect(state.options).not.toHaveProperty("foo");
    expect(state.redirectPath).toBe("/search?page=2&q=fish+curry");
  });

  it("keeps only available dynamic attribute values", () => {
    const url = new URL("https://storefront.example.com/categories/shoes?size=M&color=Green&hasDiscount=true");
    const state = resolveProductListQueryState({ url, facets });
    expect(state.options).toMatchObject({ page: 1, limit: 20, sort: "newest", size: ["M"], hasDiscount: true });
    expect(state.options).not.toHaveProperty("color");
    expect(state.currentFilters).toEqual({ hasDiscount: "true", size: ["M"] });
    expect(state.redirectPath).toBe("/categories/shoes?hasDiscount=true&size=M");
  });

  it("normalizes common filters without requiring attribute metadata", () => {
    const url = new URL("https://storefront.example.com/search?freeDelivery=true&hasDiscount=false&minPrice=1000&maxPrice=50000");
    const state = resolveProductListQueryState({ url });
    expect(state.options).toMatchObject({
      page: 1,
      limit: 20,
      sort: "newest",
      freeDelivery: true,
      minPrice: 1000,
      maxPrice: 50000,
    });
    expect(state.options).not.toHaveProperty("hasDiscount");
    expect(state.redirectPath).toBe("/search?freeDelivery=true&maxPrice=50000&minPrice=1000");
  });

  it("treats attribute-like and unknown render params as dynamic until metadata proves them", () => {
    const validAttributeUrl = new URL("https://storefront.example.com/search?color=Blue");
    const unknownParamUrl = new URL("https://storefront.example.com/search?campaign=summer");
    const attributeState = resolveProductListQueryState({ url: validAttributeUrl, facets });
    const unknownState = resolveProductListQueryState({ url: unknownParamUrl, facets });
    expect(attributeState.options).toMatchObject({ color: ["Blue"] });
    expect(attributeState.redirectPath).toBe(null);
    expect(unknownState.options).not.toHaveProperty("campaign");
    expect(unknownState.redirectPath).toBe("/search");
  });

  it("forwards repeated unknown facet values only during the first server pass", () => {
    const url = new URL(
      "https://storefront.example.com/search?color=Red&color=Blue&campaign=summer",
    );
    const firstPass = resolveProductListQueryState({
      url,
      allowUnknownAttributes: true,
    });
    expect(firstPass.options).toMatchObject({
      color: ["Red", "Blue"],
      campaign: ["summer"],
    });
    expect(firstPass.redirectPath).toBeNull();

    const authoritativePass = resolveProductListQueryState({ url, facets });
    expect(authoritativePass.options).toMatchObject({ color: ["Red", "Blue"] });
    expect(authoritativePass.options).not.toHaveProperty("campaign");
    expect(authoritativePass.redirectPath).toBe(
      "/search?color=Blue&color=Red",
    );
  });

  it("redirects invalid navigation values to a canonical product-list URL", () => {
    const url = new URL("https://storefront.example.com/search?page=0&sortBy=popular&q=  ");
    const state = resolveProductListQueryState({ url });
    expect(state.options).toEqual({ page: 1, limit: 20, sort: "newest" });
    expect(state.currentFilters).toEqual({});
    expect(state.redirectPath).toBe("/search");
  });

  it("uses the last repeated render param and redirects to a single-value URL", () => {
    const url = new URL(
      "https://storefront.example.com/search?q=apple&q=banana&page=2&page=1&sortBy=price-desc&sortBy=name-asc&freeDelivery=false&freeDelivery=true",
    );
    const state = resolveProductListQueryState({ url });
    expect(state.options).toMatchObject({ page: 1, limit: 20, sort: "name-asc", search: "banana", freeDelivery: true });
    expect(state.redirectPath).toBe("/search?freeDelivery=true&q=banana&sortBy=name-asc");
  });

  it("preserves repeated valid attribute values as a multi-select", () => {
    const url = new URL("https://storefront.example.com/categories/shoes?size=M&size=L&color=Blue&color=Green");
    const state = resolveProductListQueryState({ url, facets });
    expect(state.options).toMatchObject({
      page: 1,
      limit: 20,
      sort: "newest",
      size: ["M", "L"],
      color: ["Blue"],
    });
    expect(state.redirectPath).toBe("/categories/shoes?color=Blue&size=L&size=M");
  });

  it("builds pagination links from canonical filters instead of raw URL noise", () => {
    const url = new URL(
      "https://storefront.example.com/search?q= fish  curry &page=1&sortBy=newest&utm_source=ad&fbclid=x&brand=Apple",
    );
    const state = resolveProductListQueryState({
      url,
      facets: [{
        id: "attr_brand",
        name: "Brand",
        slug: "brand",
        values: [{ value: "Apple", count: 4 }],
      }],
    });
    expect(state.currentFilters).toEqual({ brand: ["Apple"], q: "fish curry" });
    expect(buildProductListHref({ pathname: "/search", currentFilters: state.currentFilters, overrides: { page: 2 } }))
      .toBe("/search?brand=Apple&page=2&q=fish+curry");
  });

  it("preserves validated listing filters while changing page or sort", () => {
    const currentFilters = {
      color: "Red",
      freeDelivery: "true",
      hasDiscount: "true",
      maxPrice: "5000",
      minPrice: "1000",
      page: "3",
      q: "cotton panjabi",
      size: "M",
      sortBy: "price-asc",
    };
    expect(buildProductListHref({ pathname: "/categories/shoes", currentFilters, overrides: { page: 4 } })).toBe(
      "/categories/shoes?color=Red&freeDelivery=true&hasDiscount=true&maxPrice=5000&minPrice=1000&page=4&q=cotton+panjabi&size=M&sortBy=price-asc",
    );
    expect(buildProductListHref({
      pathname: "/categories/shoes",
      currentFilters,
      overrides: { page: 1, sortBy: "newest" },
    })).toBe(
      "/categories/shoes?color=Red&freeDelivery=true&hasDiscount=true&maxPrice=5000&minPrice=1000&q=cotton+panjabi&size=M",
    );
  });

  it("treats 50,000 as a real maximum instead of a magic default", () => {
    const state = resolveProductListQueryState({
      url: new URL("https://store.test/search?maxPrice=50000"),
    });
    expect(state.redirectPath).toBeNull();
    expect(state.options.maxPrice).toBe(50000);
    expect(state.currentFilters.maxPrice).toBe("50000");
  });

  it("canonicalizes reversed ranges without dropping buyer intent", () => {
    const state = resolveProductListQueryState({
      url: new URL("https://store.test/search?minPrice=900&maxPrice=100"),
    });
    expect(state.options.minPrice).toBe(100);
    expect(state.options.maxPrice).toBe(900);
    expect(state.redirectPath).toBe("/search?maxPrice=900&minPrice=100");
  });

  it("removes invalid maximum values rather than inventing a fallback cap", () => {
    const state = resolveProductListQueryState({
      url: new URL("https://store.test/search?maxPrice=not-a-number"),
    });
    expect(state.options.maxPrice).toBeUndefined();
    expect(state.redirectPath).toBe("/search");
  });

  it("ranks search results by relevance by default and keeps an explicit sort in the URL", () => {
    const searched = resolveProductListQueryState({
      url: new URL("https://store.test/search?q=bag"),
      rankByRelevance: true,
    });
    expect(searched).toMatchObject({ sortBy: "relevance", defaultSort: "relevance", redirectPath: null });
    expect(searched.options.sort).toBe("relevance");
    expect(searched.currentFilters).toEqual({ q: "bag" });

    const newest = resolveProductListQueryState({
      url: new URL("https://store.test/search?q=bag&sortBy=newest"),
      rankByRelevance: true,
    });
    expect(newest.currentFilters).toEqual({ q: "bag", sortBy: "newest" });
    expect(buildProductListHref({
      pathname: "/search",
      currentFilters: newest.currentFilters,
      overrides: { sortBy: "relevance" },
      defaultSort: newest.defaultSort,
    })).toBe("/search?q=bag");

    // Without a query (or outside /search) there is nothing to rank.
    const browsing = resolveProductListQueryState({
      url: new URL("https://store.test/search?sortBy=relevance"),
      rankByRelevance: true,
    });
    expect(browsing).toMatchObject({ sortBy: "newest", redirectPath: "/search" });
    const category = resolveProductListQueryState({
      url: new URL("https://store.test/categories/shoes?q=bag"),
    });
    expect(category.sortBy).toBe("newest");
  });

  it("accepts merchant option facets such as option.size", () => {
    const url = new URL("https://store.test/categories/shoes?option.size=42&option.size=41");
    const firstPass = resolveProductListQueryState({ url, allowUnknownAttributes: true });
    expect(firstPass.options["option.size"]).toEqual(["42", "41"]);
    const authoritative = resolveProductListQueryState({
      url,
      facets: [{ id: "option.size", name: "Size", slug: "option.size", values: [
        { value: "41", count: 2 },
        { value: "42", count: 1 },
      ] }],
    });
    expect(authoritative.currentFilters).toEqual({ "option.size": ["42", "41"] });
    expect(authoritative.redirectPath).toBeNull();
  });

  it("reads Bangla digits in price filters and redirects to Latin digits", () => {
    const state = resolveProductListQueryState({
      url: new URL("https://store.test/search?minPrice=%E0%A7%A7%E0%A7%A6%E0%A7%A6"),
    });
    expect(state.options.minPrice).toBe(100);
    expect(state.redirectPath).toBe("/search?minPrice=100");
  });

  it("indexes only plain listing pages, each self-canonical", () => {
    expect(isIndexableProductListView({})).toBe(true);
    expect(isIndexableProductListView({ page: "2" })).toBe(true);
    expect(isIndexableProductListView({ page: "2", sortBy: "price-asc" })).toBe(false);
    expect(isIndexableProductListView({ hasDiscount: "true" })).toBe(false);
    expect(productListCanonicalUrl("https://store.test/categories/shoes", 1))
      .toBe("https://store.test/categories/shoes");
    expect(productListCanonicalUrl("https://store.test/categories/shoes", 3))
      .toBe("https://store.test/categories/shoes?page=3");
    expect(productListCanonicalUrl(null, 3)).toBeNull();
    expect(countActiveProductListFilters({ page: "2", sortBy: "discount", q: "bag", color: ["Red", "Blue"] })).toBe(3);
  });

  it("describes an undescribed listing by its own products within 155 characters", () => {
    const names = ["Press Glass Storage Set", "Loop Silicone Utensil Set", "Echo Mini Bluetooth Speaker", "Linen Throw"];

    expect(productListMetaDescription("Home Refresh", names)).toBe(
      "Shop Home Refresh: Press Glass Storage Set, Loop Silicone Utensil Set, Echo Mini Bluetooth Speaker and more.",
    );
    expect(productListMetaDescription("Home Refresh", names.slice(0, 2)))
      .toBe("Shop Home Refresh: Press Glass Storage Set and Loop Silicone Utensil Set.");
    expect(productListMetaDescription("Home Refresh", ["Linen Throw"])).toBe("Shop Home Refresh: Linen Throw.");
    expect(productListMetaDescription("Home Refresh", [])).toBe("Shop Home Refresh.");
    expect(productListMetaDescription("Home Refresh", ["A".repeat(150), "Linen Throw"])).toBe("Shop Home Refresh.");
    expect(productListMetaDescription("Footwear", names, 60)).toBe("Shop Footwear: Press Glass Storage Set and more.");
  });

  it("treats pages past the last one as missing, but never page 1 of an empty listing", () => {
    // Footwear: 10 products on one page.
    expect(isMissingProductListPage({ page: 1, totalPages: 1 })).toBe(false);
    expect(isMissingProductListPage({ page: 2, totalPages: 1 })).toBe(true);
    expect(isMissingProductListPage({ page: 999, totalPages: 1 })).toBe(true);
    expect(isMissingProductListPage({ page: 3, totalPages: 3 })).toBe(false);
    // No products (or none matching the filters) yet: page 1 shows the empty state.
    expect(isMissingProductListPage({ page: 1, totalPages: 0 })).toBe(false);
    expect(isMissingProductListPage({ page: 2, totalPages: 0 })).toBe(true);
  });
});
