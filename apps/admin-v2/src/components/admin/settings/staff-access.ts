import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import type { PermissionName } from "@scalius/core/auth/rbac/types";

// ── Permission groups (plain merchant words; keys stay exactly as stored) ──

export type PermissionGroup =
  | "home"
  | "orders"
  | "products"
  | "customers"
  | "discounts"
  | "content"
  | "tracking"
  | "settings"
  | "staff";

const GROUP_BY_RESOURCE: Record<string, PermissionGroup> = {
  dashboard: "home",
  orders: "orders",
  products: "products",
  categories: "products",
  collections: "products",
  attributes: "products",
  customers: "customers",
  discounts: "discounts",
  pages: "content",
  media: "content",
  analytics: "tracking",
  settings: "settings",
  taxes: "settings",
  agent_access: "settings",
  team: "staff",
};

const GROUP_ORDER: PermissionGroup[] = [
  "home", "orders", "products", "customers", "discounts", "content", "tracking", "settings", "staff",
];

export const PERMISSION_GROUPS: ReadonlyArray<{ group: PermissionGroup; permissions: PermissionName[] }> =
  GROUP_ORDER.map((group) => ({
    group,
    permissions: Object.values(PERMISSIONS).filter(
      (permission) => (GROUP_BY_RESOURCE[permission.split(".")[0]!] ?? "settings") === group,
    ),
  }));

// ── Staff status: only real facts a merchant can act on ──

export interface StaffStatusInput {
  twoFactorEnabled: boolean;
  mustChangePassword: boolean;
  mustEnrollTwoFactor: boolean;
  suspended: boolean;
  invitation?: { status: "pending" | "expired" | "delivery_failed" } | null;
}

export type StaffStatus =
  | "ready"
  | "suspended"
  | "invite_pending"
  | "invite_expired"
  | "invite_delivery_failed"
  | "password_setup"
  | "two_factor_setup";

export function getStaffStatus(user: StaffStatusInput): StaffStatus {
  if (user.suspended) return "suspended";
  if (user.invitation?.status === "delivery_failed") return "invite_delivery_failed";
  if (user.invitation?.status === "expired") return "invite_expired";
  if (user.invitation?.status === "pending") return "invite_pending";
  if (user.mustChangePassword) return "password_setup";
  if (user.mustEnrollTwoFactor || !user.twoFactorEnabled) return "two_factor_setup";
  return "ready";
}

// ── What the viewer may do to one staff member (the API stays authoritative) ──

export interface StaffActions {
  editAccess: boolean;
  resendInvite: boolean;
  cancelInvite: boolean;
  restore: boolean;
  suspend: boolean;
}

export function staffActions(
  target: { id: string; isSuperAdmin: boolean; status: StaffStatus },
  viewer: { id: string; canManageStaff: boolean; canManageRoles: boolean },
): StaffActions {
  // Nobody changes their own access or the store owner's.
  const locked = target.id === viewer.id || target.isSuperAdmin;
  const invited = target.status.startsWith("invite_");
  const manage = viewer.canManageStaff && !locked;
  return {
    editAccess: viewer.canManageRoles && !locked,
    resendInvite: manage && invited,
    cancelInvite: manage && invited,
    restore: manage && target.status === "suspended",
    suspend: manage && !invited && target.status !== "password_setup" && target.status !== "suspended",
  };
}

// ── Staff access draft: roles plus per-person overrides ──

export interface StaffAccess {
  roleIds: string[];
  grants: string[];
  denials: string[];
}

export interface RolePermissions {
  id: string;
  permissions: readonly string[];
}

const sorted = (values: Iterable<string>) => [...new Set(values)].sort();

export function normalizeAccess(access: StaffAccess): StaffAccess {
  return { roleIds: sorted(access.roleIds), grants: sorted(access.grants), denials: sorted(access.denials) };
}

export function sameAccess(a: StaffAccess, b: StaffAccess): boolean {
  return JSON.stringify(normalizeAccess(a)) === JSON.stringify(normalizeAccess(b));
}

export function rolePermissionSet(roleIds: readonly string[], roles: readonly RolePermissions[]): Set<string> {
  const selected = new Set(roleIds);
  return new Set(roles.filter((role) => selected.has(role.id)).flatMap((role) => role.permissions));
}

/** What this person can actually do: overrides win over their roles. */
export function effectivePermissions(access: StaffAccess, roles: readonly RolePermissions[]): Set<string> {
  const effective = rolePermissionSet(access.roleIds, roles);
  for (const permission of access.grants) effective.add(permission);
  for (const permission of access.denials) effective.delete(permission);
  return effective;
}

/** Ticking a box sets an override only when it differs from the roles. */
export function setPermission(
  access: StaffAccess,
  roles: readonly RolePermissions[],
  permission: string,
  on: boolean,
): StaffAccess {
  const fromRoles = rolePermissionSet(access.roleIds, roles).has(permission);
  const grants = access.grants.filter((key) => key !== permission);
  const denials = access.denials.filter((key) => key !== permission);
  if (on && !fromRoles) grants.push(permission);
  if (!on && fromRoles) denials.push(permission);
  return { ...access, grants, denials };
}

export interface AccessChanges {
  addRoles: string[];
  removeRoles: string[];
  setOverrides: Array<{ permission: string; granted: boolean }>;
  clearOverrides: string[];
}

function overrideOf(access: StaffAccess, permission: string): boolean | undefined {
  if (access.grants.includes(permission)) return true;
  if (access.denials.includes(permission)) return false;
  return undefined;
}

/** API calls that turn `saved` into `draft`. Roles are added before any are removed. */
export function accessChanges(saved: StaffAccess, draft: StaffAccess): AccessChanges {
  const setOverrides: AccessChanges["setOverrides"] = [];
  const clearOverrides: string[] = [];
  for (const permission of sorted([...saved.grants, ...saved.denials, ...draft.grants, ...draft.denials])) {
    const before = overrideOf(saved, permission);
    const after = overrideOf(draft, permission);
    if (before === after) continue;
    if (after === undefined) clearOverrides.push(permission);
    else setOverrides.push({ permission, granted: after });
  }
  return {
    addRoles: sorted(draft.roleIds).filter((id) => !saved.roleIds.includes(id)),
    removeRoles: sorted(saved.roleIds).filter((id) => !draft.roleIds.includes(id)),
    setOverrides,
    clearOverrides,
  };
}

// ── Roles ──

export const OWNER_ROLE = "super_admin";

/** Stored role key from the name the merchant types (lowercase, digits, underscores). */
export function roleKey(displayName: string, fallback: () => string = () => `role_${Date.now().toString(36)}`): string {
  const key = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
  return key || fallback();
}
