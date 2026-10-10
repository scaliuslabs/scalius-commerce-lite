/**
 * The settings of an app's homepage section or product-page block, drawn
 * from the fields the app declares with the editor's own controls: text and
 * long text, numbers, switches, a choice, several choices, a web address, an
 * email address and a colour. Labels, help and option names are the app's
 * plain text. Each field says what the app would refuse as soon as it is
 * there (app-settings.ts); a rejected save's message takes its place.
 */
import type { CSSProperties, ReactNode } from "react";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { useServerFieldError } from "~/components/admin/shared/SaveBar";
import { useMessages } from "~/i18n";
import { onlineStoreMessages } from "~/i18n/online-store";
import { themeEditorMessages } from "~/i18n/theme-editor";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import {
  appFieldValue,
  appSettingProblems,
  themeAppFields,
  withAppSettingValue,
  type AppSettingProblem,
  type AppSettingValue,
  type AppSettingValues,
} from "./app-settings";
import { Field } from "~/components/ui/field";

type Messages = (key: keyof (typeof themeEditorMessages)["en"], vars?: Record<string, string | number>) => string;

/** The DOM id of one app setting (`theme-section-app-values-title`). */
export const appSettingFieldId = (idPrefix: string, key: string) => `${idPrefix}-${key}`;

function problemText(t: Messages, problem: AppSettingProblem): string {
  switch (problem.kind) {
    case "tooLong":
      return t("appProblem_tooLong", { max: problem.max });
    case "atLeast":
      return t("appProblem_atLeast", { min: problem.min });
    case "atMost":
      return t("appProblem_atMost", { max: problem.max });
    default:
      return t(`appProblem_${problem.kind}`);
  }
}

/** Each field's problem with its values, as shown messages, by setting key. */
export function useAppSettingErrors(fields: readonly ThemeAppSettingField[], values: Readonly<Record<string, unknown>>): ReadonlyMap<string, string> {
  const t = useMessages(themeEditorMessages);
  return new Map([...appSettingProblems(fields, values)].map(([key, problem]) => [key, problemText(t, problem)]));
}

function Note({ id, help, error }: { id: string; help: string | null; error?: string }) {
  if (error) return <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p>;
  if (help) return <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>;
  return null;
}

const described = (id: string, help: string | null, error?: string) => ({
  "aria-invalid": error ? true : undefined,
  "aria-describedby": error || help ? `${id}-note` : undefined,
});

function FieldLabel({ id, field }: { id: string; field: ThemeAppSettingField }) {
  const t = useMessages(themeEditorMessages);
  return (
    <Label htmlFor={id}>
      {field.label}
      {field.required ? <span className="font-normal text-muted-foreground"> {t("appRequired")}</span> : null}
    </Label>
  );
}

/** The setting's `Field`: optional ones say so (F7); help or the problem under the control. */
function Labelled({ id, field, error, children }: { id: string; field: ThemeAppSettingField; error?: string; children: ReactNode }) {
  return (
    <Field id={id} label={field.label} optional={!field.required} help={field.help} error={error} noteId={`${id}-note`}>
      {children}
    </Field>
  );
}

const COLOR = /^#[0-9a-f]{6}$/;

