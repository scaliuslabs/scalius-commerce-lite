// The Apps page's lifecycle controls, loaded after the list: Upload app, the
// overflow menu (Stop all third-party apps, Registries and trusted
// developers) and the notice for apps that are stopped. The upload and
// registry dialogs load the first time they open.
import { lazy, Suspense, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "~/components/ui/dropdown-menu";
import { usePermissions } from "~/contexts/PermissionContext";
import { useOpenedOnce } from "~/hooks/use-opened-once";
import { useLocale, useMessages } from "~/i18n";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { resourceMessages } from "~/i18n/resource";
import { ADMIN_PERMISSIONS } from "~/lib/admin-permissions";
import type { AppSummary } from "~/lib/api-query-options/apps";
import { stopThirdPartyApps } from "~/lib/api-query-options/apps-lifecycle";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { localizedApp } from "./app-text";

const UploadAppDialog = lazy(() => import("./UploadAppDialog").then((module) => ({ default: module.UploadAppDialog })));
const RegistrySettingsDialog = lazy(() => import("./RegistrySettingsDialog").then((module) => ({ default: module.RegistrySettingsDialog })));

type DialogName = "upload" | "stop" | "registries" | null;

function StopAllDialog({ count, open, onOpenChange }: { count: number; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(appsLifecycleMessages);
  const queryClient = useQueryClient();
  const stop = useMutation({
    mutationFn: stopThirdPartyApps,
    onSuccess: ({ stopped }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.all });
      toast.success(stopped.length > 0 ? t("stopAllDone", { count: stopped.length }) : t("stopAllNone"));
      onOpenChange(false);
    },
    onError: () => {
      toast.error(t("stopAllFailed"));
      onOpenChange(false);
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={(next) => (stop.isPending ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("stopAllTitle", { count })}</AlertDialogTitle>
          <AlertDialogDescription>{t("stopAllBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={stop.isPending}>{t("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={stop.isPending} onClick={() => stop.mutate()}>
            {t("stopAllConfirm")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Buttons for the page header. `sandboxAvailable`: the store can install from the dashboard (a package upload). */
export function AppsToolbar({ apps, sandboxAvailable }: { apps: AppSummary[]; sandboxAvailable: boolean }) {
  const t = useMessages(appsLifecycleMessages);
  const r = useMessages(resourceMessages);
  const { hasPermission } = usePermissions();
  const canManage = hasPermission(ADMIN_PERMISSIONS.APPS_MANAGE);
  const [dialog, setDialog] = useState<DialogName>(null);
  const uploadLoaded = useOpenedOnce(dialog === "upload");
  const registriesLoaded = useOpenedOnce(dialog === "registries");
  const running = apps.filter((app) => app.thirdParty && app.status === "active").length;
  const closeDialog = (open: boolean) => {
    if (!open) setDialog(null);
  };
  return (
    <>
      {canManage && sandboxAvailable ? (
        <Button type="button" variant="outline" onClick={() => setDialog("upload")}>{t("uploadApp")}</Button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="outline">
            {r("moreActions")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {canManage && running > 0 ? (
            <DropdownMenuItem variant="destructive" onSelect={() => setDialog("stop")}>{t("stopAllThirdParty")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={() => setDialog("registries")}>{t("registrySettings")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canManage ? <StopAllDialog count={running} open={dialog === "stop"} onOpenChange={closeDialog} /> : null}
      {uploadLoaded ? (
        <Suspense fallback={null}>
          <UploadAppDialog open={dialog === "upload"} onOpenChange={closeDialog} />
        </Suspense>
      ) : null}
      {registriesLoaded ? (
        <Suspense fallback={null}>
          <RegistrySettingsDialog open={dialog === "registries"} onOpenChange={closeDialog} />
        </Suspense>
      ) : null}
    </>
  );
}

/** Apps that are off with a reason (stopped by the emergency switch, or automatically for going over their limits). */
export function AppsNotices({ apps }: { apps: AppSummary[] }) {
  const t = useMessages(appsLifecycleMessages);
  const locale = useLocale();
  const stopped = apps.filter((app) => app.status === "disabled" && app.failureReason).map((app) => localizedApp(app, locale));
  if (stopped.length === 0) return null;
  return (
    <Alert variant="warning" className="mb-4">
      <AlertTitle>{t("stoppedNoticeTitle", { count: stopped.length })}</AlertTitle>
      <AlertDescription>
        <p>{t("stoppedNoticeBody")}</p>
        <ul className="space-y-1">
          {stopped.map((app) => (
            <li key={app.id}>
              <Link to="/admin/apps/$pluginId" params={{ pluginId: app.id }} className="font-medium text-link hover:underline">{app.name}</Link>
              <span className="text-muted-foreground">{` — ${app.failureReason}`}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
