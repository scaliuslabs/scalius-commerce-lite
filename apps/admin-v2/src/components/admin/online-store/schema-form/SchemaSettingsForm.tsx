/**
 * A settings form drawn from a registry schema (introspect.ts): text and
 * long text by maximum length, steppers and sliders for numbers, switches,
 * choices, grouped settings, repeatable lists with move and remove, and
 * variants that keep shared settings when switched. Settings that name
 * records pick their control by key (images, links, categories,
 * collections, a promotion); `widgets` replaces the control of one path
 * (the hero's slides) and `visible` hides settings their siblings make
 * irrelevant. Labels come from the theme setting catalog (labels.ts).
 */
import { bindingSettingType } from "@scalius/shared/storefront-theme/bindings";
import { DynamicSourcePicker } from "./DynamicSourcePicker";
import { createContext, useContext, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Minus, Plus, Trash2 } from "lucide-react";
import { STOREFRONT_CATEGORY_TILES_LIMIT, storefrontCategoryTilesMinimum, type StorefrontCategoryTileStyle } from "@scalius/shared/storefront-theme";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { NumberInput } from "~/components/ui/number-input";
import { SearchableSelect } from "~/components/ui/searchable-select";
import { Switch } from "~/components/ui/switch";
import { Textarea } from "~/components/ui/textarea";
import { formatNumber, useMessages } from "~/i18n";
import { themeSettingMessages } from "~/i18n/theme-settings";
import {
  settingDefault,
  switchVariant,
  variantOf,
  type ChoiceSpec,
  type ListSpec,
  type NumberSpec,
  type ObjectSpec,
  type SettingSpec,
  type VariantsSpec,
} from "./introspect";
import { settingHelpKey, settingLabelKey, type LabelScope } from "./labels";
import { ObjectTypeWidget } from "./ObjectTypeWidget";
import {
  CategoryPicks,
  CategorySelect,
  CollectionPicks,
  CollectionSelect,
  LinkField,
  MediaField,
  PromotionSelect,
  moveAt,
  removeAt,
  replaceAt,
  type MediaPreviews,
} from "./resource-fields";
import { Field, ChoiceField } from "~/components/ui/field";

type Values = Record<string, unknown>;

/** What a custom control gets: its place in the form, its label and help, the value and its siblings. */
export interface SettingWidgetProps {
  id: string;
  label: string;
  help?: string;
  /** The setting's path without list indices (`slides`). */
  path: string;
  /** The value's path with list indices (`slides.0`), as errors are keyed. */
  dataPath: string;
  spec: SettingSpec;
  value: unknown;
  parent: Values;
  onChange: (value: unknown) => void;
  /** The error at a data path under this one ("" for the setting itself). */
  error: (relative?: string) => string | undefined;
  media: MediaPreviews;
}

export type SettingWidget = (props: SettingWidgetProps) => ReactNode;

interface FormContext {
  idPrefix: string;
  scope: LabelScope;
  errors: ReadonlyMap<string, string>;
  widgets: Readonly<Record<string, SettingWidget>>;
  visible?: (path: string, parent: Values) => boolean;
  media: MediaPreviews;
}

const Context = createContext<FormContext | null>(null);

function useForm(): FormContext {
  const context = useContext(Context);
  if (!context) throw new Error("SchemaSettingsForm context missing");
  return context;
}

const joinPath = (prefix: string, key: string | number) => (prefix ? `${prefix}.${key}` : String(key));

export const settingFieldId = (prefix: string, dataPath: string) =>
  dataPath ? `${prefix}-${dataPath.replace(/\./g, "-")}` : prefix;

function useLabels() {
  const t = useMessages(themeSettingMessages);
  const { scope } = useForm();
  return {
    t,
    label: (path: string, fallback: string) => {
      const key = settingLabelKey(scope, path);
      return key ? t(key) : fallback;
    },
    help: (path: string) => {
      const key = settingHelpKey(settingLabelKey(scope, path));
      return key ? t(key) : undefined;
    },
    value: (path: string, value: string | number) => {
      if (typeof value === "number") return formatNumber(value);
      const key = settingLabelKey(scope, path, value);
      return key ? t(key) : value;
    },
    suffix: (path: string, suffix: string, values?: Record<string, string | number>) => {
      const key = settingLabelKey(scope, path, suffix);
      return key ? t(key, values) : null;
    },
  };
}

