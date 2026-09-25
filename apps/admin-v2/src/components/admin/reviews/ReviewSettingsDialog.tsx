import { useEffect, useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { toast } from "sonner";
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
import { reviewSettingsQueryOptions, type ReviewSettings } from "~/lib/api-query-options/reviews";
import {
  isConflict,
  settingsBody,
  settingsForm,
  useSaveReviewSettings,
  type ReviewSettingsError,
  type ReviewSettingsForm,
} from "./reviews-api";

/**
 * The Reviews page's header "Settings" dialog (Judge.me's settings, in one
 * place): on or off, moderation mode, review requests and blocked words.
 */
export function ReviewSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useMessages(reviewsMessages);
  const settings = useQuery({ ...reviewSettingsQueryOptions(), enabled: open });
  // Lives above the form: a conflict reloads the settings, which starts a fresh form.
  const [conflict, setConflict] = useState(false);
  useEffect(() => {
    if (open) setConflict(false);
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("settingsTitle")}</DialogTitle>
        </DialogHeader>
        {conflict ? (
          <Alert variant="warning">
            <AlertDescription>{t("settingsConflict")}</AlertDescription>
          </Alert>
        ) : null}
        {settings.data ? (
          // A saved or reloaded revision starts a fresh form from the server's values.
          <SettingsForm
            key={settings.data.revision}
            settings={settings.data}
            onConflict={setConflict}
            onDone={() => onOpenChange(false)}
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
  );
}

function SettingsForm({
  settings,
  onConflict,
  onDone,
}: {
  settings: ReviewSettings;
  onConflict: (conflict: boolean) => void;
  onDone: () => void;
}) {
  const t = useMessages(reviewsMessages);
  const formId = useId();
  const [form, setForm] = useState<ReviewSettingsForm>(() => settingsForm(settings));
  const [invalid, setInvalid] = useState<ReviewSettingsError | null>(null);
  const save = useSaveReviewSettings();
  const set = <K extends keyof ReviewSettingsForm>(key: K, value: ReviewSettingsForm[K]) => {
    setInvalid(null);
    setForm((current) => ({ ...current, [key]: value }));
  };
  const ids = { enabled: `${formId}-enabled`, requests: `${formId}-requests`, delay: `${formId}-delay`, words: `${formId}-words` };

  return (
    <>
      <form method="post"
        id={formId}
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const result = settingsBody(form, settings.revision);
          if (!result.ok) {
            setInvalid(result.error);
            return;
          }
          onConflict(false);
          save.mutate(result.body, {
            onSuccess: () => {
              toast.success(t("settingsSaved"));
              onDone();
            },
            onError: (error) => {
              if (isConflict(error)) onConflict(true);
              else toast.error(getServerFnError(error, t("saveFailed")));
            },
          });
        }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.enabled}>{t("enabled")}</Label>
            <p className="text-body text-muted-foreground">{t("enabledHelp")}</p>
          </div>
          <Switch id={ids.enabled} checked={form.enabled} onCheckedChange={(checked) => set("enabled", checked)} />
        </div>

        <fieldset className="flex flex-col gap-2 border-t pt-4">
          <legend className="text-heading-sm">{t("moderation")}</legend>
          <RadioGroup value={form.moderation} onValueChange={(value) => set("moderation", value === "hold" ? "hold" : "auto")}>
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
            <Switch id={ids.requests} checked={form.requestsEnabled} onCheckedChange={(checked) => set("requestsEnabled", checked)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={ids.delay}>{t("requestDelay")}</Label>
            <Input
              id={ids.delay}
              inputMode="numeric"
              value={form.requestDelayDays}
              disabled={!form.requestsEnabled}
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
        <Button type="button" variant="outline" disabled={save.isPending} onClick={onDone}>{t("cancel")}</Button>
        <Button type="submit" form={formId} loading={save.isPending}>{t("save")}</Button>
      </DialogFooter>
    </>
  );
}
