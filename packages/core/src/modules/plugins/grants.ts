// Which RBAC permissions a plugin may ever hold. Plugins act on store data with
// the same permission catalog staff roles use, minus the areas that confer
// authority over people, credentials, data egress or plugins themselves: a
// plugin can neither request nor be granted them, and operations guarded by
// them are refused at dispatch whatever the grant says.

import { PERMISSION_METADATA } from "../../auth/rbac/permissions";
import type { PluginGrantRequest } from "@scalius/shared/plugins";

/**
 * RBAC resources a plugin can never hold: staff and roles (`team`), agent
 * credentials (`agent_access`), webhook endpoints (a second, unaudited egress
 * path around `allowedHosts`) and app management (`apps`: activating,
 * configuring or removing plugins, and using other apps, stays with people).
 */
export const PLUGIN_RESERVED_PERMISSION_RESOURCES: ReadonlySet<string> = new Set([
  "team",
  "agent_access",
  "webhooks",
  "apps",
]);

type PermissionMetadataEntry = { resource: string };

function permissionMetadata(permission: string): PermissionMetadataEntry | undefined {
  return Object.prototype.hasOwnProperty.call(PERMISSION_METADATA, permission)
    ? (PERMISSION_METADATA as Record<string, PermissionMetadataEntry>)[permission]
    : undefined;
}

/** A live catalog permission outside the reserved areas. */
export function isPluginGrantablePermission(permission: string): boolean {
  const metadata = permissionMetadata(permission);
  return metadata !== undefined && !PLUGIN_RESERVED_PERMISSION_RESOURCES.has(metadata.resource);
}

export function isKnownPermission(permission: string): boolean {
  return permissionMetadata(permission) !== undefined;
}

/** The permissions a grant actually confers today: its list ∩ the live, grantable catalog. */
export function effectivePluginPermissions(grant: Pick<PluginGrantRequest, "permissions"> | null): Set<string> {
  if (!grant) return new Set();
  return new Set(grant.permissions.filter(isPluginGrantablePermission));
}
