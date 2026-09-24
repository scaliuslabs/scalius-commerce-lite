import { describe, expect, it } from "vitest";
import {
  isProductRecommendations,
  recommendationQuery,
  recommendationSourceIds,
  recommendationTitle,
} from "./recommendations";

describe("recommendation helpers", () => {
  it("titles each list for the data it really is", () => {
    expect(recommendationTitle("also_bought")).toBe("Customers also bought");
    expect(recommendationTitle("similar")).toBe("You might also like");
    expect(recommendationTitle("popular")).toBe("Popular right now");
    expect(recommendationTitle("new_arrivals")).toBe("New arrivals");
  });

  it("sends one stable, bounded id list so identical carts share a cache entry", () => {
    const ids = Array.from({ length: 14 }, (_, index) => `p${String(14 - index).padStart(2, "0")}`);
    expect(recommendationSourceIds([" b ", "a", "b", ""])).toEqual(["a", "b"]);
    expect(recommendationSourceIds(ids)).toHaveLength(10);
    expect(recommendationQuery(["b", "a"], 4)).toBe("productIds=a%2Cb&limit=4");
    expect(recommendationQuery([], 8)).toBe("limit=8");
  });

  it("rejects payloads without a known reason", () => {
    expect(isProductRecommendations({ reason: "similar", products: [] })).toBe(true);
    expect(isProductRecommendations({ reason: "trending", products: [] })).toBe(false);
    expect(isProductRecommendations({ products: [] })).toBe(false);
    expect(isProductRecommendations(null)).toBe(false);
  });
});
