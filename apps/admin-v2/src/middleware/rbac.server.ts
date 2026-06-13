/**
 * Server-only RBAC helpers. Isolated from client bundles.
 */

import { getDb } from "@scalius/database/client";
import { getUserPermissions, isSuperAdmin } from "@scalius/core/auth/rbac/helpers";
import { autoSeedRbacIfNeeded } from "@scalius/core/auth/rbac/auto-seed";
import { retryTransientD1 } from "@scalius/core/utils/transient-d1";
import { env as cfEnv } from "cloudflare:workers";
import { hasRbacAdminAccess } from "~/lib/admin-access";

function getCfEnv(): Env {
  return cfEnv;
}

export interface RbacContext {
  permissions: Set<string>;
  isSuperAdmin: boolean;
  hasAdminAccess: boolean;
}

/**
 * Load RBAC permissions for a user. Auto-seeds RBAC on first access.
 */
export async function loadUserPermissions(
  userId: string,
  _userRole?: string | null,
): Promise<RbacContext> {
  const env = getCfEnv();
  const db = getDb(env);
  const kv = env.CACHE as KVNamespace | undefined;

  await retryTransientD1(() => autoSeedRbacIfNeeded(db));

  const permissions = await retryTransientD1(() => getUserPermissions(db, userId, kv));
  const superAdmin = await retryTransientD1(() => isSuperAdmin(db, userId));

  return {
    permissions,
    isSuperAdmin: superAdmin,
    hasAdminAccess: hasRbacAdminAccess({ isSuperAdmin: superAdmin, permissions }),
  };
}
