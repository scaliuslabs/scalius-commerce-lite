import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./auto-seed.ts", import.meta.url), "utf8");

describe("system RBAC reconciliation boundaries", () => {
  it("removes stale code-owned grants instead of only inserting missing grants", () => {
    expect(source).toContain("const staleGrantIds");
    expect(source).toContain("db.delete(rolePermissions)");
    expect(source).toContain("grants.size === expectedGrants.size");
  });

  it("never promotes an arbitrary legacy admin during reconciliation", () => {
    expect(source).not.toContain("setFirstAdminAsSuperAdmin");
    expect(source).not.toContain("firstAdminRows");
  });
});
