// An app's settings card: one control per field the app declares, generated
// from the API (no app code runs here). Saves through the page save bar with
// the app's revision. Secrets are write-only: a badge says whether one is
// set, the box starts empty and is sent only when typed in, and "Remove"
// sends null.
import { useState, type CSSProperties, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SaveConflict, useSaveBar, useServerFieldError } from "~/components/admin/shared/SaveBar";
import { SettingsField } from "~/components/admin/settings/SettingsPage";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useMessages } from "~/i18n";
import { installedAppsMessages } from "~/i18n/apps";
import { AdminApiResponseError } from "~/lib/admin-api-error";
import {
  appSettingErrors,
  isAppChangedError,
  saveAppSettings,
  type AppDetail,
  type AppSettingField,
} from "~/lib/api-query-options/apps";
import { queryKeys } from "~/lib/query-keys";
import {
  checkSettings,
  draftFromSettings,
  sameDraft,
  settingsBody,
  type SettingProblem,
  type SettingsDraft,
} from "./app-settings-draft";

const COLOR = /^#[0-9a-f]{6}$/;

export const settingFieldId = (key: string) => `app-setting-${key}`;

/** A multi-choice list: a fieldset with its own note, marked when the last save refused it. */
function ChoiceList({ field, label, chosen, problem, help, disabled, onChange }: {
  field: AppSettingField;
  label: ReactNode;
  chosen: string[];
  problem: string | null;
  help: string | null;
  disabled: boolean;
  onChange: (next: string[]) => void;
}) {
  const id = settingFieldId(field.key);
  const server = useServerFieldError(id);
  const shown = server.error ?? (server.revealed ? problem : null);
  const options = field.options ?? [];
  const toggle = (value: string, on: boolean) => {
    server.clear();
    const next = new Set(chosen);
    if (on) next.add(value);
    else next.delete(value);
    onChange(options.map((option) => option.value).filter((option) => next.has(option)));
  };
  return (
    <fieldset id={id} aria-invalid={shown ? true : undefined} aria-describedby={shown || help ? `${id}-note` : undefined} className="space-y-1.5">
      <legend className="text-body font-medium">{label}</legend>
      {options.map((option) => (
        <label key={option.value} className="flex min-h-11 items-center gap-3 text-body sm:min-h-8">
          <Checkbox checked={chosen.includes(option.value)} disabled={disabled} onCheckedChange={(on) => toggle(option.value, on === true)} />
          {option.label}
        </label>
      ))}
      {shown ? (
        <p id={`${id}-note`} role="alert" className="text-body text-destructive">{shown}</p>
      ) : help ? (
        <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>
      ) : null}
    </fieldset>
  );
}

