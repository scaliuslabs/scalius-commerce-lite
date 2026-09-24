import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { builtInRoleMessages, permissionMessages } from "~/i18n/settings-users";
import {
  BUILT_IN_ROLES,
  PERMISSION_GROUPS,
  accessChanges,
  builtInRole,
  canGrantRole,
  effectivePermissions,
  getStaffStatus,
  lockedReason,
  roleKey,
  sameAccess,
  setAccessPermissions,
  setPermission,
  staffActions,
  togglePermissions,
  type StaffAccess,
} from "./staff-access";

const base = { twoFactorEnabled: true, mustChangePassword: false, mustEnrollTwoFactor: false, suspended: false };
const viewer = { id: "me", canManageStaff: true, canManageRoles: true };

describe("staff status", () => {
  it("reports only real, actionable facts", () => {
    expect(getStaffStatus(base)).toBe("ready");
    expect(getStaffStatus({ ...base, twoFactorEnabled: false })).toBe("two_factor_setup");
    expect(getStaffStatus({ ...base, mustChangePassword: true })).toBe("password_setup");
    expect(getStaffStatus({ ...base, mustChangePassword: true, invitation: { status: "pending" } })).toBe("invite_pending");
    expect(getStaffStatus({ ...base, invitation: { status: "expired" } })).toBe("invite_expired");
    expect(getStaffStatus({ ...base, invitation: { status: "delivery_failed" } })).toBe("invite_delivery_failed");
    expect(getStaffStatus({ ...base, suspended: true, invitation: { status: "pending" } })).toBe("suspended");
  });
});

describe("staff actions", () => {
  const nothing = { editAccess: false, resendInvite: false, cancelInvite: false, restore: false, suspend: false, remove: false };

  it("never lets anyone change their own access or the store owner's", () => {
    expect(staffActions({ id: "me", isSuperAdmin: false, status: "ready" }, viewer)).toEqual(nothing);
    expect(staffActions({ id: "owner", isSuperAdmin: true, status: "ready" }, viewer)).toEqual(nothing);
  });

  it("suspends signed-up staff, cancels invites and restores suspended staff", () => {
    expect(staffActions({ id: "a", isSuperAdmin: false, status: "ready" }, viewer)).toEqual({ ...nothing, editAccess: true, suspend: true, remove: true });
    expect(staffActions({ id: "a", isSuperAdmin: false, status: "invite_expired" }, viewer)).toEqual({
      ...nothing,
      editAccess: true,
      resendInvite: true,
      cancelInvite: true,
    });
    expect(staffActions({ id: "a", isSuperAdmin: false, status: "suspended" }, viewer)).toEqual({ ...nothing, editAccess: true, restore: true, remove: true });
    expect(staffActions({ id: "a", isSuperAdmin: false, status: "password_setup" }, viewer)).toEqual({ ...nothing, editAccess: true, remove: true });
  });

  it("splits staff management from role management", () => {
    const target = { id: "a", isSuperAdmin: false, status: "ready" as const };
    expect(staffActions(target, { ...viewer, canManageRoles: false })).toEqual({ ...nothing, suspend: true, remove: true });
    expect(staffActions(target, { ...viewer, canManageStaff: false })).toEqual({ ...nothing, editAccess: true });
    expect(staffActions(target, { id: "me", canManageStaff: false, canManageRoles: false })).toEqual(nothing);
  });

  it("explains only the rows that are fixed for everyone", () => {
    expect(lockedReason({ id: "me", isSuperAdmin: false }, viewer)).toBe("self");
    expect(lockedReason({ id: "owner", isSuperAdmin: true }, viewer)).toBe("owner");
    expect(lockedReason({ id: "a", isSuperAdmin: false }, viewer)).toBeNull();
  });
});

describe("permission prerequisites in the checklist", () => {
  it("ticks what a permission needs and unticks what depends on it", () => {
    const edit = togglePermissions(new Set(), [PERMISSIONS.PRODUCTS_EDIT], true);
    expect(edit).toEqual(new Set([PERMISSIONS.PRODUCTS_EDIT, PERMISSIONS.PRODUCTS_VIEW]));
    expect(togglePermissions(edit, [PERMISSIONS.PRODUCTS_VIEW], false)).toEqual(new Set());
    expect(togglePermissions(edit, [PERMISSIONS.PRODUCTS_EDIT], false)).toEqual(new Set([PERMISSIONS.PRODUCTS_VIEW]));
  });

  it("selects a whole section with its prerequisites", () => {
    const home = PERMISSION_GROUPS.find((group) => group.group === "home")!.permissions;
    expect(togglePermissions(new Set(), home, true)).toEqual(new Set(home));
    expect(togglePermissions(new Set(home), home, false)).toEqual(new Set());
  });
});

