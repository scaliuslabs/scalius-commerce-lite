// An installed app's provider inside a settings dialog, beside the built-in
// ones: where its keys live (the app's own settings, encrypted), the same
// readiness every send or lookup checks, and the app's connection test.
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { postApiV1AdminSettingsProvidersByIdTest } from "@scalius/api-client/sdk";
import { Alert } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { usePermissions } from "~/contexts/PermissionContext";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import { useProviderPortAccess } from "~/lib/provider-port-access";
import { apiData } from "~/lib/api";
import type { AppProvider } from "~/lib/api-query-options/settings-screens";
import { useMessages } from "~/i18n";
import { appProvidersMessages } from "~/i18n/settings-app-providers";

type AppProvidersMessage = keyof (typeof appProvidersMessages)["en"];

/** An app provider as a choice beside the built-in ones, under an "Apps" heading. */
export function appProviderOption(provider: AppProvider, t: (key: AppProvidersMessage, vars?: Record<string, string>) => string) {
  return { value: provider.id, label: provider.name, description: t("fromApp", { app: provider.appName }), group: t("apps") };
}

export function AppProviderStatus({ provider }: { provider: AppProvider }) {
  const t = useMessages(appProvidersMessages);
  const canSeeApps = usePermissions().hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  // Tested with whatever tests the port's built-in providers.
  const { canManage } = useProviderPortAccess(provider.kind);
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: provider.id } })),
  });
  const usable = provider.readiness.usable;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={usable ? "success" : "warning"}>{usable ? t("ready") : t("notReady")}</Badge>
        <span className="text-body text-muted-foreground">{t("fromApp", { app: provider.appName })}</span>
      </div>
      <p className="text-body text-muted-foreground">{t("keysInApp", { name: provider.name, app: provider.appName })}</p>
      {!usable && provider.readiness.blockedReason ? <Alert variant="warning">{provider.readiness.blockedReason}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        {provider.canTestConnection && canManage ? (
          <Button type="button" variant="outline" loading={test.isPending} disabled={!usable} onClick={() => test.mutate()}>
            {t("testConnection")}
          </Button>
        ) : null}
        {canSeeApps ? (
          <Button type="button" variant="link" asChild>
            <Link to="/admin/apps/$pluginId" params={{ pluginId: provider.pluginId }}>{t("openApp", { app: provider.appName })}</Link>
          </Button>
        ) : null}
      </div>
      {test.data ? (
        <p role="status" className={test.data.ok ? "text-body text-success" : "text-body text-destructive"}>{test.data.message}</p>
      ) : test.isError ? (
        <p role="status" className="text-body text-destructive">{t("testFailed")}</p>
      ) : null}
    </div>
  );
}
