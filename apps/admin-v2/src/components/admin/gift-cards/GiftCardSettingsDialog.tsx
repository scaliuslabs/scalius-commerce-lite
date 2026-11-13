import { useEffect, useState, type FormEvent } from "react";
import { useEditBase } from "~/hooks/use-edit-base";
import { useQuery } from "@tanstack/react-query";
import { MoneyInput } from "~/components/admin/shared/MoneyInput";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Field } from "~/components/ui/field";
import { Skeleton } from "~/components/ui/skeleton";
import { useMessages } from "~/i18n";
import { giftCardsMessages } from "~/i18n/gift-cards";
import { isAdminApiConflictError } from "~/lib/admin-api-error";
import { getServerFnError } from "~/lib/api-helpers";
import { giftCardSettingsQueryOptions } from "~/lib/api-query-options/gift-cards";
import { toast } from "~/lib/toast";
import { useSaveGiftCardSettings } from "./use-gift-card-mutations";

/**
 * Gift cards > Settings: the most one app may add to gift cards a day
 * (security audit S2). Saved under the revision it loaded.
 */
export function GiftCardSettingsDialog({ open, onOpenChange }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useMessages(giftCardsMessages);
  const settings = useQuery({ ...giftCardSettingsQueryOptions(), enabled: open });
  const mutation = useSaveGiftCardSettings();
  const [limit, setLimit] = useState<number | null>(null);
  // Typed since it opened: a live refresh then neither replaces the limit nor moves the revision it saves against.
  const [typed, setTyped] = useState(false);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const loaded = useEditBase(settings.data, typed).base;
  const reset = mutation.reset;

  useEffect(() => {
    if (!open) return;
    setFieldError(null);
    setTyped(false);
    reset();
  }, [open, reset]);
  useEffect(() => {
    if (open && loaded && !typed) setLimit(loaded.appDailyLimit);
  }, [open, loaded, typed]);

  const busy = mutation.isPending;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !loaded) return;
    if (limit === null || !Number.isFinite(limit) || limit < 0) {
      setFieldError(t("appDailyLimitRequired"));
      document.getElementById("gift-card-app-daily-limit")?.focus();
      return;
    }
    setFieldError(null);
    mutation.mutate({ appDailyLimit: limit, expectedRevision: loaded.revision }, {
      onSuccess: () => {
        toast.success(t("settingsSaved"));
        onOpenChange(false);
      },
      // Someone saved first: the message says it was reloaded, so the latest is what shows.
      onError: (error) => { if (isAdminApiConflictError(error)) setTyped(false); },
    });
  };
  const saveError = mutation.isError
    ? (isAdminApiConflictError(mutation.error) ? t("settingsChanged") : getServerFnError(mutation.error, t("settingsLoadFailed")))
    : null;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
          <DialogDescription>{t("settingsDescription")}</DialogDescription>
        </DialogHeader>
        <form id="gift-card-settings" method="post" noValidate className="space-y-4" onSubmit={submit}>
          {saveError ? <Alert variant="destructive"><AlertDescription>{saveError}</AlertDescription></Alert> : null}
          {settings.isError ? (
            <Alert variant="destructive"><AlertDescription>{t("settingsLoadFailed")}</AlertDescription></Alert>
          ) : !loaded ? (
            <Skeleton className="h-16 w-full" />
          ) : (
            <Field id="gift-card-app-daily-limit" label={t("appDailyLimitLabel")} help={t("appDailyLimitHelp")} error={fieldError ?? undefined}>
              <MoneyInput
                id="gift-card-app-daily-limit"
                currencyCode={loaded.currencyCode}
                value={limit}
                disabled={busy}
                aria-invalid={fieldError ? true : undefined}
                onValueChange={(next) => { setTyped(true); setLimit(next); }}
              />
            </Field>
          )}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button type="submit" form="gift-card-settings" loading={busy} disabled={!loaded}>{t("settingsSave")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
