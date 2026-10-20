// Upload an app package (the .zip `pnpm plugin pack` writes). A package signed
// by a developer this store trusts installs at once. One signed by someone new,
// or not signed at all, stops at a warning step; only a Super Admin can accept
// it. The app then opens on its page, where the usual approval turns it on.
import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { usePermissions } from "~/contexts/PermissionContext";
import { useMessages } from "~/i18n";
import { appsLifecycleMessages, type AppsLifecycleMessageKey } from "~/i18n/apps-lifecycle";
import { queryKeys } from "~/lib/query-keys";
import { toast } from "~/lib/toast";
import { appErrorCode } from "~/lib/api-query-options/apps";
import { appErrorDetails, appErrorMessage, uploadAppPackage } from "~/lib/api-query-options/apps-lifecycle";

/** The API refuses a larger package (20 MiB). */
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

/** Where the upload stands: choosing a file, or stopped at a warning that a Super Admin may accept. */
type Step = { kind: "choose" } | { kind: "untrusted"; developer: string | null } | { kind: "unsigned" };

const REFUSALS: Record<string, AppsLifecycleMessageKey> = {
  "package_invalid": "packageInvalid",
  "signature_invalid": "signatureInvalid",
  "installation_incompatible": "incompatible",
  "installation_source_conflict": "sourceConflict",
  "installation_sandbox_required": "sandboxRequired",
};

export function UploadAppDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(appsLifecycleMessages);
  const { isSuperAdmin } = usePermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [step, setStep] = useState<Step>({ kind: "choose" });
  const [problem, setProblem] = useState<{ text: string; detail: string | null } | null>(null);

  const upload = useMutation({
    mutationFn: (trust: { allowUnsigned?: boolean; trustDeveloper?: boolean }) => uploadAppPackage(file!, trust),
    onSuccess: async ({ app, updated, rolledBack, error }) => {
      queryClient.setQueryData(queryKeys.apps.detail(app.id), app);
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.apps.surfaces() });
      if (rolledBack) toast.error(t("updateUndone", { error: error ?? "" }), { duration: 10000 });
      else if (app.needsApproval) toast.success(t("updatedNeedsApproval"));
      else toast.success(t(updated ? "uploadUpdated" : "uploadInstalled"));
      reset();
      onOpenChange(false);
      await navigate({ to: "/admin/apps/$pluginId", params: { pluginId: app.id } });
    },
    onError: (error) => {
      const { code, developer } = appErrorDetails(error);
      if (code === "signature_untrusted") {
        setProblem(null);
        setStep({ kind: "untrusted", developer });
        return;
      }
      if (code === "signature_missing") {
        setProblem(null);
        setStep({ kind: "unsigned" });
        return;
      }
      const known = (appErrorCode(error) && REFUSALS[appErrorCode(error)!]) || null;
      setProblem({ text: t(known ?? "uploadFailed"), detail: known === "packageInvalid" ? appErrorMessage(error) : null });
    },
  });

  const reset = () => {
    setFile(null);
    setStep({ kind: "choose" });
    setProblem(null);
  };
  const changeOpen = (next: boolean) => {
    if (upload.isPending) return;
    if (!next) reset();
    onOpenChange(next);
  };
  const choose = (chosen: File | undefined) => {
    if (!chosen) return;
    setStep({ kind: "choose" });
    if (!chosen.name.toLowerCase().endsWith(".zip")) {
      setFile(null);
      setProblem({ text: t("fileNotZip"), detail: null });
    } else if (chosen.size > MAX_PACKAGE_BYTES) {
      setFile(null);
      setProblem({ text: t("fileTooBig"), detail: null });
    } else {
      setFile(chosen);
      setProblem(null);
    }
  };

  let warning: { title: string; body: string; ask: string; action: string; trust: { allowUnsigned?: boolean; trustDeveloper?: boolean } } | null = null;
  if (step.kind === "untrusted") {
    warning = {
      title: t("untrustedTitle"),
      body: step.developer ? t("untrustedBody", { developer: step.developer }) : t("untrustedBodyNoName"),
      ask: t("askForTrust"),
      action: t("trustAndInstall"),
      trust: { trustDeveloper: true },
    };
  } else if (step.kind === "unsigned") {
    warning = { title: t("unsignedTitle"), body: t("unsignedBody"), ask: t("askForUnsigned"), action: t("installUnsigned"), trust: { allowUnsigned: true } };
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("uploadTitle")}</DialogTitle>
          <DialogDescription>{t("uploadBody")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="sr-only"
            aria-label={t("chooseFile")}
            onChange={(event) => {
              choose(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
          <Button type="button" variant="outline" disabled={upload.isPending} onClick={() => inputRef.current?.click()}>
            {file ? t("replaceFile") : t("chooseFile")}
          </Button>
          <span className="min-w-0 flex-1 truncate text-body text-muted-foreground">{file ? file.name : t("noFileChosen")}</span>
        </div>
        {problem ? (
          <div role="alert" className="space-y-1 text-body text-destructive">
            <p>{problem.text}</p>
            {problem.detail ? <p className="break-words">{problem.detail}</p> : null}
          </div>
        ) : null}
        {warning ? (
          <Alert variant="warning">
            <AlertTitle>{warning.title}</AlertTitle>
            <AlertDescription>
              <p>{warning.body}</p>
              {isSuperAdmin ? null : <p>{warning.ask}</p>}
            </AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={upload.isPending} onClick={() => changeOpen(false)}>{t("cancel")}</Button>
          {warning ? (
            isSuperAdmin ? (
              <Button type="button" variant="destructive" loading={upload.isPending} onClick={() => upload.mutate(warning.trust)}>
                {warning.action}
              </Button>
            ) : null
          ) : (
            <Button type="button" loading={upload.isPending} disabled={!file} onClick={() => upload.mutate({})}>
              {t("upload")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
