// An installed app's provider answers to its port's built-in permissions
// (core `provider-permissions.ts`, which the API checks too): the settings
// page reads it with whatever reads the built-ins, and tests it with whatever
// tests or saves them.
import { PROVIDER_PORT_PERMISSIONS } from "@scalius/core/auth/rbac/provider-permissions";
import type { ProviderKind } from "@scalius/shared/plugins/providers/kinds";
import { usePermissions } from "~/contexts/PermissionContext";

export function useProviderPortAccess(kind: ProviderKind): { canView: boolean; canManage: boolean } {
  const { hasAnyPermission } = usePermissions();
  const port = PROVIDER_PORT_PERMISSIONS[kind];
  return { canView: hasAnyPermission([...port.view]), canManage: hasAnyPermission([...port.manage]) };
}
