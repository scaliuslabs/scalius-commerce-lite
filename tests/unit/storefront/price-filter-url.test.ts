import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_PRICE,
  appendPriceFilterParams,
  parsePriceFilterValue,
} from "../../../apps/storefront/src/lib/filters/price-url";

describe("storefront price filter URL params", () => {
  it("keeps max prices above the default ceiling", () => {
    const params = new URLSearchParams();

    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "0",
      maxPriceInput: "200000",
    });

    expect(params.get("minPrice")).toBeNull();
    expect(params.get("maxPrice")).toBe("200000");
  });

  it("keeps max prices below the default ceiling", () => {
    const params = new URLSearchParams();

    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "0",
      maxPriceInput: "25000",
    });

    expect(params.get("maxPrice")).toBe("25000");
  });

  it("keeps default max when min price is active", () => {
    const params = new URLSearchParams();

    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "10000",
      maxPriceInput: DEFAULT_MAX_PRICE.toString(),
    });

    expect(params.get("minPrice")).toBe("10000");
    expect(params.get("maxPrice")).toBe(DEFAULT_MAX_PRICE.toString());
  });

  it("omits untouched default price filters", () => {
    const params = new URLSearchParams();

    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "0",
      maxPriceInput: DEFAULT_MAX_PRICE.toString(),
    });

    expect(params.toString()).toBe("");
  });

  it("parses invalid price values back to the fallback", () => {
    expect(parsePriceFilterValue("nope", DEFAULT_MAX_PRICE)).toBe(
      DEFAULT_MAX_PRICE,
    );
    expect(parsePriceFilterValue("-100", DEFAULT_MAX_PRICE)).toBe(
      DEFAULT_MAX_PRICE,
    );
  });
});
