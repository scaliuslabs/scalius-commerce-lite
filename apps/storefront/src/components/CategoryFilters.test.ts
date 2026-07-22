import { describe, expect, it } from "vitest";
import {
  formatCatalogPriceDisplay,
  getInitialCategoryFilterState,
} from "./CategoryFilters";

describe("formatCatalogPriceDisplay", () => {
  it("uses deterministic server/client formatting for hydration", () => {
    expect(formatCatalogPriceDisplay(9_999_999, "৳")).toBe("৳10M");
    expect(formatCatalogPriceDisplay(1_250, "৳")).toBe("৳1,250");
    expect(formatCatalogPriceDisplay(50.25, "৳")).toBe("৳50.25");
  });
});

describe("getInitialCategoryFilterState", () => {
  it("keeps a minimum above the catalog range representable", () => {
    const state = getInitialCategoryFilterState(
      { minPrice: "9999999" },
      { min: 891, max: 10990 },
    );

    expect(state.minPrice).toBe(9_999_999);
    expect(state.maxPrice).toBe(9_999_999);
    expect(state.maxRange).toBe(9_999_999);
  });

  it("preserves an explicit canonical maximum", () => {
    const state = getInitialCategoryFilterState(
      { minPrice: "100", maxPrice: "500" },
      { min: 0, max: 1000 },
    );

    expect(state.minPrice).toBe(100);
    expect(state.maxPrice).toBe(500);
  });
});
