/**
 * The settings of an app's section, theme slot or product-page block, drawn
 * from the fields the app declares with the editor's own controls: text and
 * long text, numbers, switches, a choice, several choices, a web address, an
 * email address and a colour; and for what an app's storefront components
 * draw, an image from Files, a product, where products come from, a store
 * link and a list of items (each with the same controls). Labels, help and
 * option names are the app's plain text. Each field says what the app would
 * refuse as soon as it is there (app-settings.ts); a rejected save's message
 * takes its place.
 */
import { reindexSettingBindings } from "./dynamic-sources";
import { bindingSettingType, type SettingBindings } from "@scalius/shared/storefront-theme/bindings";
import { DynamicSourcePicker } from "./DynamicSourcePicker";
import { SettingBindingScope, useSettingBindings } from "./binding-context";
import { createContext, useContext, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ChevronDown, ImageIcon, Plus, Trash2 } from "lucide-react";
import { mediaImageUrl } from "@scalius/shared/media-variants";
import { cn } from "@scalius/shared/utils";
import { Button } from "~/components/ui/button";
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
import { themeSettingMessages } from "~/i18n/theme-settings";
import type { ThemeAppSettingField } from "~/lib/api-query-options/online-store";
import { productsByIdsQueryOptions } from "~/lib/api-query-options/products";
import {
  appFieldValue,
  appListItemDefaults,
  appListItemProblems,
  appSettingProblems,
  themeAppFields,
  withAppSettingValue,
  type AppSettingItem,
  type AppSettingProblem,
  type AppSettingValue,
  type AppSettingValues,
} from "./app-settings";
import { CategorySelect, CollectionSelect, LinkField, MediaField, ProductSelect, type MediaPreviews } from "./resource-fields";
import { moveAt, removeAt, replaceAt } from "./media-previews";
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
    case "products":
      return t(`appProblem_products_${problem.source}`);
    case "fewItems":
      return t("appProblem_fewItems", { min: problem.min });
    case "manyItems":
      return t("appProblem_manyItems", { max: problem.max });
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
const SOURCE_KINDS = ["newest", "on-sale", "popular", "collection", "category"] as const;

/**
 * Where a `products` setting's products come from, with the controls the
 * theme's own product sections use: a source, then its collection or
 * category. A collection or category not chosen yet is stored as
 * `collection:` (the field says to choose one; the save holds it back).
 */
