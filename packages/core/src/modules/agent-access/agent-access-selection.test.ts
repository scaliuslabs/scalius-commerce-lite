import { describe, expect, it } from "vitest";

import { resolveGrantSelection } from "./agent-access.service";

const callerPermissions = [
  "dashboard.view",
  "products.view",
  "products.edit",
  "orders.refund",
];

describe("agent access preset selection", () => {
  it("expands an empty preset payload from the owner's authority", () => {
    const read = resolveGrantSelection(
      { resource: "dashboard", preset: "read", permissions: [] },
      callerPermissions,
      "pat",
    );
    const operator = resolveGrantSelection(
      { resource: "dashboard", preset: "operator", permissions: [] },
      callerPermissions,
      "cli",
    );

    expect(read.permissions).toEqual(["dashboard.view", "products.view"]);
    expect(operator.permissions).toEqual([
      "dashboard.view",
      "products.edit",
      "products.view",
    ]);
  });

  it("preserves a non-empty requested subset for preset approvals", () => {
    expect(
      resolveGrantSelection(
        {
          resource: "dashboard",
          preset: "read",
          permissions: ["products.view"],
        },
        callerPermissions,
        "oauth",
      ).permissions,
    ).toEqual(["products.view"]);
  });

  it("requires custom access to name at least one permission", () => {
    expect(() =>
      resolveGrantSelection(
        { resource: "dashboard", preset: "custom", permissions: [] },
        callerPermissions,
        "pat",
      ),
    ).toThrow("Custom access requires at least one permission");
  });
});
