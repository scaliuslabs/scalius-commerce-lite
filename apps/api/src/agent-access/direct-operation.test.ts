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
      "POST",
      "/api/v1/storefront/agent-contexts/asc_12345678901234567890/customer/auth",
    )).toMatchObject({
      operationId: "storefront.customer_auth.begin",
      exposure: "excluded",
    });
  });
});