describe("who can hand out a role", () => {
  const viewerPermissions = new Set<string>([PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_EDIT]);

  it("follows the server: only access you have, and the owner role only from the owner", () => {
    const orders = { name: "orders", permissions: [PERMISSIONS.ORDERS_VIEW] };
    const manager = { name: "manager", permissions: [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_REFUND] };
    const owner = { name: "super_admin", permissions: [] };
    expect(canGrantRole(orders, { isOwner: false, permissions: viewerPermissions })).toBe(true);
    expect(canGrantRole(manager, { isOwner: false, permissions: viewerPermissions })).toBe(false);
    expect(canGrantRole(owner, { isOwner: false, permissions: viewerPermissions })).toBe(false);
    expect(canGrantRole(manager, { isOwner: true, permissions: new Set() })).toBe(true);
  });

  it("names every built-in role in both languages and leaves custom names alone", () => {
    for (const role of BUILT_IN_ROLES) {
      expect(builtInRoleMessages.en[role]).toBeTruthy();
      expect(builtInRoleMessages.bn[role]).toBeTruthy();
    }
    expect(builtInRole("sales_rep")).toBe("sales_rep");
    expect(builtInRole("packers")).toBeNull();
  });
});

describe("staff access edits", () => {
  const roles = [
    { id: "r_orders", permissions: [PERMISSIONS.ORDERS_VIEW, PERMISSIONS.ORDERS_EDIT] },
    { id: "r_products", permissions: [PERMISSIONS.PRODUCTS_VIEW] },
  ];
  const saved: StaffAccess = { roleIds: ["r_orders"], grants: [], denials: [] };

  it("turns ticks into overrides only where they differ from the roles", () => {
    const denied = setPermission(saved, roles, PERMISSIONS.ORDERS_EDIT, false);
    expect(denied).toEqual({ roleIds: ["r_orders"], grants: [], denials: [PERMISSIONS.ORDERS_EDIT] });
    const granted = setPermission(denied, roles, PERMISSIONS.PRODUCTS_VIEW, true);
    expect(granted.grants).toEqual([PERMISSIONS.PRODUCTS_VIEW]);
    expect([...effectivePermissions(granted, roles)].sort()).toEqual([PERMISSIONS.ORDERS_VIEW, PERMISSIONS.PRODUCTS_VIEW].sort());
    // Ticking back to what the role gives clears the override.
    expect(sameAccess(setPermission(denied, roles, PERMISSIONS.ORDERS_EDIT, true), saved)).toBe(true);
  });

  it("treats a denied view as denying what depends on it, like the server", () => {
    const denied = setPermission(saved, roles, PERMISSIONS.ORDERS_VIEW, false);
    expect(effectivePermissions(denied, roles)).toEqual(new Set());
  });

  it("turns a whole new permission set into the smallest overrides", () => {
    const next = new Set<string>([PERMISSIONS.ORDERS_VIEW, PERMISSIONS.PRODUCTS_VIEW]);
    const draft = setAccessPermissions(saved, roles, next);
    expect(draft).toEqual({ roleIds: ["r_orders"], grants: [PERMISSIONS.PRODUCTS_VIEW], denials: [PERMISSIONS.ORDERS_EDIT] });
    expect(effectivePermissions(draft, roles)).toEqual(next);
  });

  it("adds roles before removing any, then sets and clears overrides", () => {
    const current: StaffAccess = { roleIds: ["r_orders"], grants: [PERMISSIONS.MEDIA_VIEW], denials: [PERMISSIONS.ORDERS_EDIT] };
    const draft: StaffAccess = { roleIds: ["r_products"], grants: [], denials: [PERMISSIONS.MEDIA_VIEW] };
    expect(accessChanges(current, draft)).toEqual({
      addRoles: ["r_products"],
      removeRoles: ["r_orders"],
      setOverrides: [{ permission: PERMISSIONS.MEDIA_VIEW, granted: false }],
      clearOverrides: [PERMISSIONS.ORDERS_EDIT],
    });
    expect(accessChanges(current, current)).toEqual({ addRoles: [], removeRoles: [], setOverrides: [], clearOverrides: [] });
  });
});

describe("permission catalog", () => {
  it("groups and labels every permission key exactly once", () => {
    const grouped = PERMISSION_GROUPS.flatMap((group) => group.permissions);
    expect(grouped.sort()).toEqual(Object.values(PERMISSIONS).sort());
    for (const permission of grouped) {
      expect(permissionMessages.en[permission]).toBeTruthy();
      expect(permissionMessages.bn[permission]).toBeTruthy();
    }
  });

  it("derives a stored role key from the typed name", () => {
    expect(roleKey("Order Manager")).toBe("order_manager");
    expect(roleKey("  Support (Dhaka)! ")).toBe("support_dhaka");
    expect(roleKey("ম্যানেজার", () => "role_x")).toBe("role_x");
  });
});
