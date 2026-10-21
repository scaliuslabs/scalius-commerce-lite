// What the app page adds for the app lifecycle, loaded after the page: the
// emergency Stop now, the reason an app is stopped, an update from its
// registry, and the facts about who signed it and what it may use. Nothing
// here runs the app's code; every value comes from the API's description.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useMessages, formatNumber } from "~/i18n";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { appErrorCode, isAppChangedError, type AppDetail } from "~/lib/api-query-options/apps";
import { appRegistryQueryOptions, stopApp, updateRegistryApp } from "~/lib/api-query-options/apps-lifecycle";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { formatFileSize } from "../media-manager/utils/formatters";
import { Fact } from "./AppListingParts";
import { ThemeAppFallbackNotice } from "./ThemeAppParts";
import { pluginKeyFingerprint } from "@scalius/shared/plugins/registry";

function useRefreshApps() {
  const queryClient = useQueryClient();
  return (next: AppDetail | null) => {
    if (next) queryClient.setQueryData(queryKeys.apps.detail(next.id), next);
    void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
    // Stopping and updating change which pages, cards, actions and widgets show.
    void queryClient.invalidateQueries({ queryKey: queryKeys.apps.surfaces() });
  };
}

/** "Stop now": the emergency switch for this one app, with its confirmation. */
export function AppStopAction({ app }: { app: AppDetail }) {
  const t = useMessages(appsLifecycleMessages);
  const refresh = useRefreshApps();
  const [open, setOpen] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopApp(app.id),
    onSuccess: ({ app: next }) => {
      refresh(next);
      toast.success(t("stopped"));
      setOpen(false);
    },
    onError: () => {
      toast.error(t("stopFailed"));
      setOpen(false);
    },
  });
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>{t("stopNow")}</Button>
      <AlertDialog open={open} onOpenChange={(next) => (stop.isPending ? undefined : setOpen(next))}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("stopTitle", { name: app.name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("stopBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <ThemeAppFallbackNotice name={app.name} usage={app.themeUsage} action="deactivate" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={stop.isPending}>{t("cancel")}</AlertDialogCancel>
            <Button type="button" variant="destructive" loading={stop.isPending} onClick={() => stop.mutate()}>
              {t("stopNow")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** A newer version in a registry, and the Update button. An update that asks for more access waits for approval. */
function UpdateNotice({ app }: { app: AppDetail }) {
  const t = useMessages(appsLifecycleMessages);
  const refresh = useRefreshApps();
  const queryClient = useQueryClient();
  const { data } = useQuery(appRegistryQueryOptions());
  const [undone, setUndone] = useState<string | null>(null);
  const listed = data?.apps.find((entry) => entry.id === app.id && entry.updateAvailable) ?? null;
  const update = useMutation({
    mutationFn: () => updateRegistryApp(app, listed!.registryId, listed!.version),
    onSuccess: ({ app: next, rolledBack, error }) => {
      refresh(next);
      void queryClient.invalidateQueries({ queryKey: ["apps", "registry"] });
      if (rolledBack) {
        setUndone(error ?? "");
        return;
      }
      setUndone(null);
      toast.success(t(next.needsApproval ? "updatedNeedsApproval" : "updated"));
    },
    onError: (error) => {
      if (isAppChangedError(error)) {
        toast.error(t("updateChanged"));
        void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(app.id) });
        return;
      }
      const code = appErrorCode(error);
      toast.error(
        code === "installation_sandbox_required" ? t("sandboxRequired")
          : code === "signature_untrusted" ? t("updateUntrusted")
            : code === "signature_signer_changed" ? t("signerChanged")
              : code === "signature_invalid" || code === "signature_missing" || code === "package_invalid" ? t("updateUnverified")
                : t("updateFailed"),
      );
    },
  });
  return (
    <>
      {undone !== null ? (
        <Alert variant="destructive">
          <AlertDescription>{undone ? t("updateUndone", { error: undone }) : t("updateUndoneNoReason")}</AlertDescription>
        </Alert>
      ) : null}
      {listed ? (
        <Alert variant="info">
          <AlertTitle>{t("updateAvailableTitle", { version: listed.version })}</AlertTitle>
          <AlertDescription>
            <p>{t("updateAvailableBody", { current: app.version })}</p>
            <Button type="button" size="sm" loading={update.isPending} onClick={() => update.mutate()}>
              {t("updateTo", { version: listed.version })}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
    </>
  );
}

/**
 * Above the tabs: why the app is stopped (a Super Admin starts it again with
 * the page's Review and activate), and an update from a registry for staff
 * who manage apps. Bundled apps update with a deploy, so they offer none.
 */
export function AppLifecycleNotices({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const t = useMessages(appsLifecycleMessages);
  const stopped = app.status === "disabled" && app.failureReason;
  return (
    <>
      {stopped ? (
        <Alert variant="warning">
          <AlertTitle>{t("stoppedTitle")}</AlertTitle>
          <AlertDescription>
            <p className="break-words">{app.failureReason}</p>
            <p>{t("stoppedHowToStart")}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {canManage && app.source !== "bundled" ? <UpdateNotice app={app} /> : null}
    </>
  );
}

/** Facts for the Overview: who signed the code, and (for sandboxed apps) its storage, per-run limits and data updates. */
export function AppRunFacts({ app }: { app: AppDetail }) {
  const t = useMessages(appsLifecycleMessages);
  const { signer } = app;
  const sandboxed = app.runtime === "sandbox";
  const newest = Math.max(0, ...app.migrations.declared.map((migration) => migration.version));
  const used = app.storageUsage;
  const limits = app.limits;
  return (
    <>
      {signer ? (
        <Fact label={t("factSignature")}>
          <span className="flex flex-col gap-0.5">
            <span>{signer.official ? t("developerOfficial") : signer.name ? t("developerVerified", { name: signer.name }) : t("developerUnknown")}</span>
            <span className="font-mono text-muted-foreground">{t("signerFingerprint", { fingerprint: pluginKeyFingerprint(signer.keyId) })}</span>
          </span>
        </Fact>
      ) : app.source === "upload" ? (
        <Fact label={t("factSignature")}>{t("unsignedUpload")}</Fact>
      ) : null}
      {sandboxed ? (
        <>
          <Fact label={t("factStorage")}>
            {used.measuredAt
              ? t("storageUsed", { used: formatFileSize(used.bytes), limit: formatFileSize(limits.storageBytes) })
              : t("storageNotMeasured", { limit: formatFileSize(limits.storageBytes) })}
          </Fact>
          <Fact label={t("factRunLimits")}>
            {t("runLimits", {
              cpu: limits.cpuMs,
              seconds: formatNumber(limits.wallMs / 1000, { maximumFractionDigits: 1 }),
              subrequests: limits.subrequests,
              perMinute: limits.invocationsPerMinute,
            })}
          </Fact>
          {newest > 0 ? (
            <Fact label={t("factDataUpdates")}>
              {app.migrations.applied > 0 ? t("dataUpdates", { applied: app.migrations.applied, newest }) : t("dataUpdatesNone", { newest })}
            </Fact>
          ) : null}
        </>
      ) : null}
    </>
  );
}
