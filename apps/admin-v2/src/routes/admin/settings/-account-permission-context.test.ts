import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const settingsRouteDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(settingsRouteDir, "../../..");

const readSource = (pathFromSrc: string) =>
  readFileSync(resolve(srcDir, pathFromSrc), "utf8");

describe("account settings permission context", () => {
  it("uses the parent admin permission context instead of nesting a provider", () => {
    const routeSource = readSource("routes/admin/settings/account.tsx");
    const accountSettingsSource = readSource(
      "components/admin/account-settings/AccountSettingsContainer.tsx",
    );
    const legacyWrapperPath = resolve(
      srcDir,
      "components/admin/AccountSettingsWithPermissions.tsx",
    );

    expect(routeSource).toContain(
      'from "~/components/admin/account-settings"',
    );
    expect(routeSource).not.toContain("AccountSettingsWithPermissions");
    expect(routeSource).not.toContain("PermissionProvider");
    expect(routeSource).not.toContain("security.isSuperAdmin");
    expect(existsSync(legacyWrapperPath)).toBe(false);
    expect(accountSettingsSource).toContain("usePermissions");
    expect(accountSettingsSource).not.toContain("PermissionProvider");
  });

  it("refreshes the admin route context after role and permission mutations", () => {
    const routeContextSource = readSource("lib/admin-route-context.ts");
    const rolesSource = readSource("components/admin/RolesManagement.tsx");
    const userPermissionSource = readSource(
      "components/admin/UserPermissionEditor.tsx",
    );

    expect(routeContextSource).toContain("refreshAdminRouteContext");
    expect(routeContextSource).toContain("clearAdminRouteContextCache()");
    expect(routeContextSource).toContain("router.invalidate()");

    expect(rolesSource).toContain("refreshAdminRouteContext");
    expect(rolesSource.match(/await refreshPermissions\(\)/g)).toHaveLength(3);

    expect(userPermissionSource).toContain("refreshAdminRouteContext");
    expect(userPermissionSource.match(/await refreshPermissions\(\)/g)).toHaveLength(
      4,
    );
  });
});