function Note({ id, help, error }: { id: string; help?: string; error?: string }) {
  if (error) return <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p>;
  if (help) return <p id={`${id}-note`} className="text-body text-muted-foreground">{help}</p>;
  return null;
}

const described = (id: string, help?: string, error?: string) => ({
  "aria-invalid": error ? true : undefined,
  "aria-describedby": error || help ? `${id}-note` : undefined,
});

/** Settings by key: images, links and the records a setting names. */
const KEY_WIDGETS: Readonly<Record<string, SettingWidget>> = {
  mediaId: MediaWidget,
  image: MediaWidget,
  phoneImage: MediaWidget,
  link: LinkWidget,
  href: LinkWidget,
  categoryId: ({ id, label, help, value, onChange, error }) => (
    <Field id={id} label={label} help={help} error={error()} noteId={`${id}-note`}>
      <CategorySelect id={id} value={String(value ?? "")} invalid={Boolean(error())} onChange={onChange} />
    </Field>
  ),
  collectionId: ({ id, label, help, value, onChange, error }) => (
    <Field id={id} label={label} help={help} error={error()} noteId={`${id}-note`}>
      <CollectionSelect id={id} value={String(value ?? "")} invalid={Boolean(error())} onChange={onChange} />
    </Field>
  ),
  categoryIds: ({ id, label, value, spec, parent, onChange, error }) => (
    <CategoryPicks
      id={id}
      label={label}
      ids={(value as string[] | undefined) ?? []}
      max={spec.kind === "list" && spec.max !== null ? spec.max : STOREFRONT_CATEGORY_TILES_LIMIT}
      minimum={typeof parent.style === "string" ? storefrontCategoryTilesMinimum(parent.style as StorefrontCategoryTileStyle) : 0}
      error={error()}
      onChange={onChange}
    />
  ),
  collectionIds: ({ id, label, value, spec, onChange, error }) => (
    <CollectionPicks
      id={id}
      label={label}
      ids={(value as string[] | undefined) ?? []}
      max={spec.kind === "list" && spec.max !== null ? spec.max : 8}
      error={error()}
      onChange={onChange}
    />
  ),
  typeId: ObjectTypeWidget,
  promotionId: ({ id, label, help, value, onChange, error }) => (
    <Field id={id} label={label} help={help} error={error()} noteId={`${id}-note`}>
      <PromotionSelect id={id} value={(value as string | null | undefined) ?? null} onChange={onChange} />
    </Field>
  ),
};

function MediaWidget({ id, label, help, value, spec, onChange, error, media }: SettingWidgetProps) {
  const mediaId = typeof value === "string" && value ? value : null;
  return (
    <MediaField
      id={id}
      label={label}
      help={help}
      mediaId={mediaId}
      previews={media.previews}
      error={error()}
      onPick={(image) => {
        media.remember(image);
        onChange(image.id);
      }}
      onRemove={spec.nullable || spec.optional ? () => onChange(spec.nullable ? null : undefined) : undefined}
    />
  );
}

function LinkWidget({ id, label, help, value, spec, onChange, error }: SettingWidgetProps) {
  return (
    <LinkField
      id={id}
      label={label}
      help={help}
      value={typeof value === "string" ? value : null}
      nullable={Boolean(spec.nullable)}
      error={error()}
      onChange={(link) => onChange(link)}
    />
  );
}

function TextSetting({ id, label, help, error, value, spec, onChange }: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  value: unknown;
  spec: Extract<SettingSpec, { kind: "text" }>;
  onChange: (value: unknown) => void;
}) {
  const text = typeof value === "string" ? value : "";
  const long = spec.max === null || spec.max > 200;
  // An optional text is absent, never an empty string.
  const change = (next: string) => onChange(next === "" && spec.optional ? undefined : next === "" && spec.nullable ? null : next);
  return (
    <Field id={id} label={label} help={help} error={error} noteId={`${id}-note`}>
      {long ? (
        <Textarea
          id={id}
          value={text}
          rows={spec.max !== null && spec.max > 1000 ? 8 : 4}
          maxLength={spec.max ?? undefined}
          onChange={(event) => change(event.target.value)}
          {...described(id, help, error)}
        />
      ) : (
        <Input id={id} value={text} maxLength={spec.max ?? undefined} onChange={(event) => change(event.target.value)} {...described(id, help, error)} />
      )}
    </Field>
  );
}

