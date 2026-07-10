import { describe, expect, it } from "vitest";

import { isDirectAdminNavigationAuthorized } from "./navigation-authorization";

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
    [undefined, "goto /admin/products"],
    ["How many products do we have?", "goto /admin/products"],
    ["Take me to orders", "goto /admin/products"],
    ["Take me to products or orders", "goto /admin/products"],
    ["Maybe open products", "goto /admin/products"],
    ["Take me to orders", "goto /admin/orders?status=pending"],
    ["Take me to products", "goto /admin/products#top"],
    ["Take me to a product", "goto /admin/products/prod_private"],
  ])("rejects absent, ambiguous, unrelated, or non-catalog navigation", (message, program) => {
    expect(isDirectAdminNavigationAuthorized(message, program)).toBe(false);
  });

  it("does not impose navigation intent on non-goto computer work", () => {
    expect(isDirectAdminNavigationAuthorized(undefined, "observe")).toBe(true);
    expect(isDirectAdminNavigationAuthorized("Explain this page", "refresh")).toBe(
      true,
    );
  });
});
