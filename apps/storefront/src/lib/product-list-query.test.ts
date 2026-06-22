import { describe, expect, it } from "vitest";
import type { FilterableAttribute } from "@/lib/api";
import {
  buildProductListHref,
  buildProductListPaginationHref,
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

  it("does not treat built-in navigation, price, boolean, or tracking params as dynamic attributes", () => {
    const url = new URL(
      "https://storefront.example.com/search?q=fish&page=2&sortBy=price-asc&minPrice=1000&maxPrice=50000&freeDelivery=true&hasDiscount=true&utm_source=ad&fbclid=abc",
    );

    expect(hasDynamicProductListFilterParams(url.searchParams)).toBe(false);
  });

  it("treats attribute-like and unknown render params as dynamic until metadata proves them", () => {
    const validAttributeUrl = new URL("https://storefront.example.com/search?color=Blue");
    const unknownParamUrl = new URL("https://storefront.example.com/search?campaign=summer");

    expect(hasDynamicProductListFilterParams(validAttributeUrl.searchParams)).toBe(true);
    expect(hasDynamicProductListFilterParams(unknownParamUrl.searchParams)).toBe(true);

    const attributeState = resolveProductListQueryState({
      url: validAttributeUrl,
      attributes,
    });
    const unknownState = resolveProductListQueryState({
      url: unknownParamUrl,
      attributes,
    });

    expect(attributeState.options).toMatchObject({ color: "Blue" });
    expect(attributeState.redirectPath).toBe(null);
    expect(unknownState.options).not.toHaveProperty("campaign");
    expect(unknownState.redirectPath).toBe("/search");
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

  it("builds pagination links from canonical filters instead of raw URL noise", () => {
    const url = new URL(
      "https://storefront.example.com/search?q= fish  curry &page=1&sortBy=newest&utm_source=ad&fbclid=x&brand=Apple",
    );
    const state = resolveProductListQueryState({
      url,
      attributes: [
        {
          id: "attr_brand",
          name: "Brand",
          slug: "brand",
          values: ["Apple"],
        },
      ],
    });

    expect(state.currentFilters).toEqual({
      brand: "Apple",
      q: "fish curry",
    });
    expect(
      buildProductListPaginationHref({
        pathname: "/search",
        currentFilters: state.currentFilters,
        page: 2,
      }),
    ).toBe("/search?brand=Apple&page=2&q=fish+curry");
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

    expect(
      buildProductListPaginationHref({
        pathname: "/categories/shoes",
        currentFilters,
        page: 4,
      }),
    ).toBe(
      "/categories/shoes?color=Red&freeDelivery=true&hasDiscount=true&maxPrice=5000&minPrice=1000&page=4&q=cotton+panjabi&size=M&sortBy=price-asc",
    );

    expect(
      buildProductListHref({
        pathname: "/categories/shoes",
        currentFilters,
        overrides: {
          page: 1,
          sortBy: "newest",
        },
      }),
    ).toBe(
      "/categories/shoes?color=Red&freeDelivery=true&hasDiscount=true&maxPrice=5000&minPrice=1000&q=cotton+panjabi&size=M",
    );
  });
});