function NumberSetting({ id, label, help, error, value, spec, onChange }: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  value: unknown;
  spec: NumberSpec;
  onChange: (value: unknown) => void;
}) {
  const { t } = useLabels();
  const number = typeof value === "number" ? value : spec.min;
  const clamp = (next: number) => Math.min(spec.max, Math.max(spec.min, spec.int ? Math.round(next) : next));
  // Short ranges step; long ones slide.
  if (spec.max - spec.min > 12) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor={id}>{label}</Label>
          {/* The exact value can be typed too; the slider shows its range. */}
          {/* eslint-disable-next-line no-restricted-syntax -- a range: its typed value sits on the label line, as in Shopify's theme editor */}
          <Input
            type="number"
            inputMode="numeric"
            aria-label={label}
            min={spec.min}
            max={spec.max}
            step={spec.int ? 1 : "any"}
            value={number}
            onChange={(event) => {
              const next = Number(event.target.value);
              if (event.target.value !== "" && Number.isFinite(next)) onChange(clamp(next));
            }}
            className="w-20"
          />
        </div>
        <input
          id={id}
          type="range"
          min={spec.min}
          max={spec.max}
          step={spec.int ? 1 : "any"}
          value={number}
          onChange={(event) => onChange(clamp(Number(event.target.value)))}
          className="h-11 w-full accent-primary sm:h-6"
          {...described(id, help, error)}
        />
        <div className="flex justify-between text-caption tabular-nums text-muted-foreground" aria-hidden="true">
          <span>{formatNumber(spec.min)}</span>
          <span>{formatNumber(spec.max)}</span>
        </div>
        <Note id={id} help={help} error={error} />
      </div>
    );
  }
  return (
    <Field id={id} label={label} help={help} error={error} noteId={`${id}-note`}>
      <div className="flex items-center gap-1">
        <Button type="button" variant="outline" size="icon" aria-label={t("form.decrease", { name: label })} disabled={number <= spec.min} onClick={() => onChange(clamp(number - 1))}>
          <Minus aria-hidden="true" />
        </Button>
        <NumberInput
          id={id}
          value={number}
          integer={spec.int}
          className="w-20 text-center"
          onValueChange={(next) => {
            if (next !== null && !Number.isNaN(next)) onChange(clamp(next));
          }}
          {...described(id, help, error)}
        />
        <Button type="button" variant="outline" size="icon" aria-label={t("form.increase", { name: label })} disabled={number >= spec.max} onClick={() => onChange(clamp(number + 1))}>
          <Plus aria-hidden="true" />
        </Button>
      </div>
    </Field>
  );
}

function SwitchSetting({ id, label, help, value, onChange }: {
  id: string;
  label: string;
  help?: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <ChoiceField
      id={id}
      label={label}
      help={help}
      control={<Switch id={id} checked={value} aria-describedby={help ? `${id}-help` : undefined} onCheckedChange={onChange} />}
    />
  );
}

function ChoiceSetting({ id, label, help, error, path, value, spec, onChange }: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  path: string;
  value: unknown;
  spec: ChoiceSpec;
  onChange: (value: unknown) => void;
}) {
  const labels = useLabels();
  const unset = spec.optional ? labels.suffix(path, "unset") : null;
  const options = [
    ...(unset ? [{ value: "", label: unset }] : []),
    ...spec.values.map((each) => ({ value: String(each), label: labels.value(path, each) })),
  ];
  // An optional choice without an unset option shows its first value (its default).
  const shown = value === undefined || value === null ? (unset ? "" : String(spec.values[0])) : String(value);
  return (
    <Field id={id} label={label} help={help} error={error} noteId={`${id}-note`}>
      <SearchableSelect
        id={id}
        value={shown}
        options={options}
        onValueChange={(next) => {
          if (next === "") return onChange(undefined);
          onChange(spec.values.find((each) => String(each) === next));
        }}
        triggerClassName="w-full"
        aria-invalid={error ? true : undefined}
      />
    </Field>
  );
}

