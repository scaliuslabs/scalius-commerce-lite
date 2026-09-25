import { useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
import { ConfirmDialog } from "~/components/admin/shared/ConfirmDialog";
import { useDirtyDialogClose } from "~/components/admin/shared/use-dirty-dialog-close";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { RadioGroup, RadioGroupItem } from "~/components/ui/radio-group";
import { Skeleton } from "~/components/ui/skeleton";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { reviewsMessages } from "~/i18n/reviews";
import { getServerFnError } from "~/lib/api-helpers";
import { reviewSettingsQueryOptions } from "~/lib/api-query-options/reviews";
import {
  isConflict,
  settingsBody,
  settingsForm,
  useSaveReviewSettings,
  type ReviewSettingsError,
  type ReviewSettingsForm,
} from "./reviews-api";

/** A newer saved version under the form: edited fields keep the edit, the rest update. */
function keepEdits(form: ReviewSettingsForm, previous: ReviewSettingsForm, saved: ReviewSettingsForm): ReviewSettingsForm {
  const next: Record<string, unknown> = { ...saved };
  for (const key of Object.keys(form) as Array<keyof ReviewSettingsForm>) {
    if (form[key] !== previous[key]) next[key] = form[key];
  }
  return next as unknown as ReviewSettingsForm;
}

/**
 * The Reviews page's header "Settings" dialog (Judge.me's settings, in one
 * place): on or off, moderation mode, review requests and blocked words.
 * A newer saved version (a refetch, a conflict) is merged under the edits,
 * and closing with unsaved edits asks first.
 */
export function ReviewSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(reviewsMessages);
  const settings = useQuery({ ...reviewSettingsQueryOptions(), enabled: open });
  const saved = useMemo(() => (settings.data ? settingsForm(settings.data) : null), [settings.data]);
  // The form and the saved version it was made from. Each opening starts from
  // the saved settings; closing keeps the form on screen while the dialog animates out.
  const [state, setState] = useState<{
    open: boolean;
    saved: ReviewSettingsForm | null;
    form: ReviewSettingsForm | null;
  }>({ open: false, saved: null, form: null });
  let form = state.form;
  if (open !== state.open) {
    form = open ? saved : state.form;
    setState({ open, saved: open ? saved : state.saved, form });
  } else if (open && state.saved !== saved) {
    form = saved && form && state.saved ? keepEdits(form, state.saved, saved) : saved;
    setState({ open, saved, form });
  }
  const [conflict, setConflict] = useState(false);
  const [invalid, setInvalid] = useState<ReviewSettingsError | null>(null);
  const save = useSaveReviewSettings();
  const dirty = Boolean(form && saved) && JSON.stringify(form) !== JSON.stringify(saved);
  const close = () => {
    setConflict(false);
    setInvalid(null);
    onOpenChange(false);
  };
  const { requestClose, discardDialog } = useDirtyDialogClose({ dirty, busy: save.isPending, onClose: close });
  const set = <K extends keyof ReviewSettingsForm>(key: K, value: ReviewSettingsForm[K]) => {
    setInvalid(null);
    setState((current) => (current.form ? { ...current, form: { ...current.form, [key]: value } } : current));
  };
  const submit = () => {
    if (!form || !settings.data) return;
    const result = settingsBody(form, settings.data.revision);
    if (!result.ok) {
      setInvalid(result.error);
      return;
    }
    setConflict(false);
    save.mutate(result.body, {
      onSuccess: () => {
        toast.success(t("settingsSaved"));
        close();
      },
      onError: (error) => {
        // The newer settings are refetched and merged under these edits.
        if (isConflict(error)) setConflict(true);
        else toast.error(getServerFnError(error, t("saveFailed")));
      },
    });
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("settingsTitle")}</DialogTitle>
          </DialogHeader>
          {conflict ? (
            <Alert variant="warning">
              <AlertDescription>{t("settingsConflict")}</AlertDescription>
            </Alert>
          ) : null}
          {form ? (
            <SettingsForm
              form={form}
              set={set}
              invalid={invalid}
              saving={save.isPending}
              onSubmit={submit}
              onCancel={requestClose}
            />
          ) : settings.isError ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-body text-destructive">{t("settingsLoadFailed")}</p>
              <Button type="button" size="sm" variant="outline" onClick={() => void settings.refetch()}>{t("retry")}</Button>
            </div>
          ) : (
            <div aria-busy className="flex flex-col gap-4">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          )}
        </DialogContent>
      </Dialog>
      <ConfirmDialog {...discardDialog} />
    </>
  );
}