export function AppSettingsForm({ app, canManage }: { app: AppDetail; canManage: boolean }) {
  const t = useMessages(installedAppsMessages);
  const queryClient = useQueryClient();
  const { settings } = app;
  const [saved, setSaved] = useState(() => draftFromSettings(settings));
  const [draft, setDraft] = useState(saved);
  const [seenRevision, setSeenRevision] = useState(app.revision);
  const dirty = canManage && !sameDraft(draft, saved);
  // A newer app (reloaded, activated, changed elsewhere) is the new baseline; unsaved edits stay.
  if (app.revision !== seenRevision) {
    setSeenRevision(app.revision);
    const next = draftFromSettings(settings);
    setSaved(next);
    if (!dirty) setDraft(next);
  }
  const problems = checkSettings(settings.fields, draft, settings.secrets);

  useSaveBar({
    label: t("settingsTitle"),
    dirty,
    invalid: Object.keys(problems).length > 0,
    fields: (path) => (settings.fields.some((field) => field.key === path) ? settingFieldId(path) : undefined),
    save: async () => {
      try {
        const next = await saveAppSettings(app, settingsBody(settings.fields, draft));
        const fresh = draftFromSettings(next.settings);
        setSaved(fresh);
        setDraft(fresh);
        setSeenRevision(next.revision);
        queryClient.setQueryData(queryKeys.apps.detail(app.id), next);
        void queryClient.invalidateQueries({ queryKey: queryKeys.apps.list() });
      } catch (error) {
        if (isAppChangedError(error)) throw new SaveConflict(t("changedElsewhere"));
        const refused = appSettingErrors(error);
        if (refused) {
          // Marked on the fields themselves by the save bar.
          throw new AdminApiResponseError(t("settingsRefused"), 400, "VALIDATION_ERROR", {
            issues: refused.map((issue) => ({ path: issue.key, message: issue.message === "Required." ? t("problem_required") : issue.message })),
          });
        }
        throw error;
      }
    },
    discard: () => setDraft(saved),
    reload: () => queryClient.refetchQueries({ queryKey: queryKeys.apps.detail(app.id) }),
  });

  const problemText = (problem: SettingProblem | undefined): string | null => {
    if (!problem) return null;
    switch (problem.kind) {
      case "tooLong":
        return t("problem_tooLong", { max: problem.max });
      case "atLeast":
        return t("problem_atLeast", { min: problem.min });
      case "atMost":
        return t("problem_atMost", { max: problem.max });
      default:
        return t(`problem_${problem.kind}`);
    }
  };
  const setValue = (key: string, value: SettingsDraft["values"][string]) =>
    setDraft((current) => ({ ...current, values: { ...current.values, [key]: value } }));
  const setSecret = (key: string, value: string | null | undefined) =>
    setDraft((current) => {
      const secrets = { ...current.secrets };
      if (value === undefined) delete secrets[key];
      else secrets[key] = value;
      return { ...current, secrets };
    });

  const control = (field: AppSettingField) => {
    const id = settingFieldId(field.key);
    const disabled = !canManage;
    const error = problemText(problems[field.key]);
    const label = (
      <>
        {field.label}
        {field.required ? <span className="font-normal text-muted-foreground"> {t("requiredMark")}</span> : null}
      </>
    );
    const value = draft.values[field.key];
    const textValue = typeof value === "string" ? value : "";
    // The note under a field is its help until a problem replaces it (SettingsField wires that one).
    const described = (help: string | null) => (help ? { "aria-describedby": `${id}-note` } : {});
    switch (field.type) {
      case "boolean":
        return (
          <label key={field.key} className="flex min-h-11 items-center justify-between gap-4 text-body">
            <span>
              <span className="block font-medium">{field.label}</span>
              {field.help ? <span className="block text-muted-foreground">{field.help}</span> : null}
            </span>
            <Switch id={id} checked={value === true} disabled={disabled} onCheckedChange={(on) => setValue(field.key, on)} />
          </label>
        );
      case "multiselect":
        return (
          <ChoiceList
            key={field.key}
            field={field}
            label={label}
            chosen={Array.isArray(value) ? value : []}
            problem={error}
            help={field.help}
            disabled={disabled}
            onChange={(next) => setValue(field.key, next)}
          />
        );
      case "select":
        return (
          <SettingsField key={field.key} id={id} label={label} help={field.help} error={error}>
            <SearchableSelect
              id={id}
              triggerClassName="w-full"
              value={textValue}
              disabled={disabled}
              clearable={!field.required}
              placeholder={t("choose")}
              onValueChange={(next) => setValue(field.key, next)}
              options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
            />
          </SettingsField>
        );
      case "secret": {
        const isSet = settings.secrets[field.key] === true;
        const edit = draft.secrets[field.key];
        return (
          <div key={field.key} className="space-y-1.5">
            <SettingsField
              id={id}
              label={
                <span className="flex flex-wrap items-center gap-2">
                  {label}
                  <Badge variant={isSet ? "success" : "secondary"}>{t(isSet ? "secretSet" : "secretNotSet")}</Badge>
                </span>
              }
              help={field.help ?? (isSet ? t("secretKeepHelp") : null)}
              error={error}
            >
              <Input
                id={id}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={typeof edit === "string" ? edit : ""}
                placeholder={isSet ? t("secretReplace") : undefined}
                disabled={disabled}
                {...described(field.help ?? (isSet ? t("secretKeepHelp") : null))}
                onChange={(event) => setSecret(field.key, event.target.value === "" ? undefined : event.target.value)}
              />
            </SettingsField>
            {canManage && isSet ? (
              edit === null ? (
                <p className="flex flex-wrap items-center gap-x-2 text-body text-muted-foreground">
                  {t("secretWillClear")}
                  <Button type="button" variant="link" size="sm" onClick={() => setSecret(field.key, undefined)}>{t("secretKeep")}</Button>
                </p>
              ) : (
                <Button type="button" variant="link" size="sm" onClick={() => setSecret(field.key, null)}>{t("secretClear")}</Button>
              )
            ) : null}
          </div>
        );
      }
      case "color": {
        const valid = COLOR.test(textValue);
        return (
          <SettingsField key={field.key} id={id} label={label} help={field.help} error={error}>
            <div className="flex items-center gap-2">
              <label
                style={{ "--swatch": valid ? textValue : "transparent" } as CSSProperties}
                className="relative size-11 shrink-0 cursor-pointer rounded-lg border bg-(--swatch) sm:size-9"
              >
                <span className="sr-only">{t("pickColor", { name: field.label })}</span>
                <input
                  type="color"
                  value={valid ? textValue : "#000000"}
                  disabled={disabled}
                  onChange={(event) => setValue(field.key, event.target.value.toLowerCase())}
                  className="absolute inset-0 size-full cursor-pointer opacity-0"
                />
              </label>
              <Input
                id={id}
                value={textValue}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                placeholder="#000000"
                disabled={disabled}
                {...described(field.help)}
                onChange={(event) => setValue(field.key, event.target.value.trim().toLowerCase())}
              />
            </div>
          </SettingsField>
        );
      }
      case "textarea":
        return (
          <SettingsField key={field.key} id={id} label={label} help={field.help} error={error}>
            <Textarea
              id={id}
              value={textValue}
              maxLength={field.maxLength ?? undefined}
              disabled={disabled}
              {...described(field.help)}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          </SettingsField>
        );
      default:
        return (
          <SettingsField key={field.key} id={id} label={label} help={field.help} error={error}>
            <Input
              id={id}
              type={field.type}
              inputMode={field.type === "number" ? (field.integer ? "numeric" : "decimal") : undefined}
              min={field.min ?? undefined}
              max={field.max ?? undefined}
              step={field.type === "number" ? (field.integer ? 1 : "any") : undefined}
              maxLength={field.maxLength ?? undefined}
              placeholder={field.type === "url" ? "https://" : undefined}
              autoComplete="off"
              value={textValue}
              disabled={disabled}
              {...described(field.help)}
              onChange={(event) => setValue(field.key, event.target.value)}
            />
          </SettingsField>
        );
    }
  };

  const missing = app.status !== "active" ? settings.fields.filter((field) => settings.missing.includes(field.key)) : [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("settingsTitle")}</CardTitle>
        <CardDescription>{t("settingsDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {missing.length > 0 ? (
          <Alert variant="warning">
            <AlertDescription>{t("missingBody", { settings: missing.map((field) => field.label).join(", ") })}</AlertDescription>
          </Alert>
        ) : null}
        {settings.fields.map(control)}
      </CardContent>
    </Card>
  );
}
