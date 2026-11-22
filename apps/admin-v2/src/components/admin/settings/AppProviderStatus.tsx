// An installed app's provider inside a settings dialog, beside the built-in
// ones: its mark and "by <app>", the same readiness every send or lookup
// checks, the link to its setup on its feature's page in the app (its own fields, kept
// encrypted with the app), and the app's connection test.
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
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
import { formatDateTime, useMessages } from "~/i18n";
import { appProvidersMessages } from "~/i18n/settings-app-providers";
import { providerLabel, providerSetupReason } from "~/i18n/provider-copy";
import { queryKeys } from "~/lib/query-keys";
import { useCommand } from "~/lib/use-command";

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
export function appProviderState(provider: { readiness: { usable: boolean }; connection: Pick<AppProvider["connection"], "status"> }): "ready" | "untested" | "testFailed" | "notReady" {
  if (!provider.readiness.usable) return "notReady";
  if (provider.connection.status === "failed") return "testFailed";
  return provider.connection.status === "untested" ? "untested" : "ready";
}

const STATE_VARIANT = { ready: "success", untested: "attention", testFailed: "destructive", notReady: "warning" } as const;
const STATE_LABEL = { ready: "ready", untested: "untested", testFailed: "connectionFailed", notReady: "notReady" } as const;

/**
 * `onTested`: what else reads this provider's stored test (the couriers list
 * reads it into each courier's readiness) and must refetch after a test.
 */
export function AppProviderStatus({ provider, onTested }: { provider: AppProvider; onTested?: () => Promise<unknown> | void }) {
  const t = useMessages(appProvidersMessages);
  const queryClient = useQueryClient();
  // Tested with whatever tests the port's built-in providers.
  const { canManage } = useProviderPortAccess(provider.kind);
  const test = useCommand({
    mutationFn: () => apiData(postApiV1AdminSettingsProvidersByIdTest({ path: { id: provider.id } })),
    // The outcome is kept, passed or failed: every list that reads it refetches.
    onSettled: () => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.appProviders(provider.kind) }),
      onTested?.(),
    ]),
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
            {/* A test can take the provider's whole deadline: say it is running, not the stale state. */}
            {test.isPending ? <Badge variant="info">{t("testing")}</Badge> : <Badge variant={STATE_VARIANT[state]}>{t(STATE_LABEL[state])}</Badge>}
            <ProvidedByChip pluginId={provider.pluginId} appName={provider.appName} />
          </div>
        </div>
      </div>
      {!usable && provider.readiness.blockedReason ? <Alert variant="warning">{providerSetupReason(provider.readiness.blockedReason)}</Alert> : null}
      <div className="flex flex-wrap items-center gap-2">
        <AppProviderSetupButton provider={provider} />
        {provider.canTestConnection && canManage ? (
          // Stays in place, labelled, while the test runs (not a bare spinner).
          <Button type="button" variant="outline" disabled={!usable || test.isPending} aria-busy={test.isPending || undefined} onClick={() => test.mutate()}>
            {test.isPending ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
            {t(test.isPending ? "testing" : "testConnection")}
          </Button>
        ) : null}
      </div>
      <AppProviderConnectionNote
        provider={provider}
        testing={test.isPending}
        answer={test.isPending ? null : test.data ?? (test.isError ? "error" : null)}
      />
    </div>
  );
}

/**
 * What a provider's connection test said, wherever the provider is shown (its
 * settings dialog, a payment method row): the answer of a test just run, else
 * the stored outcome. A failed test's answer (the app's own, merchant-safe) is
 * kept across reloads until a test passes or its settings change, with what to
 * do next (nothing to fix when no answer came back in time) and when it was
 * last tested.
 */
export function AppProviderConnectionNote({ provider, answer, testing = false }: {
  provider: Pick<AppProvider, "name" | "connection" | "canTestConnection"> & { readiness: { usable: boolean } };
  /** A test run on this page: its answer, or "error" when it couldn't run. */
  answer: { ok: boolean; message: string; timedOut?: boolean } | "error" | null;
  /** A test is running now: only that is said. */
  testing?: boolean;
}) {
  const t = useMessages(appProvidersMessages);
  const state = appProviderState(provider);
  if (testing) return <p role="status" className="text-body text-muted-foreground">{t("testingHelp", { name: providerLabel(provider.name) })}</p>;
  // The answer just given decides, else the stored one.
  const timedOut = answer && answer !== "error" ? !answer.ok && answer.timedOut === true : provider.connection.timedOut === true;
  const testedAt = provider.connection.testedAt
    ? formatDateTime(new Date(provider.connection.testedAt), { dateStyle: "medium", timeStyle: "short" })
    : null;
  return (
    <>
      {answer === "error" ? (
        <p role="status" className="text-body text-destructive">{t("testFailed")}</p>
      ) : answer ? (
        <p role="status" className={answer.ok ? "text-body text-success" : "text-body text-destructive wrap-anywhere"}>{answer.message}</p>
      ) : state === "untested" && provider.canTestConnection ? (
        <p className="text-body text-muted-foreground">{t("untestedHelp")}</p>
      ) : state === "testFailed" ? (
        <p className="text-body text-destructive wrap-anywhere">{provider.connection.message ?? t("connectionFailed")}</p>
      ) : null}
      {state === "testFailed" ? <p className="text-body text-muted-foreground">{t(timedOut ? "timedOutHelp" : "testFailedHelp", { name: providerLabel(provider.name) })}</p> : null}
      {testedAt && (state === "ready" || state === "testFailed") ? (
        <p className="text-body text-muted-foreground">{t("lastTested", { time: testedAt })}</p>
      ) : null}
    </>
  );
}