function SettingsForm({
  form,
  set,
  invalid,
  saving,
  onSubmit,
  onCancel,
}: {
  form: ReviewSettingsForm;
  set: <K extends keyof ReviewSettingsForm>(key: K, value: ReviewSettingsForm[K]) => void;
  invalid: ReviewSettingsError | null;
  saving: boolean;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  const t = useMessages(reviewsMessages);
  const formId = useId();
  const ids = { enabled: `${formId}-enabled`, requests: `${formId}-requests`, delay: `${formId}-delay`, words: `${formId}-words` };

  return (
    <>
      <form method="post"
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!saving) onSubmit();
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.enabled}>{t("enabled")}</Label>
            <p className="text-body text-muted-foreground">{t("enabledHelp")}</p>
          </div>
          <Switch id={ids.enabled} disabled={saving} checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
        </div>

        <fieldset className="flex flex-col gap-2 border-t pt-4">
          <legend className="text-heading-sm">{t("moderation")}</legend>
          <RadioGroup disabled={saving} value={form.moderation} onValueChange={(value) => set("moderation", value === "hold" ? "hold" : "auto")}>
            {(["auto", "hold"] as const).map((mode) => (
              <div key={mode} className="flex items-start gap-2">
                <span className="flex h-lh items-center">
                  <RadioGroupItem id={`${formId}-${mode}`} value={mode} aria-describedby={`${formId}-${mode}-help`} />
                </span>
                <div className="flex flex-col gap-1">
                  <Label htmlFor={`${formId}-${mode}`}>{t(`moderation.${mode}`)}</Label>
                  <p id={`${formId}-${mode}-help`} className="text-body text-muted-foreground">{t(`moderation.${mode}Help`)}</p>
                </div>
              </div>
            ))}
          </RadioGroup>
          <p className="text-body text-muted-foreground">{t("ratingNeverChecked")}</p>
        </fieldset>

        <fieldset className="flex flex-col gap-3 border-t pt-4">
          <legend className="text-heading-sm">{t("requests")}</legend>
          <div className="flex items-start justify-between gap-4">
            <Label htmlFor={ids.requests}>{t("requestsEnabled")}</Label>
            <Switch id={ids.requests} disabled={saving} checked={form.requestsEnabled} onCheckedChange={(checked) => set("requestsEnabled", checked)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.delay}>{t("requestDelay")}</Label>
            <Input
              id={ids.delay}
              inputMode="numeric"
              value={form.requestDelayDays}
              disabled={saving || !form.requestsEnabled}
              aria-invalid={invalid === "delayInvalid" || undefined}
              aria-describedby={`${ids.delay}-help`}
              onChange={(event) => set("requestDelayDays", event.target.value)}
              className="w-24"
            />
            <p id={`${ids.delay}-help`} className={invalid === "delayInvalid" ? "text-body text-destructive" : "text-body text-muted-foreground"}>
              {invalid === "delayInvalid" ? t("delayInvalid") : t("requestDelayHelp")}
            </p>
          </div>
          <p className="text-body text-muted-foreground">
            {t("requestChannels")}{" "}
            <Link to="/admin/settings/notifications" className="text-link hover:underline">{t("notificationsLink")}</Link>
          </p>
        </fieldset>

        <div className="flex flex-col gap-1 border-t pt-4">
          <Label htmlFor={ids.words}>{t("blockWords")}</Label>
          <Textarea
            id={ids.words}
            rows={4}
            disabled={saving}
            value={form.blockWords}
            aria-invalid={invalid === "blockWordsTooMany" || invalid === "blockWordTooLong" || undefined}
            aria-describedby={`${ids.words}-help`}
            onChange={(event) => set("blockWords", event.target.value)}
          />
          <p
            id={`${ids.words}-help`}
            className={invalid === "blockWordsTooMany" || invalid === "blockWordTooLong" ? "text-body text-destructive" : "text-body text-muted-foreground"}
          >
            {invalid === "blockWordsTooMany" || invalid === "blockWordTooLong" ? t(invalid) : t("blockWordsHelp")}
          </p>
        </div>
      </form>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={onCancel}>{t("cancel")}</Button>
        <Button type="submit" form={formId} loading={saving}>{t("save")}</Button>
      </DialogFooter>
    </>
  );
}