function AppSettingControl({ id, field, value, error, onChange }: {
  id: string;
  field: ThemeAppSettingField;
  value: unknown;
  error?: string;
  onChange: (value: AppSettingValue | undefined) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const store = useMessages(onlineStoreMessages);
  const server = useServerFieldError(id);
  const shown = error ?? server.error;
  const set = (next: AppSettingValue | undefined) => {
    server.clear();
    onChange(next);
  };
  const text = typeof value === "string" ? value : "";
  // Addresses and colours never hold spaces; an emptied one is cleared.
  const setTrimmed = (next: string) => set(next.trim() === "" ? null : next.trim());
  switch (field.type) {
    case "boolean":
      return (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <FieldLabel id={id} field={field} />
            <Note id={id} help={field.help} error={shown} />
          </div>
          <span className="flex h-lh items-center">
            <Switch id={id} checked={value === true} {...described(id, field.help, shown)} onCheckedChange={(on) => set(on)} />
          </span>
        </div>
      );
    case "number":
      return (
        <Labelled id={id} field={field} error={shown}>
          <NumberInput
            id={id}
            value={typeof value === "number" ? value : null}
            integer={field.integer}
            onValueChange={(next) => {
              // Text that is not a number yet is the field's own; an emptied field is cleared.
              if (next === null) set(null);
              else if (!Number.isNaN(next)) set(next);
            }}
            {...described(id, field.help, shown)}
          />
        </Labelled>
      );
    case "select":
      return (
        <Labelled id={id} field={field} error={shown}>
          <SearchableSelect
            id={id}
            value={text}
            placeholder={t("appChoose")}
            clearable={!field.required}
            options={(field.options ?? []).map((option) => ({ value: option.value, label: option.label }))}
            onValueChange={(next) => set(next === "" ? null : next)}
            triggerClassName="w-full"
            {...described(id, field.help, shown)}
          />
        </Labelled>
      );
    case "multiselect": {
      const chosen = Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
      const options = field.options ?? [];
      const toggle = (option: string, on: boolean) => {
        const next = new Set(chosen);
        if (on) next.add(option);
        else next.delete(option);
        // In the app's own order.
        set(options.map((each) => each.value).filter((each) => next.has(each)));
      };
      return (
        <fieldset id={id} aria-invalid={shown ? true : undefined} aria-describedby={shown || field.help ? `${id}-note` : undefined} className="space-y-1.5">
          <legend className="text-body font-medium">
            {field.label}
            {field.required ? <span className="font-normal text-muted-foreground"> {t("appRequired")}</span> : null}
          </legend>
          {options.map((option) => (
            <label key={option.value} className="flex min-h-11 items-center gap-3 text-body sm:min-h-8">
              <Checkbox checked={chosen.includes(option.value)} onCheckedChange={(on) => toggle(option.value, on === true)} />
              {option.label}
            </label>
          ))}
          <Note id={id} help={field.help} error={shown} />
        </fieldset>
      );
    }
    case "color": {
      const valid = COLOR.test(text);
      return (
        <Labelled id={id} field={field} error={shown}>
          <div className="flex items-center gap-2">
            <label
              // The merchant's colour as the swatch (a runtime value, as a custom property).
              style={{ "--swatch": valid ? text : "transparent" } as CSSProperties}
              className="relative size-11 shrink-0 cursor-pointer rounded-lg border bg-(--swatch) sm:size-9"
            >
              <span className="sr-only">{store("pickColor", { name: field.label })}</span>
              <input
                type="color"
                value={valid ? text : "#000000"}
                onChange={(event) => setTrimmed(event.target.value.toLowerCase())}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>
            <Input
              id={id}
              value={text}
              maxLength={7}
              spellCheck={false}
              autoComplete="off"
              placeholder="#000000"
              onChange={(event) => setTrimmed(event.target.value.toLowerCase())}
              {...described(id, field.help, shown)}
            />
          </div>
        </Labelled>
      );
    }
    case "url":
    case "email":
      return (
        <Labelled id={id} field={field} error={shown}>
          <Input
            id={id}
            type={field.type}
            inputMode={field.type}
            value={text}
            spellCheck={false}
            autoComplete="off"
            placeholder={field.type === "url" ? "https://" : undefined}
            onChange={(event) => setTrimmed(event.target.value)}
            {...described(id, field.help, shown)}
          />
        </Labelled>
      );
    case "textarea":
      return (
        <Labelled id={id} field={field} error={shown}>
          <Textarea
            id={id}
            value={text}
            rows={4}
            maxLength={field.maxLength ?? undefined}
            onChange={(event) => set(event.target.value)}
            {...described(id, field.help, shown)}
          />
        </Labelled>
      );
    default:
      return (
        <Labelled id={id} field={field} error={shown}>
          <Input
            id={id}
            value={text}
            maxLength={field.maxLength ?? undefined}
            onChange={(event) => set(event.target.value)}
            {...described(id, field.help, shown)}
          />
        </Labelled>
      );
  }
}

/**
 * Every setting of one app placement. `errors` (a rejected save's, by
 * setting key) take the place of each field's own problem.
 */
export function AppSettingFields({ idPrefix, fields, values, errors, onChange }: {
  /** Starts every field id; unique on the page. */
  idPrefix: string;
  fields: readonly ThemeAppSettingField[];
  values: AppSettingValues;
  errors?: ReadonlyMap<string, string>;
  onChange: (values: AppSettingValues) => void;
}) {
  const own = useAppSettingErrors(fields, values);
  return (
    <div className="space-y-4">
      {themeAppFields(fields).map((field) => (
        <AppSettingControl
          key={field.key}
          id={appSettingFieldId(idPrefix, field.key)}
          field={field}
          value={appFieldValue(field, values)}
          error={errors?.get(field.key) ?? own.get(field.key)}
          onChange={(value) => onChange(withAppSettingValue(fields, values, field.key, value))}
        />
      ))}
    </div>
  );
}
