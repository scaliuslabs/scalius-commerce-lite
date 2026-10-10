// An installed app's provider inside a settings dialog, beside the built-in
// ones: its mark and "by <app>", the same readiness every send or lookup
// checks, the button that opens its setup sheet (only its own fields, kept
// encrypted with the app), and the app's connection test.
import { useMutation } from "@tanstack/react-query";
import { postApiV1AdminSettingsProvidersByIdTest } from "@scalius/api-client/sdk";
import { AppIcon } from "~/components/admin/apps/AppIcon";
import { ProvidedByChip } from "~/components/admin/apps/ProvidedByChip";
import { useOpenAppProvider } from "~/components/admin/apps/AppProviderSheetHost";
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
import { providerLabel, providerSetupReason } from "~/i18n/provider-copy";

export { ProvidedByChip };

type AppProvidersMessage = keyof (typeof appProvidersMessages)["en"];

/** An app provider as a choice beside the built-in ones, under an "Apps" heading. */
export function appProviderOption(provider: AppProvider, t: (key: AppProvidersMessage, vars?: Record<string, string>) => string) {
  return { value: provider.id, label: providerLabel(provider.name), description: t("byApp", { app: providerLabel(provider.appName) }), group: t("apps") };
}

/** The button that opens a provider's setup sheet: "Set up" until it is configured, then "Edit settings". */
export function AppProviderSetupButton({ provider, size = "default" }: { provider: AppProvider; size?: "default" | "sm" }) {
  const t = useMessages(appProvidersMessages);
  const openProvider = useOpenAppProvider();
  // The sheet reads the app's settings (apps.view); saving them is the app's (apps.manage).
  const canSeeApps = usePermissions().hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  if (!canSeeApps || !openProvider) return null;
  const configured = provider.readiness.configured;
  return (
    <Button type="button" variant={configured ? "outline" : "default"} size={size} onClick={() => openProvider(provider.id)}>
      {t(configured ? "editSettings" : "setUp", { name: providerLabel(provider.name) })}
    </Button>
  );
}

export function AppProviderStatus({ provider }: { provider: AppProvider }) {
  const t = useMessages(appProvidersMessages);
  // Tested with whatever tests the port's built-in providers.
  const { canManage } = useProviderPortAccess(provider.kind);
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: provider.id } })),
  });
  const usable = provider.readiness.usable;
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <AppIcon src={provider.icon} size="sm" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body font-medium">{providerLabel(provider.name)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={usable ? "success" : "warning"}>{usable ? t("ready") : t("notReady")}</Badge>
            <ProvidedByChip pluginId={provider.pluginId} appName={provider.appName} />
          </div>
        </div>
      </div>
      {!usable && provider.readiness.blockedReason ? <Alert variant="warning">{providerSetupReason(provider.readiness.blockedReason)}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <AppProviderSetupButton provider={provider} />
        {provider.canTestConnection && canManage ? (
          <Button type="button" variant="outline" loading={test.isPending} disabled={!usable} onClick={() => test.mutate()}>
            {t("testConnection")}
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
