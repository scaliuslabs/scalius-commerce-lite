export const ADMIN_ACCESS_DENIED_PATH = "/admin/access-denied";

export function hasRbacAdminAccess({
  isSuperAdmin,
  permissions,
}: {
  isSuperAdmin: boolean;
  permissions: Set<string> | string[];
}): boolean {
  const permissionCount = Array.isArray(permissions)
    ? permissions.length
    : permissions.size;
  return isSuperAdmin || permissionCount > 0;
}

export function shouldAllowAdminPath(
  pathname: string,
  hasAdminAccess: boolean,
): boolean {
  return hasAdminAccess || pathname === ADMIN_ACCESS_DENIED_PATH;
}
