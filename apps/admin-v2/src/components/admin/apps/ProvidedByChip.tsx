// "Provided by <app>" (Polaris: an app's mark on what it contributes): a
// small chip on a settings section, provider or page an app adds, linking to
// the app. Plain text for staff who cannot open apps.
import { Link } from "@tanstack/react-router";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";

const CHIP = "inline-flex max-w-full items-center rounded-lg bg-secondary px-2 py-0.5 text-caption font-medium text-secondary-foreground";

/** "Provided by <app>": a small chip linking to the app (plain text without access to apps). */
export function ProvidedByChip({ pluginId, appName }: { pluginId: string; appName: string }) {
  const t = useMessages(appProvidersMessages);
  const canSeeApps = usePermissions().hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  const label = <span className="truncate">{t("providedBy", { app: appName })}</span>;
  return canSeeApps ? (
    <Link
      to="/admin/apps/$pluginId"
      params={{ pluginId }}
      className="inline-flex max-w-full items-center rounded-lg bg-secondary px-2 py-1 text-caption font-medium text-secondary-foreground outline-none hover:bg-secondary-hover focus-visible:ring-2 focus-visible:ring-ring"
    >
      {label}
    </Link>
  ) : (
    <span className={CHIP}>{label}</span>
  );
}
