import { describe, expect, it } from "vitest";

import {
  abandonedCheckoutRouteStateToQuery,
  validateAbandonedCheckoutSearch,
} from "./abandoned-checkout-route-state";

describe("abandoned checkout route state", () => {
  it("normalizes malformed and unbounded URL values", () => {
    expect(validateAbandonedCheckoutSearch({
      page: "-4",
      limit: "999",
      search: 42,
      sort: "checkoutData",
      order: "sideways",
    })).toEqual({
      page: 1,
      limit: 100,
      search: "",
      sort: "updatedAt",
      order: "desc",
    });
  });

  it("keeps a copied merchant workspace and omits a blank API search", () => {
    const state = validateAbandonedCheckoutSearch({
      page: "2",
      limit: "50",
      search: "+88017",
      sort: "customerPhone",
      order: "asc",
    });

    expect(abandonedCheckoutRouteStateToQuery(state)).toEqual({
      page: 2,
      limit: 50,
      search: "+88017",
      sort: "customerPhone",
      order: "asc",
    });
    expect(abandonedCheckoutRouteStateToQuery({ ...state, search: "" }).search)
      .toBeUndefined();
  });
});
