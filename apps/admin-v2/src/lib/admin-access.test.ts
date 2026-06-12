import { describe, expect, it } from "vitest";
import { hasRbacAdminAccess, shouldAllowAdminPath } from "./admin-access";

describe("admin shell access", () => {
  it("does not grant shell access from legacy role alone", () => {
    expect(
      hasRbacAdminAccess({ isSuperAdmin: false, permissions: new Set() }),
    ).toBe(false);
  });

  it("grants shell access to super admins and permission-bearing users", () => {
    expect(
      hasRbacAdminAccess({ isSuperAdmin: true, permissions: new Set() }),
    ).toBe(true);
    expect(
      hasRbacAdminAccess({
        isSuperAdmin: false,
        permissions: new Set(["products.view"]),
      }),
    ).toBe(true);
  });

  it("keeps the access-denied page reachable without opening the shell", () => {
    expect(shouldAllowAdminPath("/admin", false)).toBe(false);
    expect(shouldAllowAdminPath("/admin/products", false)).toBe(false);
    expect(shouldAllowAdminPath("/admin/access-denied", false)).toBe(true);
  });
});
