import { describe, expect, it, vi } from "vitest";
import { createSqliteD1Database } from "@scalius/database/testing/sqlite-d1";
import { getAllPermissionNames, PERMISSIONS } from "./permissions";
import {
  getAllRolesWithPermissions,
  getUserPermissions,
  removeRoleFromUser,
  setUserPermissionOverride,
} from "./helpers";

function createSelectChain() {
  const chain = {
    from: vi.fn(() => chain),
    innerJoin: vi.fn(() => chain),
    where: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  };
  return chain;
}

describe("RBAC permission resolution", () => {

  it("loads a bounded role page and only its permissions", async () => {
    const rolesResult = [
      { id: "role_a", name: "catalog", displayName: "Catalog", description: null, isSystem: false, createdAt: 1, updatedAt: 1 },
      { id: "role_b", name: "orders", displayName: "Orders", description: null, isSystem: false, createdAt: 1, updatedAt: 1 },
      { id: "role_empty", name: "support", displayName: "Support", description: null, isSystem: false, createdAt: 1, updatedAt: 1 },
    ];
    const permissionResult = [
      { roleId: "role_a", name: PERMISSIONS.PRODUCTS_VIEW },
      { roleId: "role_a", name: PERMISSIONS.PRODUCTS_EDIT },
      { roleId: "role_b", name: PERMISSIONS.ORDERS_VIEW },
    ];
    const roleQuery = {
      from: vi.fn(() => ({
        orderBy: vi.fn(() => ({
          limit: vi.fn(() => ({
            offset: vi.fn(async () => rolesResult),
          })),
        })),
      })),
    };
    const permissionQuery = {
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(async () => permissionResult),
        })),
      })),
    };
    const db = {
      select: vi.fn()
        .mockReturnValueOnce(roleQuery)
        .mockReturnValueOnce(permissionQuery),
      batch: vi.fn(),
    };

    const result = await getAllRolesWithPermissions(db as never);

    expect(result).toEqual([
      {
        id: "role_a",
        name: "catalog",
        displayName: "Catalog",
        description: null,
        isSystem: false,
        createdAt: 1,
        updatedAt: 1,
        permissions: [PERMISSIONS.PRODUCTS_VIEW, PERMISSIONS.PRODUCTS_EDIT],
        permissionsTruncated: false,
      },
      {
        id: "role_b",
        name: "orders",
        displayName: "Orders",
        description: null,
        isSystem: false,
        createdAt: 1,
        updatedAt: 1,
        permissions: [PERMISSIONS.ORDERS_VIEW],
        permissionsTruncated: false,
      },
      {
        id: "role_empty",
        name: "support",
        displayName: "Support",
        description: null,
        isSystem: false,
        createdAt: 1,
        updatedAt: 1,
        permissions: [],
        permissionsTruncated: false,
      },
    ]);
    expect(db.select).toHaveBeenCalledTimes(2);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("derives known super-admin authority from the code registry", async () => {
    const db = { batch: vi.fn(), select: vi.fn() };

    const resolved = await getUserPermissions(db as never, "super_1", true);

    expect(resolved).toEqual(new Set(getAllPermissionNames()));
    expect(resolved).toContain(PERMISSIONS.TAXES_VIEW);
    expect(resolved).toContain(PERMISSIONS.TAXES_MANAGE);
    expect(db.batch).not.toHaveBeenCalled();
  });

  it("uses the code registry when D1 identifies a super admin", async () => {
    const selectChain = createSelectChain();
    const db = {
      select: vi.fn(() => selectChain),
      batch: vi.fn().mockResolvedValue([
        [{ id: "super_2", isSuperAdmin: true }],
        [],
        [],
      ]),
    };

    const resolved = await getUserPermissions(db as never, "super_2");

    expect(resolved).toEqual(new Set(getAllPermissionNames()));
    expect(resolved).toContain(PERMISSIONS.TAXES_VIEW);
    // Three select builders form the D1 batch; there is no fourth permissions-table
    // read after the authoritative super-admin row is known.
    expect(db.select).toHaveBeenCalledTimes(3);
  });

  it("revokes on the very next check after a role removal or an explicit denial", async () => {
    const { sqlite, db } = createSqliteD1Database();
    sqlite.exec(`
      INSERT INTO user (id, name, email, email_verified, role) VALUES ('staff', 'Staff', 'staff@shop.test', 1, 'admin');
      INSERT INTO permissions (id, name, display_name, resource, action, category) VALUES
        ('perm_view', '${PERMISSIONS.ORDERS_VIEW}', 'View orders', 'orders', 'view', 'orders'),
        ('perm_products', '${PERMISSIONS.PRODUCTS_VIEW}', 'View products', 'products', 'view', 'products');
      INSERT INTO roles (id, name, display_name) VALUES ('role_ops', 'ops', 'Ops'), ('role_catalog', 'catalog', 'Catalog');
      INSERT INTO role_permissions (id, role_id, permission_id) VALUES ('rp1', 'role_ops', 'perm_view'), ('rp2', 'role_catalog', 'perm_products');
      INSERT INTO user_roles (id, user_id, role_id) VALUES ('ur1', 'staff', 'role_ops'), ('ur2', 'staff', 'role_catalog');
    `);

    expect(await getUserPermissions(db, "staff")).toEqual(new Set([PERMISSIONS.ORDERS_VIEW, PERMISSIONS.PRODUCTS_VIEW]));

    await removeRoleFromUser(db, "staff", "role_ops");
    expect(await getUserPermissions(db, "staff")).toEqual(new Set([PERMISSIONS.PRODUCTS_VIEW]));

    await setUserPermissionOverride(db, "staff", PERMISSIONS.PRODUCTS_VIEW, false);
    expect(await getUserPermissions(db, "staff")).toEqual(new Set());
    expect(await getUserPermissions(db, "missing")).toEqual(new Set());
  });
});
