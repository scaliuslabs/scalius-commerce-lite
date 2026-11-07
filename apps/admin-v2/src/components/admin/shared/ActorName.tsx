// The one renderer of who did something (lib/actor.ts words it). An app is
// named from the installed apps the dashboard already reads (the Apps list,
// one cached query, then the removed apps' names), never by a request per row,
// and only when an app is among the actors shown.
import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { PERMISSIONS } from "@scalius/core/auth/rbac/permissions";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { actorMessages } from "~/i18n/actor";
import { actorAppIds, formatActor, type Actor, type AppName } from "~/lib/actor";
import { appsQueryOptions, removedAppDataQueryOptions } from "~/lib/api-query-options/apps";

/** Installed apps change rarely; a history list needn't re-read them on every visit. */
const APP_NAMES_STALE_MS = 5 * 60 * 1000;
const UNKNOWN: AppName = { status: "unknown" };
const GONE: AppName = { status: "gone" };

/**
 * The names of these apps, from the installed apps (and, for an app no longer
 * installed, the removed apps' data). Nothing is read without an app id or
 * without apps.view; those apps read as unknown.
 */
export function useAppNames(appIds: readonly string[]): (appId: string) => AppName {
  const canView = usePermissions().hasPermission(PERMISSIONS.APPS_VIEW);
  const wanted = canView && appIds.length > 0;
  const installed = useQuery({ ...appsQueryOptions(), enabled: wanted, staleTime: APP_NAMES_STALE_MS });
  const apps = installed.data?.apps;
  const missing = Boolean(apps) && appIds.some((id) => !apps!.some((app) => app.id === id));
  const removed = useQuery({ ...removedAppDataQueryOptions(), enabled: wanted && missing, staleTime: APP_NAMES_STALE_MS });
  const removedApps = removed.data;
  return useCallback((appId: string): AppName => {
    const app = apps?.find((candidate) => candidate.id === appId);
    if (app) return { status: "installed", name: app.name };
    const group = removedApps?.find((candidate) => candidate.id === appId);
    if (group) return { status: "removed", name: group.name };
    // Only both lists can say the store has no such app.
    return apps && removedApps ? GONE : UNKNOWN;
  }, [apps, removedApps]);
}

/** Words actors in the dashboard's language; pass every actor the screen shows so their apps load once. */
export function useActorText(actors: Actor | null | undefined | ReadonlyArray<Actor | null | undefined | "buyer">): (actor: Actor) => string {
  const t = useMessages(actorMessages);
  const list = Array.isArray(actors) ? actors : [actors as Actor | null | undefined];
  const appIds = actorAppIds(list);
  const appName = useAppNames(appIds);
  return useCallback((actor: Actor) => formatActor(actor, t, appName), [appName, t]);
}

/**
 * Words staff actors only (a colleague, or "Former admin"), for a screen no
 * app writes to: it reads no apps, so it needs no query client.
 */
export function useStaffActorText(): (actor: Actor) => string {
  const t = useMessages(actorMessages);
  return useCallback((actor: Actor) => formatActor(actor, t, () => UNKNOWN), [t]);
}

/** Who did something, as text: a staff name, "Former admin", an app's name or "System". */
export function ActorName({ actor }: { actor: Actor }) {
  return <>{useActorText(actor)(actor)}</>;
}
