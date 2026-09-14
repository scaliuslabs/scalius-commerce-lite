/**
 * Server-only RBAC helpers. Isolated from client bundles.
 */

export interface RbacContext {
  permissions: Set<string>;
  isSuperAdmin: boolean;
  hasAdminAccess: boolean;
}

function createRbacContext(
  permissions: Set<string>,
  isSuperAdmin: boolean,
): RbacContext {
  return {
    permissions,
    isSuperAdmin,
    hasAdminAccess: isSuperAdmin || permissions.size > 0,
  };
}

/**
 * Load the currently persisted RBAC authority for a user.
 */
export async function loadUserPermissions(
  userId: string,
  _userRole?: string | null,
  knownIsSuperAdmin?: boolean | null,
): Promise<RbacContext> {
  if (knownIsSuperAdmin === true) {
    const { getAllPermissionNames } = await import(
      "@scalius/core/auth/rbac/permissions"
    );
    return createRbacContext(new Set(getAllPermissionNames()), true);
  }

  const [
    { getRuntimeEnv },
    { getDb },
    { getUserPermissions, isSuperAdmin },
    { retryTransientD1 },
  ] = await Promise.all([
    import("~/lib/runtime-env.server"),
    import("@scalius/database/client"),
    import("@scalius/core/auth/rbac/helpers"),
    import("@scalius/core/utils/transient-d1"),
  ]);
  const env = getRuntimeEnv();
  const db = getDb(env);
  const kv = env.CACHE as KVNamespace | undefined;

  const permissions = await retryTransientD1(() => getUserPermissions(db, userId, kv));
  const superAdmin =
    typeof knownIsSuperAdmin === "boolean"
      ? knownIsSuperAdmin
      : await retryTransientD1(() => isSuperAdmin(db, userId));

  return createRbacContext(permissions, superAdmin);
}
