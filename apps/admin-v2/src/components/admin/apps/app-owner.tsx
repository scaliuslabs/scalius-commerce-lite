// Who owns data in an app's namespace (its plugin id): an installed app
// ("Managed by <name>"), or one that is no longer installed ("From a removed
// app: <name>", RemovedAppData.tsx). Staff who cannot see Apps get the id.
import { useQuery } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { appOwnerMessages } from "~/i18n/app-owner";
import { appsQueryOptions, removedAppDataQueryOptions } from "~/lib/api-query-options/apps";

export interface AppOwner {
  /** The app's name (its id when the store has no name for it, or staff cannot see Apps). */
  name: string;
  /** The app is no longer installed: its data is "From a removed app". */
  removed: boolean;
}

/** Who owns data in an app's namespace: an installed app, or a removed one. */
export function useAppOwner(namespace: string, enabled = true): AppOwner {
  const canView = usePermissions().hasPermission(PERMISSIONS.APPS_VIEW);
  const apps = useQuery({ ...appsQueryOptions(), enabled: enabled && canView });
  const removed = useQuery({ ...removedAppDataQueryOptions(), enabled: enabled && canView });
  const installed = apps.data?.apps.find((app) => app.id === namespace);
  if (installed) return { name: installed.name, removed: false };
  const group = removed.data?.find((entry) => entry.id === namespace);
  return group ? { name: group.name, removed: true } : { name: namespace, removed: false };
}

/** What a row of an app's data says about its owner. */
export function useAppOwnerLabel(namespace: string, managedLabel: (name: string) => string, enabled = true): { label: string; removed: boolean } {
  const t = useMessages(appOwnerMessages);
  const owner = useAppOwner(namespace, enabled);
  return { label: owner.removed ? t("fromRemovedApp", { app: owner.name }) : managedLabel(owner.name), removed: owner.removed };
}

/** The badge on a row of an app's data: "Managed by …", or "From a removed app: …". */
export function AppOwnerBadge({ namespace, managedLabel, managedVariant = "info" }: {
  namespace: string;
  managedLabel: (name: string) => string;
  managedVariant?: BadgeVariant;
}) {
  const { label, removed } = useAppOwnerLabel(namespace, managedLabel);
  return <Badge variant={removed ? "warning" : managedVariant}>{label}</Badge>;
}

/** The help line of a read-only app field: "Managed by …", or "From a removed app: …". */
export function AppOwnerText({ namespace, managedLabel }: { namespace: string; managedLabel: (name: string) => string }) {
  return <>{useAppOwnerLabel(namespace, managedLabel).label}</>;
}
