import { describe, expect, it } from "vitest";
import { appendPriceFilterParams, parsePriceFilterValue } from "./price-url";

describe("price filter URL serialization", () => {
  it("keeps a real 50,000 maximum when the catalog range is higher", () => {
    const params = new URLSearchParams();
    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "0",
      maxPriceInput: "50000",
      defaultMaxPrice: 250000,
    });
    expect(params.toString()).toBe("maxPrice=50000");
  });

  it("omits unchanged dynamic boundaries while preserving a minimum-only filter", () => {
    const params = new URLSearchParams();
    appendPriceFilterParams(params, {
      includePriceFilter: true,
      priceChanged: true,
      minPriceInput: "1250.5",
      maxPriceInput: "250000",
      defaultMaxPrice: 250000,
    });
    expect(params.toString()).toBe("minPrice=1250.5");
  });

  it("preserves valid fractional prices", () => {
    expect(parsePriceFilterValue("19.95", 0)).toBe(19.95);
  });

  it("uses the API price boundary when a URL filter is absent or blank", () => {
    expect(parsePriceFilterValue(undefined, 7_055)).toBe(7_055);
    expect(parsePriceFilterValue("", 7_055)).toBe(7_055);
    expect(parsePriceFilterValue("   ", 50)).toBe(50);
  });

  it("keeps an explicit zero instead of treating it as absent", () => {
    expect(parsePriceFilterValue("0", 7_055)).toBe(0);
  });
});
