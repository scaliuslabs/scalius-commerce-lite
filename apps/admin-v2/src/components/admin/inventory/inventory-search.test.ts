import { describe, expect, it } from "vitest";
import { INVENTORY_SEARCH_DEFAULTS, movementsQuery, validateInventorySearch, variantsQuery } from "./inventory-search";

describe("inventory URL state", () => {
  it("falls back to the defaults the URL strips", () => {
    expect(validateInventorySearch({})).toEqual(INVENTORY_SEARCH_DEFAULTS);
  });

  it("keeps only known filter values, calendar dates and a one-time search link", () => {
    expect(validateInventorySearch({
      section: "movements",
      q: "01712345678",
      stock: "low",
      alert: "everything",
      type: "deducted",
      from: "2026-09-01",
      to: "tomorrow",
    })).toEqual({ section: "movements", q: "01712345678", stock: "low", alert: "active", type: "deducted", from: "2026-09-01", to: "", location: "" });
  });

  it("keeps a location filter id and asks the list for that location's on-hand", () => {
    expect(validateInventorySearch({ location: "loc_branch" }).location).toBe("loc_branch");
    expect(validateInventorySearch({ location: "../x" }).location).toBe("");
    expect(variantsQuery({ ...INVENTORY_SEARCH_DEFAULTS, q: "", location: "loc_branch" })).toMatchObject({ locationId: "loc_branch" });
    // History filters to movements at that location.
    expect(movementsQuery({ ...INVENTORY_SEARCH_DEFAULTS, q: "", location: "loc_branch" })).toMatchObject({ movementLocationId: "loc_branch" });
    expect(movementsQuery({ ...INVENTORY_SEARCH_DEFAULTS, q: "" })).not.toHaveProperty("movementLocationId");
  });

  it("builds the same variants query for the route prefetch and the tab", () => {
    expect(variantsQuery({ ...INVENTORY_SEARCH_DEFAULTS, q: "" })).toEqual({
      section: "variants", search: undefined, status: undefined, page: 1, limit: 50, sort: "available", order: "asc",
    });
  });
});
