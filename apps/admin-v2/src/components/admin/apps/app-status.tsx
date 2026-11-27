import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { installedAppsMessages, type InstalledAppsMessageKey } from "~/i18n/apps";
import type { AppDetail, AppLogLine, AppSummary } from "~/lib/api-query-options/apps";

/**
 * Access waiting for approval outranks the stored status: the app runs with
 * what was approved, and the rest (an update's new permissions, a blocking
 * the store turned off) waits for the store owner.
 */
export function appStatus(app: Pick<AppSummary, "status" | "needsApproval">): { key: InstalledAppsMessageKey; variant: BadgeVariant } {
  if (app.needsApproval) return { key: "status_needsApproval", variant: "warning" };
  switch (app.status) {
    case "active":
      return { key: "status_active", variant: "success" };
    case "failed":
      return { key: "status_failed", variant: "destructive" };
    case "disabled":
      return { key: "status_disabled", variant: "secondary" };
    default:
      return { key: "status_installed", variant: "secondary" };
  }
}

export function AppStatusBadge({ app }: { app: Pick<AppSummary, "status" | "needsApproval"> }) {
  const t = useMessages(installedAppsMessages);
  const { key, variant } = appStatus(app);
  return <Badge variant={variant}>{t(key)}</Badge>;
}

export const RISK_VARIANT: Record<AppDetail["scopes"][number]["risk"], BadgeVariant> = {
  read: "secondary",
  write: "info",
  destructive: "destructive",
  financial: "warning",
};

export const LOG_LEVEL_VARIANT: Record<AppLogLine["level"], BadgeVariant> = {
  debug: "secondary",
  info: "info",
  warn: "warning",
  error: "destructive",
};

/**
 * What the app asks for beyond its approved grant: how many permissions,
 * and whether all of them are blockings the store turned off itself (each a
 * function it still runs, only no longer allowed to stop checkout).
 */
export function pendingApproval(app: Pick<AppDetail, "added" | "granted">): { count: number; blockingOff: string[] | null } {
  if (!app.granted) return { count: 0, blockingOff: null };
  let count = 0;
  let others = 0;
  for (const [dimension, value] of Object.entries(app.added) as Array<[string, unknown]>) {
    const size = Array.isArray(value) ? value.length : value === true ? 1 : 0;
    count += size;
    if (dimension !== "blockingFunctions") others += size;
  }
  const blocking = app.added.blockingFunctions;
  const turnedOff = others === 0 && blocking.length > 0 && blocking.every((point) => app.granted!.functions.includes(point));
  return { count, blockingOff: turnedOff ? [...blocking] : null };
}
