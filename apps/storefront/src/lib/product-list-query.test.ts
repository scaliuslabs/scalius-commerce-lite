import { describe, expect, it } from "vitest";
import type { FilterableAttribute } from "@/lib/api";
import {
  hasDynamicProductListFilterParams,
  resolveProductListQueryState,
} from "./product-list-query";

const attributes: FilterableAttribute[] = [
  {
    id: "attr_color",
    name: "Color",
    slug: "color",
    values: ["Red", "Blue"],
  },
  {
    id: "attr_size",
    name: "Size",
    slug: "size",
    values: ["M", "L"],
  },
];

describe("product list query canonicalization", () => {
  it("keeps unfiltered default category URLs on the parallel fast path", () => {
    const url = new URL("https://storefront.example.com/categories/shoes?page=1&sortBy=newest&utm_source=ad");

    expect(hasDynamicProductListFilterParams(url.searchParams)).toBe(false);

    const state = resolveProductListQueryState({ url });

    expect(state.options).toEqual({
      page: 1,
      limit: 20,
      sort: "newest",
    });
    expect(state.currentFilters).toEqual({});
    expect(state.redirectPath).toBe(null);
  });

  it("drops unknown render-affecting params before they fragment HTML or L2 keys", () => {
    const url = new URL("https://storefront.example.com/search?q= fish  curry &foo=1&page=2");

    expect(hasDynamicProductListFilterParams(url.searchParams)).toBe(true);

    const state = resolveProductListQueryState({ url, attributes });

    expect(state.options).toMatchObject({
      page: 2,
      limit: 20,
      sort: "newest",
      search: "fish curry",
    });
    expect(state.options).not.toHaveProperty("foo");
    expect(state.redirectPath).toBe("/search?page=2&q=fish+curry");
  });

  it("keeps only available dynamic attribute values", () => {
    const url = new URL("https://storefront.example.com/categories/shoes?size=M&color=Green&hasDiscount=true");

    const state = resolveProductListQueryState({ url, attributes });

    expect(state.options).toMatchObject({
      page: 1,
      limit: 20,
      sort: "newest",
      size: "M",
      hasDiscount: true,
    });
    expect(state.options).not.toHaveProperty("color");
    expect(state.currentFilters).toEqual({
      hasDiscount: "true",
      size: "M",
    });
    expect(state.redirectPath).toBe("/categories/shoes?hasDiscount=true&size=M");
  });

  it("normalizes common filters without requiring attribute metadata", () => {
    const url = new URL("https://storefront.example.com/search?freeDelivery=true&hasDiscount=false&minPrice=1000&maxPrice=50000");

    expect(hasDynamicProductListFilterParams(url.searchParams)).toBe(false);

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
    expect(state.redirectPath).toBe(
      "/search?freeDelivery=true&maxPrice=50000&minPrice=1000",
    );
  });

  it("redirects invalid navigation values to a canonical product-list URL", () => {
    const url = new URL("https://storefront.example.com/search?page=0&sortBy=popular&q=  ");

    const state = resolveProductListQueryState({ url });

    expect(state.options).toEqual({
      page: 1,
      limit: 20,
      sort: "newest",
    });
    expect(state.currentFilters).toEqual({});
    expect(state.redirectPath).toBe("/search");
  });

  it("uses the last repeated render param and redirects to a single-value URL", () => {
    const url = new URL(
      "https://storefront.example.com/search?q=apple&q=banana&page=2&page=1&sortBy=price-desc&sortBy=name-asc&freeDelivery=false&freeDelivery=true",
    );

    const state = resolveProductListQueryState({ url });

    expect(state.options).toMatchObject({
      page: 1,
      limit: 20,
      sort: "name-asc",
      search: "banana",
      freeDelivery: true,
    });
    expect(state.redirectPath).toBe(
      "/search?freeDelivery=true&q=banana&sortBy=name-asc",
    );
  });

  it("uses the last repeated attribute value before canonicalizing filters", () => {
    const url = new URL(
      "https://storefront.example.com/categories/shoes?size=M&size=L&color=Blue&color=Green",
    );

    const state = resolveProductListQueryState({ url, attributes });

    expect(state.options).toMatchObject({
      page: 1,
      limit: 20,
      sort: "newest",
      size: "L",
    });
    expect(state.options).not.toHaveProperty("color");
    expect(state.redirectPath).toBe("/categories/shoes?size=L");
  });
});