function ProductSourceControl({ id, field, value, error, onChange }: {
  id: string;
  field: ThemeAppSettingField;
  value: string;
  error?: string;
  onChange: (value: string | null) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const labels = useMessages(themeSettingMessages);
  const [kind = "", record = ""] = value.split(":");
  const choosing = kind === "collection" || kind === "category";
  // An unchosen record's problem shows under its own control.
  const recordError = choosing && !record ? error : undefined;
  const help = field.help ?? (field.limit ? t("appProductsLimit", { count: field.limit }) : null);
  return (
    <div className="space-y-3">
      <Labelled id={id} field={{ ...field, help }} error={recordError ? undefined : error}>
        <SearchableSelect
          id={id}
          value={kind}
          placeholder={t("appChoose")}
          clearable={!field.required}
          options={SOURCE_KINDS.map((each) => ({ value: each, label: labels(`f.source.kind.${each}`) }))}
          onValueChange={(next) => onChange(next === "" ? null : next === "collection" || next === "category" ? `${next}:` : next)}
          triggerClassName="w-full"
          {...described(id, help, recordError ? undefined : error)}
        />
      </Labelled>
      {choosing ? (
        <Field id={`${id}-${kind}`} label={labels(kind === "collection" ? "f.source.collectionId" : "f.source.categoryId")} error={recordError} noteId={`${id}-${kind}-note`}>
          {kind === "collection" ? (
            <CollectionSelect id={`${id}-${kind}`} value={record} invalid={Boolean(recordError)} onChange={(next) => onChange(`collection:${next}`)} />
          ) : (
            <CategorySelect id={`${id}-${kind}`} value={record} invalid={Boolean(recordError)} onChange={(next) => onChange(`category:${next}`)} />
          )}
        </Field>
      ) : null}
    </div>
  );
}

/** One product: the catalogue search, with the chosen product's photo beside it. */
function ProductControl({ id, field, value, error, onChange }: {
  id: string;
  field: ThemeAppSettingField;
  value: string;
  error?: string;
  onChange: (value: string | null) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const lookup = useQuery({ ...productsByIdsQueryOptions(value ? [value] : []), enabled: Boolean(value) });
  const product = lookup.data?.products.find((each) => each.id === value);
  const gone = Boolean(value) && lookup.isSuccess && !lookup.isPlaceholderData && !product;
  return (
    <Labelled id={id} field={field} error={error}>
      <div className="flex items-center gap-2">
        {/* The photo's box is there before a product is, so choosing one never moves the select. */}
        <span className="grid size-11 shrink-0 place-items-center overflow-clip rounded-lg border bg-muted sm:size-9">
          {product?.primaryImage ? (
            <img src={mediaImageUrl(product.primaryImage, 96)} alt="" className="size-full object-cover" />
          ) : (
            <ImageIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <ProductSelect
            id={id}
            value={value}
            name={product?.name ?? (gone ? t("appProductUnavailable") : undefined)}
            clearable={!field.required}
            invalid={Boolean(error)}
            onChange={(next) => onChange(next === "" ? null : next)}
          />
        </div>
      </div>
    </Labelled>
  );
}

/** Keys that follow each item through moves, so its open state and focus go with it. */
function useItemKeys(count: number) {
  const made = useRef(0);
  const keys = useRef<string[]>([]);
  const fresh = () => `item-${made.current++}`;
  // A list changed elsewhere (undo, another person's save) starts its keys again.
  if (keys.current.length !== count) keys.current = Array.from({ length: count }, fresh);
  return {
    keys: keys.current,
    /** Applies the same change to the keys as to the items, before the items change. */
    update: (change: (keys: string[]) => string[]) => {
      keys.current = change(keys.current);
    },
    fresh,
  };
}

const focusSoon = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.focus());

/**
 * A `list` setting: its items in order, each a disclosure titled by its
 * first text (or "Slide 2"), with move and remove buttons; Alt+↑/↓ on an
 * item's title moves it too. Add and remove keep within the app's minimum
 * and maximum.
 */
function ListControl({ id, field, value, error, media, onChange }: {
  id: string;
  field: ThemeAppSettingField;
  value: unknown;
  error?: string;
  media: MediaPreviews;
  onChange: (value: AppSettingItem[]) => void;
}) {
  const t = useMessages(themeEditorMessages);
  const labels = useMessages(themeSettingMessages);
  const items = Array.isArray(value) ? (value as AppSettingItem[]) : [];
  const { keys, update, fresh } = useItemKeys(items.length);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const bindingPrefix = useContext(AppBindingPath);
  const bindings = useSettingBindings();
  const listPath = bindingPrefix ? `${bindingPrefix}.${field.key}` : field.key;
  const itemFields = field.fields ?? [];
  const min = field.min ?? 0;
  const max = field.max ?? Number.POSITIVE_INFINITY;
  const noun = field.itemLabel ?? t("appListItem");
  const titleField = itemFields.find((each) => each.type === "text");
  const nameOf = (item: AppSettingItem, index: number) => {
    const title = titleField ? item[titleField.key] : null;
    return typeof title === "string" && title.trim() ? title.trim() : t("appListItemName", { name: noun, number: index + 1 });
  };
  const toggleId = (key: string) => `${id}-${key}-toggle`;
  const move = (index: number, delta: -1 | 1, focus: string) => {
    const to = index + delta;
    if (to < 0 || to >= items.length) return;
    update((current) => moveAt(current, index, delta));
    onChange(moveAt(items, index, delta));
    if (bindings) bindings.onChange(reindexSettingBindings(bindings.bindings, listPath, index, to));
    focusSoon(focus);
  };
  const remove = (index: number) => {
    const next = keys[index + 1] ?? keys[index - 1];
    update((current) => removeAt(current, index));
    onChange(removeAt(items, index));
    if (bindings) bindings.onChange(reindexSettingBindings(bindings.bindings, listPath, index, null));
    // Focus stays in the list: the next item's title, else the one before, else Add.
    focusSoon(next ? toggleId(next) : `${id}-add`);
  };
  const add = () => {
    const key = fresh();
    update((current) => [...current, key]);
    setOpen((current) => new Set(current).add(key));
    onChange([...items, appListItemDefaults(field)]);
    focusSoon(toggleId(key));
  };
  const onTitleKey = (event: KeyboardEvent<HTMLButtonElement>, index: number, key: string) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
    event.preventDefault();
    move(index, event.key === "ArrowUp" ? -1 : 1, toggleId(key));
  };
  const full = items.length >= max;
  return (
    <fieldset id={id} aria-invalid={error ? true : undefined} aria-describedby={error || field.help ? `${id}-note` : undefined} className="min-w-0 space-y-2">
      <legend className="text-body font-medium">{field.label}</legend>
      {field.help && !error ? <p id={`${id}-note`} className="text-body text-muted-foreground">{field.help}</p> : null}
      {items.length > 0 ? (
        <ol className="space-y-2">
          {items.map((item, index) => {
            const key = keys[index]!;
            const expanded = open.has(key);
            const name = nameOf(item, index);
            const problems = appListItemProblems(field, item);
            const prefix = `${id}-${index}`;
            return (
              <li key={key} data-app-list-item={index} className="rounded-lg border border-border">
                <div className="flex items-center gap-1 pe-1">
                  <button
                    id={toggleId(key)}
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`${id}-${key}-body`}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onClick={() => setOpen((current) => {
                      const next = new Set(current);
                      if (!next.delete(key)) next.add(key);
                      return next;
                    })}
                    onKeyDown={(event) => onTitleKey(event, index, key)}
                    className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg ps-3 text-start text-body font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9"
                  >
                    <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground", expanded && "rotate-180")} aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{name}</span>
                    {problems.size > 0 ? <span className="shrink-0 font-normal text-destructive">{t("appListItemFix")}</span> : null}
                  </button>
                  <Button id={`${id}-${key}-up`} type="button" variant="ghost" size="icon-sm" aria-label={labels("form.moveUp", { name })} disabled={index === 0}
                    onClick={() => move(index, -1, index - 1 === 0 ? toggleId(key) : `${id}-${key}-up`)}>
                    <ArrowUp aria-hidden="true" />
                  </Button>
                  <Button id={`${id}-${key}-down`} type="button" variant="ghost" size="icon-sm" aria-label={labels("form.moveDown", { name })} disabled={index === items.length - 1}
                    onClick={() => move(index, 1, index + 1 === items.length - 1 ? toggleId(key) : `${id}-${key}-down`)}>
                    <ArrowDown aria-hidden="true" />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={labels("form.remove", { name })} disabled={items.length <= min} onClick={() => remove(index)}>
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
                {expanded ? (
                  <div id={`${id}-${key}-body`} className="space-y-4 border-t border-border px-3 py-3">
                    {itemFields.map((each) => {
                      const problem = problems.get(each.key);
                      return (
                        <AppBindingPath.Provider key={each.key} value={`${listPath}.${index}`}>
                        <AppSettingControl
                          id={appSettingFieldId(prefix, each.key)}
                          field={each}
                          // An item's fields take no defaults: it holds what it shows.
                          value={item[each.key]}
                          error={problem ? problemText(t, problem) : undefined}
                          media={media}
                          onChange={(next) => {
                            const changed: AppSettingItem = { ...item };
                            if (next === undefined || next === null) delete changed[each.key];
                            else changed[each.key] = next as AppSettingItem[string];
                            onChange(replaceAt(items, index, changed));
                          }}
                        />
                        </AppBindingPath.Provider>
                      );
                    })}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="text-body text-muted-foreground">{t("appListEmpty")}</p>
      )}
      {error ? <p id={`${id}-note`} role="alert" className="text-body text-destructive">{error}</p> : null}
      <Button id={`${id}-add`} type="button" variant="outline" size="sm" disabled={full} onClick={add}>
        <Plus aria-hidden="true" />
        {t("appListAdd", { name: noun })}
      </Button>
      {full && Number.isFinite(max) ? <p className="text-body text-muted-foreground">{t("appListMax", { count: max })}</p> : null}
    </fieldset>
  );
}

function AppSettingInput({ id, field, value, error, media, onChange }: {
  id: string;
  field: ThemeAppSettingField;
  value: unknown;
  error?: string;
  media: MediaPreviews;
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
    case "image":
      return (
        <MediaField
          id={id}
          label={field.label}
          optional={!field.required}
          help={field.help ?? undefined}
          mediaId={text || null}
          previews={media.previews}
          error={shown}
          onPick={(image) => {
            media.remember(image);
            set(image.id);
          }}
          onRemove={field.required ? undefined : () => set(null)}
        />
      );
    case "link":
      return (
        <LinkField
          id={id}
          label={field.label}
          optional={!field.required}
          help={field.help ?? undefined}
          value={text || null}
          error={shown}
          onChange={(link) => set(link)}
        />
      );
    case "products":
      return <ProductSourceControl id={id} field={field} value={text} error={shown} onChange={set} />;
    case "product":
      return <ProductControl id={id} field={field} value={text} error={shown} onChange={set} />;
    case "list":
      return <ListControl id={id} field={field} value={value} error={shown} media={media} onChange={set} />;
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

const AppBindingPath = createContext("");
function AppSettingControl(props: Parameters<typeof AppSettingInput>[0]) {
  const prefix = useContext(AppBindingPath);
  const path = prefix ? `${prefix}.${props.field.key}` : props.field.key;
  return <div className="space-y-1">
    <AppSettingInput {...props} />
    <DynamicSourcePicker id={props.id} path={path} type={bindingSettingType(props.field.type, props.field.key)} label={props.field.label} />
  </div>;
}

/**
 * Every setting of one app placement. `errors` (a rejected save's, by
 * setting key) take the place of each field's own problem.
 */
export function AppSettingFields({ idPrefix, fields, values, errors, media, onChange, bindings, onBindingsChange }: {
  /** Starts every field id; unique on the page. */
  idPrefix: string;
  fields: readonly ThemeAppSettingField[];
  values: AppSettingValues;
  errors?: ReadonlyMap<string, string>;
  /** Previews of the draft's images and this session's picks (`image` settings). */
  media: MediaPreviews;
  onChange: (values: AppSettingValues) => void;
  bindings?: SettingBindings;
  onBindingsChange?: (bindings: SettingBindings | undefined) => void;
}) {
  const own = useAppSettingErrors(fields, values);
  const content = (
    <div className="space-y-4">
      {themeAppFields(fields).map((field) => (
        <AppSettingControl
          key={field.key}
          id={appSettingFieldId(idPrefix, field.key)}
          field={field}
          value={appFieldValue(field, values)}
          error={errors?.get(field.key) ?? own.get(field.key)}
          media={media}
          onChange={(value) => onChange(withAppSettingValue(fields, values, field.key, value))}
        />
      ))}
    </div>
  );
  return onBindingsChange ? <SettingBindingScope bindings={bindings} onChange={onBindingsChange}>{content}</SettingBindingScope> : content;
}
