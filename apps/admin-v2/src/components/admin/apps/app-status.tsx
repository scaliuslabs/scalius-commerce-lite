import { Badge, type BadgeVariant } from "~/components/ui/badge";
import { useMessages } from "~/i18n";
import { installedAppsMessages, type InstalledAppsMessageKey } from "~/i18n/apps";
import type { AppDetail, AppLogLine, AppSummary } from "~/lib/api-query-options/apps";

/** An update waiting for approval outranks the stored status: the app is paused until then. */
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
