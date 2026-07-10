import { describe, expect, it } from "vitest";

import {
  getAuthorizedAdminNavigationRoutes,
  isDirectAdminNavigationAuthorized,
} from "./navigation-authorization";

describe("Admin direct navigation authorization", () => {
  it.each([
    ["Take me to products page", "goto /admin/products"],
    ["Take me to the tax page", "goto /admin/settings/taxes"],
    ["Can you open the taxes page?", "goto /admin/settings/taxes"],
    ["Please navigate me to abandoned checkouts", "goto /admin/abandoned-checkouts"],
  ])("accepts one exact explicit catalog destination", (message, program) => {
    expect(isDirectAdminNavigationAuthorized(message, program)).toBe(true);
  });

  it.each([
    ["Create a test product with real images", "goto /admin/products/new"],
    ["Can you please add a category?", "goto /admin/categories/new"],
    ["I want you to create a promotion", "goto /admin/discounts/new"],
    ["Please create an order and a customer", "goto /admin/orders/new"],
    ["Please create an order and a customer", "goto /admin/customers/new"],
  ])("authorizes fixed routes implied by explicit create tasks", (message, program) => {
    expect(isDirectAdminNavigationAuthorized(message, program)).toBe(true);
  });

  it.each([
    [undefined, "goto /admin/products"],
    ["How many products do we have?", "goto /admin/products"],
    ["Take me to orders", "goto /admin/products"],
    ["Take me to products or orders", "goto /admin/products"],
    ["Maybe open products", "goto /admin/products"],
    ["Take me to orders", "goto /admin/orders?status=pending"],
    ["Take me to products", "goto /admin/products#top"],
    ["Take me to a product", "goto /admin/products/prod_private"],
    ["How do I create a product?", "goto /admin/products/new"],
    ["Could a product be created automatically?", "goto /admin/products/new"],
    ["Create a product", "goto /admin/orders/new"],
  ])("rejects absent, ambiguous, unrelated, or non-catalog navigation", (message, program) => {
    expect(isDirectAdminNavigationAuthorized(message, program)).toBe(false);
  });

  it("does not impose navigation intent on non-goto computer work", () => {
    expect(isDirectAdminNavigationAuthorized(undefined, "observe")).toBe(true);
    expect(isDirectAdminNavigationAuthorized("Explain this page", "refresh")).toBe(
      true,
    );
  });

  it("resolves one shared route scope for direct goto and visible-link clicks", () => {
    expect(getAuthorizedAdminNavigationRoutes("Take me to products page")).toEqual([
      "/admin/products",
    ]);
    expect(getAuthorizedAdminNavigationRoutes("How many products do we have?")).toEqual(
      [],
    );
    expect(getAuthorizedAdminNavigationRoutes("Take me to products or orders")).toEqual(
      [],
    );
    expect(getAuthorizedAdminNavigationRoutes("Take me to a product")).toEqual([]);
    expect(getAuthorizedAdminNavigationRoutes("Create a product with real images")).toEqual([
      "/admin/products/new",
    ]);
    expect(getAuthorizedAdminNavigationRoutes("Please create an order and a customer"))
      .toEqual(["/admin/orders/new", "/admin/customers/new"]);
  });
});
