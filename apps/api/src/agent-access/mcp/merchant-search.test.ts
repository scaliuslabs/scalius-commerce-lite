import { describe, expect, it } from "vitest";
import { matchesMerchantOperationQuery, merchantOperationQueryScore } from "./merchant-search";

describe("merchant operation search", () => {
  it.each([
    ["daily activity revenue and orders", "what are today's sales?"],
    ["daily activity revenue and orders", "how much did we sell today?"],
    ["daily activity revenue and orders", "total sales last week"],
    ["current month sales and revenue summary", "sales this month"],
    ["checkout readiness and blocking configuration issues", "is my store healthy?"],
    ["checkout readiness and blocking configuration issues", "is my store ready?"],
    ["payment recovery attempts needing attention", "show payment issues"],
    ["inventory alerts for low and out of stock", "stock problems"],
    ["dashboard.inventory_alerts.list inventory alerts", "low stock products"],
    ["recent customers and buyer summaries", "new shoppers"],
    ["orders filtered by fulfillment status", "orders needing delivery"],
    ["orders filtered by fulfillment status", "orders waiting to ship"],
    ["storefront.context.create create context", "start a cart and checkout with delivery"],
    ["storefront.products.list list products", "buy a product"],
    ["storefront.checkout.submit submit checkout", "place an order"],
    ["storefront.cart.add add cart item", "add a product to my cart"],
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

  it("ranks a multi-step storefront workflow in execution order", () => {
    const query = "start a cart and checkout with delivery";
    const ids = [
      "storefront.context.create",
      "storefront.cart.add",
      "storefront.delivery.set",
      "storefront.checkout.quote",
      "storefront.checkout.submit",
    ];
    const scores = ids.map((id) => merchantOperationQueryScore(id, query)!);
    expect(scores).toEqual([...scores].sort((left, right) => right - left));
  });
});
