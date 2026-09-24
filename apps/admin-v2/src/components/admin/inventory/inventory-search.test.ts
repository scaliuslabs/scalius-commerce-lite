import { describe, expect, it } from "vitest";
import { INVENTORY_SEARCH_DEFAULTS, validateInventorySearch, variantsQuery } from "./inventory-search";

describe("inventory URL state", () => {
  it("falls back to the defaults the URL strips", () => {
    expect(validateInventorySearch({})).toEqual(INVENTORY_SEARCH_DEFAULTS);
  });

  it("keeps only known filter values and calendar dates, never a search term", () => {
    expect(validateInventorySearch({
      section: "movements",
      q: "01712345678",
      stock: "low",
      alert: "everything",
      type: "deducted",
      from: "2026-09-01",
      to: "tomorrow",
    })).toEqual({ section: "movements", stock: "low", alert: "active", type: "deducted", from: "2026-09-01", to: "" });
  });

  it("builds the same variants query for the route prefetch and the tab", () => {
    expect(variantsQuery({ ...INVENTORY_SEARCH_DEFAULTS, q: "" })).toEqual({
      section: "variants", search: undefined, status: undefined, page: 1, limit: 50, sort: "available", order: "asc",
    });
  });
});
