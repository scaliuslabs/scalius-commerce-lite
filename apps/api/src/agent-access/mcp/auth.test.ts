import { describe, expect, it } from "vitest";
import { isAgentOAuthProps, isAgentOAuthPropsForResource } from "./auth";

const baseProps = {
  grantId: "agr_0123456789abcdefghij",
  ownerUserId: "b2de2a7d-d990-4456-b69e-27d55710938c",
  resource: "dashboard" as const,
  permissions: ["products.view"],
  riskCeiling: "read" as const,
  audience: ["https://api.example.test/api/v1/mcp/dashboard"],
};

describe("verified MCP props grammar", () => {
  it("accepts repository UUID and printable legacy user IDs", () => {
    expect(isAgentOAuthProps(baseProps)).toBe(true);
    expect(isAgentOAuthProps({ ...baseProps, ownerUserId: "legacy-admin-id" })).toBe(true);
  });

  it("rejects control, blank, oversized, and wrong-surface shapes", () => {
    expect(isAgentOAuthProps({ ...baseProps, ownerUserId: "admin\nspoof" })).toBe(false);
    expect(isAgentOAuthProps({ ...baseProps, ownerUserId: "" })).toBe(false);
    expect(isAgentOAuthProps({ ...baseProps, ownerUserId: "x".repeat(161) })).toBe(false);
    expect(isAgentOAuthProps({ ...baseProps, audience: [] })).toBe(false);
  });

  it("binds verified props to the exact resource and canonical audience", () => {
    expect(isAgentOAuthPropsForResource(
      baseProps,
      "dashboard",
      "https://api.example.test",
    )).toBe(true);
    expect(isAgentOAuthPropsForResource(
      baseProps,
      "storefront",
      "https://api.example.test",
    )).toBe(false);
    expect(isAgentOAuthPropsForResource(
      { ...baseProps, resource: "storefront" },
      "storefront",
      "https://api.example.test",
    )).toBe(false);
  });
});
