import { describe, expect, it } from "vitest";

import {
  getDirectlyConfirmedAdminNavigationAction,
  safeAdminAssistantNavigationPath,
} from "./assistant-navigation";

describe("admin assistant navigation confirmation", () => {
  const productsAction = {
    type: "navigate" as const,
    path: "/admin/products",
    label: "Open Products",
  };

  it.each([
    "Open products",
    "Please open the products page",
    "Can you take me to products page?",
    "Navigate to products",
    "Show me the products page",
  ])("treats a direct single-destination command as confirmation: %s", (message) => {
    expect(
      getDirectlyConfirmedAdminNavigationAction(message, [productsAction]),
    ).toEqual(productsAction);
  });

  it.each([
    "Where do I manage products?",
    "Give me a link to products",
    "How do I edit products?",
    "Should I open products?",
    "Open products or orders",
    "Open products and orders",
    "Open products, then orders",
    "Show me low-stock products",
  ])("keeps suggestions and ambiguous requests click-confirmed: %s", (message) => {
    expect(
      getDirectlyConfirmedAdminNavigationAction(message, [productsAction]),
    ).toBeNull();
  });

  it("requires exactly one safe catalog-derived navigation action", () => {
    expect(
      getDirectlyConfirmedAdminNavigationAction("Open products", [
        productsAction,
        { type: "navigate", path: "/admin/orders", label: "Open Orders" },
      ]),
    ).toBeNull();
    expect(
      getDirectlyConfirmedAdminNavigationAction("Open products", [
        {
          type: "navigate",
          path: "https://evil.test/admin/products",
          label: "Open Products",
        },
      ]),
    ).toBeNull();
  });

  it("does not let a wrong known-route action override the requested target", () => {
    expect(
      getDirectlyConfirmedAdminNavigationAction("Open products", [
        { type: "navigate", path: "/admin/orders", label: "Open Orders" },
      ]),
    ).toBeNull();
  });

  it("continues to reject dynamic resource and off-origin destinations", () => {
    expect(safeAdminAssistantNavigationPath("/admin/products/prod_1")).toBeNull();
    expect(safeAdminAssistantNavigationPath("https://evil.test/admin")).toBeNull();
    expect(safeAdminAssistantNavigationPath("/admin/products")).toBe(
      "/admin/products",
    );
  });
});
