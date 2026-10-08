import { useQuery } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";
import { appsQueryOptions } from "~/lib/api-query-options/apps";

/**
 * The name of the app that owns a content type, for "Managed by …". Staff who
 * cannot see Apps get the app's id, which still says who it is.
 */
export function useAppName(pluginId: string, enabled: boolean): string {
  const canView = usePermissions().hasPermission(PERMISSIONS.APPS_VIEW);
  const apps = useQuery({ ...appsQueryOptions(), enabled: enabled && canView });
  return apps.data?.apps.find((app) => app.id === pluginId)?.name ?? pluginId;
}
