// Who owns data in an app's namespace (its plugin id): an installed app
// ("Managed by <name>"), or one that is no longer installed ("From a removed
// app: <name>", RemovedAppData.tsx). Staff who cannot see Apps get the id.
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { usePermissions } from "~/contexts/PermissionContext";
import { useLocale, useMessages } from "~/i18n";
import { appOwnerMessages } from "~/i18n/app-owner";
import { appsQueryOptions, removedAppDataQueryOptions } from "~/lib/api-query-options/apps";
import { localizedObjectType } from "@scalius/shared/plugins/manifest-text";
import { translationFor, type Translation } from "./app-text";

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
  const locale = useLocale();
  const installed = apps.data?.apps.find((app) => app.id === namespace);
  if (installed) return { name: translationFor(installed.translations, locale)?.name ?? installed.name, removed: false };
  const group = removed.data?.find((entry) => entry.id === namespace);
  return group ? { name: group.name, removed: true } : { name: namespace, removed: false };
}

/**
 * The installed apps' manifest text in the dashboard's language, by
 * namespace (their plugin id): an app's objects, custom fields and jobs read
 * their names from it (`localizedObjectType`, `localizedCustomField`). Null
 * for the merchant's own data, an app without that language, or staff who
 * cannot see Apps (they read the manifest's English).
 */
export function useAppTexts(enabled = true): (namespace: string) => Translation | null {
  const canView = usePermissions().hasPermission(PERMISSIONS.APPS_VIEW);
  const apps = useQuery({ ...appsQueryOptions(), enabled: enabled && canView });
  const locale = useLocale();
  const list = apps.data?.apps;
  return useCallback((namespace: string) => translationFor(list?.find((app) => app.id === namespace)?.translations, locale), [list, locale]);
}

/** An app's object type (`owner: "app"`) with its name, description and field names in the dashboard's language. */
export function useLocalizedObjectTypes() {
  const appText = useAppTexts();
  return useCallback(<T extends ObjectTypeText>(definition: T): T => (
    definition.owner === "app" ? localizedObjectType(definition, appText(definition.namespace)) : definition
  ), [appText]);
}
type ObjectTypeText = Parameters<typeof localizedObjectType>[0] & { owner: string; namespace: string };

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
