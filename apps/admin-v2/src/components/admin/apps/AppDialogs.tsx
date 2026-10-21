// The app lifecycle dialogs. Activation is a Super Admin's consent: the
// dialog lists exactly the access the API reported and sends back its grant
// key with the revision, so a request that changed meanwhile is refused and
// shown again. Deactivate and uninstall are guarded by the revision too, and
// both list the published theme's parts the app draws, which then show the
// store's own design.
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";
import { toast } from "~/lib/toast";
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
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import {
  activateApp,
  appErrorCode,
  deactivateApp,
  isAppChangedError,
  uninstallApp,
  type AppDetail,
} from "~/lib/api-query-options/apps";
import { queryKeys } from "~/lib/query-keys";
import { AppAccess } from "./AppAccess";
import { ThemeAppFallbackNotice } from "./ThemeAppParts";

interface DialogProps {
  app: AppDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Shared outcome handling: the fresh app, the list, and an app hook that failed without stopping the change. */
export function useAppMutationResult(app: Pick<AppDetail, "id" | "name">) {
  const t = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  return {
    applied(next: AppDetail | null, hookError: string | null, message: string) {
      if (next) queryClient.setQueryData(queryKeys.apps.detail(app.id), next);
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
      // Activation, deactivation and removal change which pages, cards, actions and widgets show.
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.surfaces() });
      queryClient.removeQueries({ queryKey: queryKeys.apps.document(app.id) });
      toast.success(message);
      if (hookError) toast.warning(t("hookFailed", { name: app.name }), { description: hookError, duration: 10000 });
    },
    /** True when the app changed after the page loaded it: it reloads and says so. */
    changed(error: unknown): boolean {
      if (!isAppChangedError(error)) return false;
      toast.error(t("changedReview"));
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(app.id) });
      return true;
    },
  };
}

export function ActivateAppDialog({ app, open, onOpenChange }: DialogProps) {
  const t = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  const result = useAppMutationResult(app);
  const update = app.needsApproval;
  const activate = useMutation({
    mutationFn: () => activateApp(app),
    onSuccess: ({ app: next, hookError }) => {
      result.applied(next, hookError, t(update ? "approved" : "activated"));
      onOpenChange(false);
    },
    onError: (error) => {
      // Changed meanwhile: the dialog stays open on the fresh request to review again.
      if (result.changed(error)) return;
      if (appErrorCode(error) === "installation_settings_incomplete") {
        toast.error(t("settingsIncomplete"));
        void queryClient.invalidateQueries({ queryKey: queryKeys.apps.detail(app.id) });
        return;
      }
      toast.error(t("activateFailed"));
    },
  });
  const missing = app.settings.fields.filter((field) => app.settings.missing.includes(field.key));
  return (
    <Dialog open={open} onOpenChange={(next) => (activate.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-160">
        <DialogHeader>
          <DialogTitle>{t(update ? "approveTitle" : "activateTitle", { name: app.name })}</DialogTitle>
          <DialogDescription>{t(update ? "approveIntro" : "activateIntro", { name: app.name })}</DialogDescription>
        </DialogHeader>
        {/* A bundled app that isn't first-party runs in the store's own Workers, with no sandbox. */}
        {app.runtime === "bundled" && app.thirdParty ? (
          <Alert variant="info">
            <AlertDescription>{t("trustedCode")}</AlertDescription>
          </Alert>
        ) : null}
        <AppAccess app={app} consent={<p className="text-body">{t("consentWarning", { name: app.name })}</p>} />
        {missing.length > 0 ? (
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{t("missingTitle")}</AlertTitle>
            <AlertDescription>{t("missingBody", { settings: missing.map((field) => field.label).join(", ") })}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={activate.isPending} onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button
            type="button"
            loading={activate.isPending}
            disabled={missing.length > 0 || !app.runtimeAvailable}
            onClick={() => activate.mutate()}
          >
            {t(update ? "approve" : "activate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeactivateAppDialog({ app, open, onOpenChange }: DialogProps) {
  const t = useMessages(installedAppsMessages);
  const result = useAppMutationResult(app);
  const deactivate = useMutation({
    mutationFn: () => deactivateApp(app),
    onSuccess: ({ app: next, hookError }) => {
      result.applied(next, hookError, t("deactivated"));
      onOpenChange(false);
    },
    onError: (error) => {
      if (!result.changed(error)) toast.error(t("deactivateFailed"));
      onOpenChange(false);
    },
  });
  return (
    <AlertDialog open={open} onOpenChange={(next) => (deactivate.isPending ? undefined : onOpenChange(next))}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deactivateTitle", { name: app.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t("deactivateBody", { name: app.name })}</AlertDialogDescription>
        </AlertDialogHeader>
        <ThemeAppFallbackNotice name={app.name} usage={app.themeUsage} action="deactivate" />
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deactivate.isPending}>{t("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={deactivate.isPending} onClick={() => deactivate.mutate()}>
            {t("deactivate")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function UninstallAppDialog({ app, open, onOpenChange }: DialogProps) {
  const t = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const result = useAppMutationResult(app);
  const [keepData, setKeepData] = useState(true);
  const uninstall = useMutation({
    mutationFn: () => uninstallApp(app, keepData),
    onSuccess: async ({ hookError }) => {
      result.applied(null, hookError, t("uninstalled"));
      onOpenChange(false);
      await navigate({ to: "/admin/apps" });
      queryClient.removeQueries({ queryKey: queryKeys.apps.detail(app.id) });
    },
    onError: (error) => {
      if (!result.changed(error)) toast.error(t("uninstallFailed"));
      onOpenChange(false);
    },
  });
  const changeOpen = (next: boolean) => {
    if (uninstall.isPending) return;
    // Each opening starts on the safe choice.
    if (!next) setKeepData(true);
    onOpenChange(next);
  };
  const choices = [
    { value: "keep", label: t("keepData"), help: t("keepDataHelp") },
    { value: "delete", label: t("deleteData"), help: t("deleteDataHelp") },
  ];
  return (
    <AlertDialog open={open} onOpenChange={changeOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("uninstallTitle", { name: app.name })}</AlertDialogTitle>
          <AlertDialogDescription>
            {app.runtime === "bundled" ? t("uninstallBundled", { name: app.name }) : t("uninstallBody", { name: app.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ThemeAppFallbackNotice name={app.name} usage={app.themeUsage} action="uninstall" />
        <RadioGroup
          aria-label={t("dataChoice")}
          value={keepData ? "keep" : "delete"}
          disabled={uninstall.isPending}
          onValueChange={(value) => setKeepData(value === "keep")}
        >
          {choices.map((choice) => (
            <label key={choice.value} className="flex min-h-11 items-start gap-2 py-1 text-body">
              <span className="flex h-lh items-center">
                <RadioGroupItem value={choice.value} />
              </span>
              <span>
                <span className="block font-medium">{choice.label}</span>
                <span className="block text-muted-foreground">{choice.help}</span>
              </span>
            </label>
          ))}
        </RadioGroup>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={uninstall.isPending}>{t("cancel")}</AlertDialogCancel>
          <Button type="button" variant="destructive" loading={uninstall.isPending} onClick={() => uninstall.mutate()}>
            {t("uninstall")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
