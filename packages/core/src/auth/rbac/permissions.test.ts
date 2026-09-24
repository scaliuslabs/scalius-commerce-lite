import { describe, expect, it } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";

import { autoSeedRbacIfNeeded } from "./auto-seed";
import { getFreshUserPermissionsFromD1 } from "./helpers";
import {
  PERMISSIONS,
  permissionPrerequisites,
  withoutUnmetPrerequisites,
  withPrerequisites,
} from "./permissions";

describe("permission prerequisites", () => {
  it("makes every action need its area's view permission", () => {
    expect(permissionPrerequisites(PERMISSIONS.PRODUCTS_EDIT)).toEqual([PERMISSIONS.PRODUCTS_VIEW]);
    expect(permissionPrerequisites(PERMISSIONS.DASHBOARD_ANALYTICS)).toEqual([PERMISSIONS.DASHBOARD_VIEW]);
    expect(permissionPrerequisites(PERMISSIONS.SETTINGS_GENERAL_EDIT)).toEqual([PERMISSIONS.SETTINGS_GENERAL_VIEW]);
    expect(permissionPrerequisites(PERMISSIONS.TEAM_MANAGE_ROLES)).toEqual([PERMISSIONS.TEAM_VIEW]);
    expect(permissionPrerequisites(PERMISSIONS.PRODUCTS_PERMANENT_DELETE))
      .toEqual([PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_DELETE]);
    // No view permission exists for the storefront header, so nothing is required.
    expect(permissionPrerequisites(PERMISSIONS.SETTINGS_HEADER_EDIT)).toEqual([]);
    expect(permissionPrerequisites(PERMISSIONS.PRODUCTS_VIEW)).toEqual([]);
  });

  it("ticks what a permission needs and unticks what depends on a removed one", () => {
    expect(withPrerequisites([PERMISSIONS.PRODUCTS_PERMANENT_DELETE])).toEqual(new Set([
      PERMISSIONS.PRODUCTS_PERMANENT_DELETE,
      PERMISSIONS.PRODUCTS_VIEW,
      PERMISSIONS.PRODUCTS_DELETE,
    ]));
    expect(withoutUnmetPrerequisites([
      PERMISSIONS.PRODUCTS_EDIT,
      PERMISSIONS.PRODUCTS_DELETE,
      PERMISSIONS.PRODUCTS_PERMANENT_DELETE,
      PERMISSIONS.ORDERS_VIEW,
    ])).toEqual(new Set([PERMISSIONS.ORDERS_VIEW]));
  });

  it("keeps every built-in role consistent", async () => {
    const { sqlite, db } = createSqliteD1Database();
    await autoSeedRbacIfNeeded(db);
    const rows = sqlite.prepare(`
      SELECT r.name AS role, p.name AS permission FROM role_permissions rp
      JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
    `).all() as Array<{ role: string; permission: string }>;
    const byRole = new Map<string, Set<string>>();
    for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? new Set()).add(row.permission));
    expect(byRole.size).toBe(5);
    for (const [role, permissions] of byRole) {
      expect([role, withPrerequisites(permissions).size]).toEqual([role, permissions.size]);
    }
    sqlite.close();
  });

  it("drops a person's actions when their view permission is denied", async () => {
    const { sqlite, db } = createSqliteD1Database();
    await autoSeedRbacIfNeeded(db);
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff', 'Staff', 'staff@shop.test', 1, 'admin');
      INSERT INTO user_roles (id, user_id, role_id, created_at)
        SELECT 'ur', 'staff', id, unixepoch() FROM roles WHERE name = 'product_specialist';
      INSERT INTO user_permissions (id, user_id, permission_id, granted, created_at)
        SELECT 'deny', 'staff', id, 0, unixepoch() FROM permissions WHERE name = 'products.view';
    `);

    const effective = await getFreshUserPermissionsFromD1(db, "staff");
    expect(effective.has(PERMISSIONS.PRODUCTS_VIEW)).toBe(false);
    expect(effective.has(PERMISSIONS.PRODUCTS_EDIT)).toBe(false);
    expect(effective.has(PERMISSIONS.CATEGORIES_EDIT)).toBe(true);
    sqlite.close();
  });
});
