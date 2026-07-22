import { describe, expect, it } from "vitest";
import { assertPermissionSubset } from "./rbac";

describe("RBAC delegation authority", () => {
  it("allows the owner to delegate any permission", () => {
    expect(() => assertPermissionSubset(
      { isSuperAdmin: true },
      new Set(),
      ["orders.refund"],
    )).not.toThrow();
  });

  it("allows staff to delegate only permissions they currently hold", () => {
    expect(() => assertPermissionSubset(
      { isSuperAdmin: false },
      new Set(["products.view", "team.manage_roles"]),
      ["products.view"],
    )).not.toThrow();

    expect(() => assertPermissionSubset(
      { isSuperAdmin: false },
      new Set(["products.view", "team.manage_roles"]),
      ["orders.refund"],
    )).toThrow("cannot grant or restore permissions");
  });
});
