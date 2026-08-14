import { describe, expect, it } from "vitest";
import { matchesMerchantOperationQuery, merchantOperationQueryScore } from "./merchant-search";

describe("merchant operation search", () => {
  it.each([
    ["daily activity revenue and orders", "what are today's sales?"],
    ["daily activity revenue and orders", "total sales last week"],
    ["current month sales and revenue summary", "sales this month"],
    ["checkout readiness and blocking configuration issues", "is my store healthy?"],
    ["payment recovery attempts needing attention", "show payment issues"],
    ["inventory alerts for low and out of stock", "stock problems"],
    ["recent customers and buyer summaries", "new shoppers"],
    ["orders filtered by fulfillment status", "orders needing delivery"],
  ])("matches %s from natural request %s", (text, query) => {
    expect(matchesMerchantOperationQuery(text, query)).toBe(true);
  });

  it("still requires every meaningful merchant concept", () => {
    expect(matchesMerchantOperationQuery("inventory alerts", "payment issues")).toBe(false);
  });

  it("scores exact merchant words above synonym-only matches", () => {
    expect(merchantOperationQueryScore("orders needing fulfillment", "orders needing fulfillment")!)
      .toBeGreaterThan(merchantOperationQueryScore("orders shipping filter", "orders needing fulfillment")!);
  });
});