/** A list of fixed choices in order (bottom tabs): move, remove and add the rest. */
function ChoiceListSetting({ id, label, help, error, path, value, spec, onChange }: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  path: string;
  value: unknown;
  spec: ListSpec & { item: ChoiceSpec };
  onChange: (value: unknown) => void;
}) {
  const labels = useLabels();
  const items = (Array.isArray(value) ? value : []) as Array<string | number>;
  const full = spec.max !== null && items.length >= spec.max;
  const name = (each: string | number) => labels.value(path, each);
  return (
    <fieldset className="space-y-2">
      <legend className="text-body font-medium">{label}</legend>
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      {items.length > 0 ? (
        <ol className="divide-y rounded-lg border">
          {items.map((item, index) => (
            <li key={String(item)} className="flex min-h-11 items-center gap-1 py-1 pe-1 ps-3">
              <span className="min-w-0 flex-1 truncate text-body">{name(item)}</span>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.moveUp", { name: name(item) })} disabled={index === 0} onClick={() => onChange(moveAt(items, index, -1))}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.moveDown", { name: name(item) })} disabled={index === items.length - 1} onClick={() => onChange(moveAt(items, index, 1))}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.remove", { name: name(item) })} disabled={items.length <= spec.min} onClick={() => onChange(removeAt(items, index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ol>
      ) : null}
      <SearchableSelect
        id={id}
        value=""
        disabled={full}
        options={spec.item.values.filter((each) => !items.includes(each)).map((each) => ({ value: String(each), label: name(each) }))}
        onValueChange={(next) => {
          const found = spec.item.values.find((each) => String(each) === next);
          if (found !== undefined && !items.includes(found)) onChange([...items, found]);
        }}
        placeholder={labels.t("form.addChoice")}
        ariaLabel={`${label}: ${labels.t("form.addChoice")}`}
        triggerClassName="w-full"
      />
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
    </fieldset>
  );
}

/** Repeatable groups (slides, cards, questions): each with move and remove, then Add. */
function ListSetting({ id, label, help, path, dataPath, value, spec, onChange }: {
  id: string;
  label: string;
  help?: string;
  path: string;
  dataPath: string;
  value: unknown;
  spec: ListSpec;
  onChange: (value: unknown) => void;
}) {
  const labels = useLabels();
  const form = useForm();
  const items = Array.isArray(value) ? value : [];
  const full = spec.max !== null && items.length >= spec.max;
  const error = form.errors.get(dataPath);
  const item = { ...spec.item, nullable: false, optional: false } as SettingSpec;
  return (
    <fieldset id={id} className="space-y-3">
      <legend className="text-body font-medium">{label}</legend>
      {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
      {items.map((entry, index) => {
        const name = labels.suffix(path, "item", { number: index + 1 }) ?? labels.t("f.item", { number: index + 1 });
        return (
          <div key={index} className="space-y-3 border-t border-border pt-3">
            <div className="flex items-center gap-1">
              <p className="min-w-0 flex-1 text-heading-sm">{name}</p>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.moveUp", { name })} disabled={index === 0} onClick={() => onChange(moveAt(items, index, -1))}>
                <ArrowUp aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.moveDown", { name })} disabled={index === items.length - 1} onClick={() => onChange(moveAt(items, index, 1))}>
                <ArrowDown aria-hidden="true" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={labels.t("form.remove", { name })} disabled={items.length <= spec.min} onClick={() => onChange(removeAt(items, index))}>
                <Trash2 aria-hidden="true" />
              </Button>
            </div>
            <SettingValue
              spec={item}
              path={path}
              dataPath={joinPath(dataPath, index)}
              value={entry}
              onChange={(next) => onChange(replaceAt(items, index, next))}
            />
          </div>
        );
      })}
      {error ? <p role="alert" className="text-body text-destructive">{error}</p> : null}
      {full ? null : (
        <Button type="button" variant="outline" size="sm" onClick={() => onChange([...items, settingDefault(item)])}>
          <Plus aria-hidden="true" />
          {labels.suffix(path, "add") ?? labels.t("f.add")}
        </Button>
      )}
    </fieldset>
  );
}

/** One setting with its label: a key widget, a path widget or the control its spec calls for. */
function SettingControl({ fieldKey, spec, path, dataPath, value, parent, onChange }: {
  fieldKey: string;
  spec: SettingSpec;
  path: string;
  dataPath: string;
  value: unknown;
  parent: Values;
  onChange: (value: unknown) => void;
}) {
  const form = useForm();
  const labels = useLabels();
  const id = settingFieldId(form.idPrefix, dataPath);
  const label = labels.label(path, fieldKey);
  const help = labels.help(path);
  const error = form.errors.get(dataPath);
  const Widget = form.widgets[path] ?? KEY_WIDGETS[fieldKey];
  if (Widget) {
    return (
      <Widget
        id={id}
        label={label}
        help={help}
        path={path}
        dataPath={dataPath}
        spec={spec}
        value={value}
        parent={parent}
        onChange={onChange}
        error={(relative = "") => form.errors.get(relative ? joinPath(dataPath, relative) : dataPath)}
        media={form.media}
      />
    );
  }
  switch (spec.kind) {
    case "text":
      return <TextSetting id={id} label={label} help={help} error={error} value={value} spec={spec} onChange={onChange} />;
    case "number":
      return <NumberSetting id={id} label={label} help={help} error={error} value={value} spec={spec} onChange={onChange} />;
    case "boolean":
      return <SwitchSetting id={id} label={label} help={help} value={value === true} onChange={onChange} />;
    case "choice":
      return <ChoiceSetting id={id} label={label} help={help} error={error} path={path} value={value} spec={spec} onChange={onChange} />;
    case "list":
      return spec.item.kind === "choice"
        ? <ChoiceListSetting id={id} label={label} help={help} error={error} path={path} value={value} spec={spec as ListSpec & { item: ChoiceSpec }} onChange={onChange} />
        : <ListSetting id={id} label={label} help={help} path={path} dataPath={dataPath} value={value} spec={spec} onChange={onChange} />;
    case "object":
      if (spec.nullable) {
        // A group that can be left out (a banner's button): a switch, then its settings.
        return (
          <div className="space-y-3">
            <SwitchSetting
              id={id}
              label={label}
              help={help}
              value={value !== null && value !== undefined}
              onChange={(on) => onChange(on ? settingDefault({ ...spec, nullable: false }) : null)}
            />
            {value ? <ObjectFields spec={spec} path={path} dataPath={dataPath} value={value as Values} onChange={onChange} /> : null}
          </div>
        );
      }
      return (
        <fieldset className="space-y-3">
          <legend className="text-body font-medium">{label}</legend>
          {help ? <p className="text-body text-muted-foreground">{help}</p> : null}
          <ObjectFields spec={spec} path={path} dataPath={dataPath} value={(value ?? {}) as Values} onChange={onChange} />
        </fieldset>
      );
    case "variants":
      return <VariantFields id={id} label={label} help={help} spec={spec} path={path} dataPath={dataPath} value={value} onChange={onChange} />;
  }
}

function Setting(props: Parameters<typeof SettingControl>[0]) {
  const form = useForm();
  const labels = useLabels();
  return <div className="space-y-1">
    <SettingControl {...props} />
    <DynamicSourcePicker id={settingFieldId(form.idPrefix, props.dataPath)} path={props.dataPath}
      type={bindingSettingType(props.spec.kind, props.fieldKey)} label={labels.label(props.path, props.fieldKey)} />
  </div>;
}

/** A value without a label of its own: a list item, or the root settings. */
function SettingValue({ spec, path, dataPath, value, onChange }: {
  spec: SettingSpec;
  path: string;
  dataPath: string;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const form = useForm();
  if (spec.kind === "object") return <ObjectFields spec={spec} path={path} dataPath={dataPath} value={(value ?? {}) as Values} onChange={onChange} />;
  if (spec.kind === "variants") {
    return <VariantFields id={settingFieldId(form.idPrefix, joinPath(dataPath, spec.key))} spec={spec} path={path} dataPath={dataPath} value={value} onChange={onChange} />;
  }
  const key = path.split(".").at(-1) ?? path;
  return <Setting fieldKey={key} spec={spec} path={path} dataPath={dataPath} value={value} parent={{}} onChange={onChange} />;
}

function ObjectFields({ spec, path, dataPath, value, onChange }: {
  spec: ObjectSpec;
  path: string;
  dataPath: string;
  value: Values;
  onChange: (value: Values) => void;
}) {
  const form = useForm();
  const set = (key: string, next: unknown) => {
    const result = { ...value };
    if (next === undefined) delete result[key];
    else result[key] = next;
    onChange(result);
  };
  return (
    <div className="space-y-4">
      {spec.fields
        .filter((field) => form.visible?.(joinPath(path, field.key), value) ?? true)
        .map((field) => (
          <Setting
            key={field.key}
            fieldKey={field.key}
            spec={field.spec}
            path={joinPath(path, field.key)}
            dataPath={joinPath(dataPath, field.key)}
            value={value[field.key]}
            parent={value}
            onChange={(next) => set(field.key, next)}
          />
        ))}
    </div>
  );
}

/** Variants: the discriminator as a choice, then the chosen variant's own settings. */
function VariantFields({ id, label, help, spec, path, dataPath, value, onChange }: {
  id: string;
  label?: string;
  help?: string;
  spec: VariantsSpec;
  path: string;
  dataPath: string;
  value: unknown;
  onChange: (value: Values) => void;
}) {
  const labels = useLabels();
  const option = variantOf(spec, value);
  const keyPath = joinPath(path, spec.key);
  const name = label ?? labels.label(keyPath, spec.key);
  const note = help ?? labels.help(keyPath);
  const rest: ObjectSpec = { ...option.spec, fields: option.spec.fields.filter((field) => field.key !== spec.key) };
  return (
    <div className="space-y-4">
      <Field id={id} label={name} help={note ? note : undefined}>
        <SearchableSelect
          id={id}
          value={option.value}
          options={spec.options.map((each) => ({ value: each.value, label: labels.value(keyPath, each.value) }))}
          onValueChange={(next) => {
            if (next !== option.value) onChange(switchVariant(spec, value, next));
          }}
          triggerClassName="w-full"
        />
      </Field>
      {rest.fields.length > 0 ? (
        <ObjectFields spec={rest} path={path} dataPath={dataPath} value={(value ?? {}) as Values} onChange={onChange} />
      ) : null}
    </div>
  );
}

export interface SchemaSettingsFormProps {
  /** Starts every field id; unique on the page (`theme-section-hero`). */
  idPrefix: string;
  scope: LabelScope;
  spec: SettingSpec;
  value: Values;
  onChange: (value: Values) => void;
  /** Messages by data path (`slides.0.alt`; `""` for the whole value). */
  errors?: ReadonlyMap<string, string>;
  /** Controls for single paths the generic ones cannot draw (`slides`). */
  widgets?: Readonly<Record<string, SettingWidget>>;
  /** Shows a setting only when its siblings call for it. */
  visible?: (path: string, parent: Values) => boolean;
  media: MediaPreviews;
  /** Where the value sits in its settings, when it is one item of a list (`slides`, with `slides.2`): labels and errors follow it. */
  rootPath?: string;
  rootDataPath?: string;
}

const NO_ERRORS: ReadonlyMap<string, string> = new Map();

export function SchemaSettingsForm({ idPrefix, scope, spec, value, onChange, errors = NO_ERRORS, widgets = {}, visible, media, rootPath = "", rootDataPath = "" }: SchemaSettingsFormProps) {
  return (
    <Context.Provider value={{ idPrefix, scope, errors, widgets, visible, media }}>
      <SettingValue spec={spec} path={rootPath} dataPath={rootDataPath} value={value} onChange={(next) => onChange(next as Values)} />
    </Context.Provider>
  );
}
