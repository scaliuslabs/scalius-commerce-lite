import { describe, expect, it } from "vitest";
import { resolveProductListQueryState, buildProductListHref } from "../../../apps/storefront/src/lib/product-list-query";

function priceState(search: string) {
  return resolveProductListQueryState({ url: new URL(`https://store.test/search${search}`) });
}

describe("storefront price filter URL params", () => {
  it.each([200000, 25000, 50000])("keeps an explicit maximum of %s without a default ceiling", (maxPrice) => {
    const state = priceState(`?maxPrice=${maxPrice}`);
    expect(state.options.maxPrice).toBe(maxPrice);
    expect(state.options.minPrice).toBeUndefined();
    expect(buildProductListHref({ pathname: "/search", currentFilters: state.currentFilters }))
      .toBe(`/search?maxPrice=${maxPrice}`);
  });

  it("omits the untouched maximum when only minimum price is active", () => {
    const state = priceState("?minPrice=10000&maxPrice=");
    expect(state.options.minPrice).toBe(10000);
    expect(state.options.maxPrice).toBeUndefined();
    expect(state.redirectPath).toBe("/search?minPrice=10000");
  });

  it("omits untouched empty price inputs from the native filter form", () => {
    const state = priceState("?minPrice=&maxPrice=");
    expect(state.options.minPrice).toBeUndefined();
    expect(state.options.maxPrice).toBeUndefined();
    expect(state.redirectPath).toBe("/search");
  });

  it.each(["nope", "-100"])("drops invalid price %s instead of applying a default ceiling", (value) => {
    const state = priceState(`?minPrice=${value}&maxPrice=${value}`);
    expect(state.options.minPrice).toBeUndefined();
    expect(state.options.maxPrice).toBeUndefined();
    expect(state.redirectPath).toBe("/search");
  });
});
