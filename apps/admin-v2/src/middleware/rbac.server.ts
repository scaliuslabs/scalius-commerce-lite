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
    return createRbacContext(new Set<string>(), true);
  }

  const [
    { env },
    { getDb },
    { getUserPermissions, isSuperAdmin },
    { retryTransientD1 },
  ] = await Promise.all([
    import("cloudflare:workers"),
    import("@scalius/database/client"),
    import("@scalius/core/auth/rbac/helpers"),
    import("@scalius/core/utils/transient-d1"),
  ]);
  const db = getDb(env as Env);
  const kv = (env as Env).CACHE as KVNamespace | undefined;

  const permissions = await retryTransientD1(() => getUserPermissions(db, userId, kv));
  const superAdmin =
    typeof knownIsSuperAdmin === "boolean"
      ? knownIsSuperAdmin
      : await retryTransientD1(() => isSuperAdmin(db, userId));

  return createRbacContext(permissions, superAdmin);
}
