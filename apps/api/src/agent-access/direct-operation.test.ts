import { describe, expect, it } from "vitest";
import { resolveDirectAgentOperation } from "./direct-operation";

describe("direct agent operation manifest matching", () => {
  it("matches an exact executable method and path", () => {
    expect(resolveDirectAgentOperation("GET", "/api/v1/admin/products")).toMatchObject({
      operationId: "dashboard.products.list",
      exposure: "execute",
      risk: "read",
    });
  });

  it("does not treat a method mismatch as the same operation", () => {
    expect(resolveDirectAgentOperation("PATCH", "/api/v1/admin/products")).toBeNull();
  });

  it("returns excluded manifest entries so the authority layer can deny them", () => {
    expect(resolveDirectAgentOperation(
      "GET",
      "/api/v1/admin/products/prod_12345678901234567890",
    )).toMatchObject({
      operationId: "dashboard.products.get",
      exposure: "excluded",
    });
  });

  it.each([
    ["/api/v1/admin/categories/form-options", "dashboard.categories.form_options"],
    ["/api/v1/admin/collections/form-options", "dashboard.collections.form_options"],
    ["/api/v1/admin/collections/category-options", "dashboard.collections.category_options"],
    [
      "/api/v1/admin/settings/checkout-languages/active",
      "dashboard.checkout_languages.active_get",
    ],
  ])("prefers the exact static route over an overlapping parameter route", (path, operationId) => {
    expect(resolveDirectAgentOperation("GET", path)).toMatchObject({
      operationId,
      exposure: "execute",
    });
  });
});
