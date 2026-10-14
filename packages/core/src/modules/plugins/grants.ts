// What an app's approved scopes confer. A manifest asks for access scopes
// (`PLUGIN_SCOPES`, @scalius/shared/plugins/scopes); the platform maps them to
// the same RBAC permissions staff roles use, minus the areas that confer
// authority over people, credentials, data egress or apps themselves: no
// scope maps to them (scopes test), and operations guarded by them are
// refused at dispatch whatever the grant says.

import { PERMISSION_METADATA } from "../../auth/rbac/permission-metadata";
import { FIRST_PARTY_PLUGIN_VENDOR, pluginScopePermissions, type PluginGrantRequest } from "@scalius/shared/plugins";
import type { PluginInstallationSource } from "@scalius/database/schema";

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

/** The RBAC permissions a grant actually confers today: its scopes' permissions ∩ the live, grantable catalog. */
export function effectivePluginPermissions(grant: Pick<PluginGrantRequest, "scopes"> | null): Set<string> {
  if (!grant) return new Set();
  return new Set([...pluginScopePermissions(grant.scopes)].filter(isPluginGrantablePermission));
}

/**
 * A bundled first-party app (`scalius.*` compiled into this deployment): it
 * may also call `beta` operations. Everything else is third-party and reaches
 * the stable app API only.
 */
export function isFirstPartyBundledPlugin(installation: { pluginId: string; source: PluginInstallationSource }): boolean {
  return installation.source === "bundled" && installation.pluginId.startsWith(`${FIRST_PARTY_PLUGIN_VENDOR}.`);
}
