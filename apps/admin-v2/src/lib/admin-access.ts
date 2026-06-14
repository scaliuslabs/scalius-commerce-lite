import {
  getDefaultAdminPage,
  hasPageAccess,
} from "@scalius/core/auth/rbac/page-permissions";

export const ADMIN_ACCESS_DENIED_PATH = "/admin/access-denied";

type PermissionCollection = Set<string> | string[];

export interface AdminAccessContext {
  isSuperAdmin: boolean;
  permissions: PermissionCollection;
  hasAdminAccess?: boolean;
}

function toPermissionSet(permissions: PermissionCollection): Set<string> {
  return Array.isArray(permissions) ? new Set(permissions) : permissions;
}

function normalizeAdminPath(pathname: string): string {
  if (pathname === "/admin/") return "/admin";
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function hasRbacAdminAccess({
  isSuperAdmin,
  permissions,
}: {
  isSuperAdmin: boolean;
  permissions: PermissionCollection;
}): boolean {
  const permissionCount = Array.isArray(permissions)
    ? permissions.length
    : permissions.size;
  return isSuperAdmin || permissionCount > 0;
}

export function canAccessAdminPath(
  pathname: string,
  context: AdminAccessContext,
): boolean {
  const normalizedPath = normalizeAdminPath(pathname);
  if (normalizedPath === ADMIN_ACCESS_DENIED_PATH) return true;

  const hasAdminAccess =
    context.hasAdminAccess ??
    hasRbacAdminAccess({
      isSuperAdmin: context.isSuperAdmin,
      permissions: context.permissions,
    });
  if (!hasAdminAccess) return false;

  return hasPageAccess(
    toPermissionSet(context.permissions),
    context.isSuperAdmin,
    normalizedPath,
  );
}

export function getDefaultAdminPath(context: AdminAccessContext): string {
  const hasAdminAccess =
    context.hasAdminAccess ??
    hasRbacAdminAccess({
      isSuperAdmin: context.isSuperAdmin,
      permissions: context.permissions,
    });
  if (!hasAdminAccess) return ADMIN_ACCESS_DENIED_PATH;

  return (
    getDefaultAdminPage(
      toPermissionSet(context.permissions),
      context.isSuperAdmin,
    ) ?? ADMIN_ACCESS_DENIED_PATH
  );
}

export function shouldAllowAdminPath(
  pathname: string,
  access: boolean | AdminAccessContext,
): boolean {
  if (typeof access === "boolean") {
    return access || normalizeAdminPath(pathname) === ADMIN_ACCESS_DENIED_PATH;
  }
  return canAccessAdminPath(pathname, access);
}
