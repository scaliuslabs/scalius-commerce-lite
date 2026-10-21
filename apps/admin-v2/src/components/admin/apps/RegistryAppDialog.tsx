// A registry app's listing and the way to install it. With one-click install
// (Workers Paid) the Install button downloads, verifies and installs it, then
// opens its page, where the usual access review turns it on. Without it, the
// operator's command, then a deploy. The developer line says whether this
// store trusts who signed the release.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { appsLifecycleMessages } from "~/i18n/apps-lifecycle";
import { appErrorCode } from "~/lib/api-query-options/apps";
import { installRegistryApp, type RegistryApp } from "~/lib/api-query-options/apps-lifecycle";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { AppIcon } from "./AppIcon";
import { pluginKeyFingerprint } from "@scalius/shared/plugins/registry";

interface RegistryAppDialogProps {
  /** The last app opened stays while the dialog closes. */
  app: RegistryApp | null;
  installMode: "dashboard" | "command";
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RegistryAppDialog({ app, installMode, open, onOpenChange }: RegistryAppDialogProps) {
  const t = useMessages(appsLifecycleMessages);
  const main = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const install = useMutation({
    mutationFn: () => installRegistryApp(app!),
    onSuccess: async ({ app: installed }) => {
      queryClient.setQueryData(queryKeys.apps.detail(installed.id), installed);
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.surfaces() });
      void queryClient.invalidateQueries({ queryKey: ["apps", "registry"] });
      toast.success(t("registryInstalled"));
      onOpenChange(false);
      await navigate({ to: "/admin/apps/$pluginId", params: { pluginId: installed.id } });
    },
    onError: (error) => {
      const code = appErrorCode(error);
      toast.error(
        code === "installation_sandbox_required" ? t("sandboxRequired")
          : code === "installation_exists" ? t("installExists")
            : code === "retained_data_other_developer" ? t("retainedDataOtherDeveloper")
              : code === "signature_untrusted" || code === "signature_invalid" || code === "signature_missing" || code === "package_invalid" ? t("installUnverified")
                : t("installFailed"),
      );
    },
  });

  const copy = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("commandCopied"));
    } catch {
      // The command stays selectable in the box.
    }
  };

  const trusted = app?.signer.trusted ?? false;
  return (
    <Dialog open={open} onOpenChange={(next) => (install.isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-160">
        {app ? (
          <>
            <DialogHeader>
              <div className="flex items-center gap-3">
                <AppIcon src={null} size="lg" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <DialogTitle>{main("installTitle", { name: app.name })}</DialogTitle>
                  <DialogDescription>{main("byAuthor", { author: app.author })}</DialogDescription>
                </div>
              </div>
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {app.tagline ? <p className="text-body font-medium">{app.tagline}</p> : null}
              {app.description ? <p className="whitespace-pre-wrap break-words text-body">{app.description}</p> : null}
              <p className="text-body">
                <span className="text-muted-foreground">{main("version")}: </span>
                <span className="font-mono">{app.version}</span>
              </p>
              <div className="flex flex-col gap-0.5">
                <p className="text-body font-medium">{app.signer.official ? t("developerOfficial") : trusted ? t("developerVerified", { name: app.signer.name ?? "" }) : t("developerUnknown")}</p>
                <p className="font-mono text-body text-muted-foreground">{t("signerFingerprint", { fingerprint: pluginKeyFingerprint(app.signer.keyId) })}</p>
              </div>
              {trusted ? null : (
                <Alert variant="warning">
                  <AlertDescription>{t("unknownDeveloperWarning")}</AlertDescription>
                </Alert>
              )}
              {app.compatible ? null : (
                <Alert variant="warning">
                  <AlertDescription>
                    <p className="font-medium">{t("needsNewerScalius")}</p>
                    {app.incompatibleReason ? <p>{app.incompatibleReason}</p> : null}
                  </AlertDescription>
                </Alert>
              )}
              {app.compatible && installMode === "dashboard" ? <p className="text-body text-muted-foreground">{t("registryInstallIntro")}</p> : null}
              {app.compatible && installMode === "command" ? (
                <div className="flex flex-col gap-2 border-t pt-4">
                  <p className="text-body">{t("commandIntro")}</p>
                  <pre className="overflow-x-auto rounded-lg bg-muted px-3 py-2"><code>{app.installCommand}</code></pre>
                  <p className="text-body text-muted-foreground">{t("thenDeploy")}</p>
                </div>
              ) : null}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={install.isPending} onClick={() => onOpenChange(false)}>
                {main(installMode === "command" || !app.compatible ? "done" : "cancel")}
              </Button>
              {app.compatible && installMode === "command" ? (
                <Button type="button" onClick={() => void copy(app.installCommand)}>
                  {t("copyCommand")}
                </Button>
              ) : null}
              {app.compatible && installMode === "dashboard" ? (
                <Button type="button" loading={install.isPending} disabled={!trusted} onClick={() => install.mutate()}>
                  {t("registryInstall")}
                </Button>
              ) : null}
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
