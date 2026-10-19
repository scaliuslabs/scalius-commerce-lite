// An installed app's provider inside a settings dialog, beside the built-in
// ones: its mark and "by <app>", the same readiness every send or lookup
// checks, the link to its setup on its feature's page in the app (its own fields, kept
// encrypted with the app), and the app's connection test.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postApiV1AdminSettingsProvidersByIdTest } from "@scalius/api-client/sdk";
import { AppIcon } from "~/components/admin/apps/AppIcon";
import { ProvidedByChip } from "~/components/admin/apps/ProvidedByChip";
import { Link } from "@tanstack/react-router";
import { appProviderSetupPath } from "~/components/admin/apps/app-sections";
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
import { queryKeys } from "~/lib/query-keys";

export { ProvidedByChip };

type AppProvidersMessage = keyof (typeof appProvidersMessages)["en"];

/** An app provider as a choice beside the built-in ones, under an "Apps" heading. */
export function appProviderOption(provider: AppProvider, t: (key: AppProvidersMessage, vars?: Record<string, string>) => string) {
  return { value: provider.id, label: providerLabel(provider.name), description: t("byApp", { app: providerLabel(provider.appName) }), group: t("apps") };
}

/**
 * The link to a provider's setup: its feature's page in its app (the switch,
 * consent and its own fields). "Set up" until it is configured, then "Edit settings".
 */
export function AppProviderSetupButton({ provider, size = "default" }: { provider: AppProvider; size?: "default" | "sm" }) {
  const t = useMessages(appProvidersMessages);
  // The app page reads the app's settings (apps.view); saving them is the app's (apps.manage).
  const canSeeApps = usePermissions().hasPermission(ADMIN_PERMISSIONS.APPS_VIEW);
  if (!canSeeApps) return null;
  const configured = provider.readiness.configured;
  return (
    <Button asChild variant={configured ? "outline" : "default"} size={size}>
      <Link to={appProviderSetupPath(provider.id)}>{t(configured ? "editSettings" : "setUp", { name: providerLabel(provider.name) })}</Link>
    </Button>
  );
}

/**
 * A provider's status in one word: "Ready" only when it can be used and, for
 * one that offers a connection test, a test passed with its current keys.
 * The outcome is stored when the merchant tests; nothing here calls it.
 */
export function appProviderState(provider: Pick<AppProvider, "readiness" | "connection">): "ready" | "untested" | "testFailed" | "notReady" {
  if (!provider.readiness.usable) return "notReady";
  if (provider.connection.status === "failed") return "testFailed";
  return provider.connection.status === "untested" ? "untested" : "ready";
}

const STATE_VARIANT = { ready: "success", untested: "attention", testFailed: "destructive", notReady: "warning" } as const;
const STATE_LABEL = { ready: "ready", untested: "untested", testFailed: "connectionFailed", notReady: "notReady" } as const;

export function AppProviderStatus({ provider }: { provider: AppProvider }) {
  const t = useMessages(appProvidersMessages);
  const queryClient = useQueryClient();
  // Tested with whatever tests the port's built-in providers.
  const { canManage } = useProviderPortAccess(provider.kind);
  const test = useMutation({
    mutationFn: () => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: provider.id } })),
    // The outcome is kept: the list reads it back for the status.
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.settings.appProviders(provider.kind) }),
  });
  const usable = provider.readiness.usable;
  const state = appProviderState(provider);
  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <AppIcon src={provider.icon} size="sm" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-body font-medium">{providerLabel(provider.name)}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATE_VARIANT[state]}>{t(STATE_LABEL[state])}</Badge>
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
      ) : state === "untested" && provider.canTestConnection ? (
        <p className="text-body text-muted-foreground">{t("untestedHelp")}</p>
      ) : state === "testFailed" && provider.connection.message ? (
        <p className="text-body text-destructive wrap-anywhere">{provider.connection.message}</p>
      ) : null}
    </div>
  );
}
