import { trimTrailingCharacter } from "@scalius/shared/text-scan";
// Translate & adapt (docs/MARKETS-DESIGN.md D9): the editor's rows, drafts and
// save bodies, kept free of React so tests read them directly.
import { translatableField, type TranslatableResourceType } from "@scalius/shared/translations";
import type { BadgeVariant } from "~/components/ui/badge";
import type { ResourceTranslationsView, SaveTranslationBody, TranslatableResource, TranslationEditorType } from "~/lib/api-query-options/translations";
import { sameFormValue } from "~/lib/form-values";

/** Common ISO 639-1 languages, the choices of "Add language" (named in the dashboard's language). */
export const LANGUAGE_CODES = [
  "af", "am", "ar", "as", "az", "be", "bg", "bn", "bs", "ca", "cs", "cy", "da", "de", "el", "en", "es", "et",
  "eu", "fa", "fi", "fr", "ga", "gl", "gu", "ha", "he", "hi", "hr", "hu", "hy", "id", "ig", "is", "it",
  "ja", "jv", "ka", "kk", "km", "kn", "ko", "ky", "lo", "lt", "lv", "mk", "ml", "mn", "mr", "ms", "my", "ne",
  "nl", "no", "or", "pa", "pl", "ps", "pt", "ro", "ru", "si", "sk", "sl", "so", "sq", "sr", "sv", "sw", "ta",
  "te", "tg", "th", "tk", "tr", "uk", "ur", "uz", "vi", "xh", "yo", "zh", "zu",
].filter((code) => code.length === 2);

/** A language's name in the dashboard's language ("Bangla" / "বাংলা"), else its code. */
export function languageName(locale: string, uiLocale: string): string {
  try {
    const name = new Intl.DisplayNames([uiLocale], { type: "language" }).of(locale);
    return name && name !== locale ? name : locale.toUpperCase();
  } catch {
    return locale.toUpperCase();
  }
}

/** The language's own name ("বাংলা" for bn), for a second line. */
export function nativeLanguageName(locale: string): string {
  return languageName(locale, locale);
}

export const TYPE_LABEL_KEYS: Record<TranslationEditorType, string> = {
  product: "typeProduct",
  collection: "typeCollection",
  category: "typeCategory",
  brand: "typeBrand",
  page: "typePage",
  menu: "typeMenu",
  shipping_method: "typeShippingMethod",
  payment_method: "typePaymentMethod",
};

/** The type's web address (a resource with a localized handle). */
export function resourcePath(type: string, handle: string, contentType?: string | null): string | null {
  if (type === "product") return `/products/${handle}`;
  if (type === "category") return `/categories/${handle}`;
  if (type === "brand") return `/brands/${handle}`;
  if (type === "page") return contentType === "article" ? `/blog/${handle}` : `/${handle}`;
  return null;
}

export const STATUS_BADGE: Record<TranslatableResource["status"], { variant: BadgeVariant; key: string }> = {
  translated: { variant: "success", key: "statusTranslated" },
  outdated: { variant: "warning", key: "statusOutdated" },
  partial: { variant: "attention", key: "statusPartial" },
  untranslated: { variant: "secondary", key: "statusUntranslated" },
};

/** One translatable field of the editor: the resource or part it belongs to, its source and its draft. */
export interface TranslationRow {
  /** `<type>:<id>`: the entry the field is saved with. */
  entry: string;
  type: TranslatableResourceType;
  id: string;
  field: string;
  kind: "line" | "text" | "html";
  max: number;
  source: string;
  outdated: boolean;
  /** Which label: a fixed field, a menu link, an option or a value. */
  label: { key: string; vars?: Record<string, string> };
}

const FIELD_ORDER = ["name", "title", "value", "description", "excerpt", "content", "pickupHours", "preorderMessage", "metaTitle", "metaDescription"];

function fieldRank(field: string): number {
  const index = FIELD_ORDER.indexOf(field);
  return index === -1 ? FIELD_ORDER.length : index;
}

function rowsOf(resource: TranslatableResource, labelOf: (field: string) => TranslationRow["label"]): TranslationRow[] {
  const type = resource.type as TranslatableResourceType;
  return Object.entries(resource.source)
    .flatMap(([field, value]) => {
      const spec = translatableField(type, field);
      if (!spec) return [];
      // A field without source text has nothing to translate (an empty description).
      if (typeof value !== "string" || value.trim() === "") return [];
      return [{
        entry: `${type}:${resource.id}`,
        type,
        id: resource.id,
        field,
        kind: spec.kind,
        max: spec.max,
        source: value,
        outdated: resource.translation?.outdated.includes(field) ?? false,
        label: labelOf(field),
      }];
    })
    .sort((left, right) => fieldRank(left.field) - fieldRank(right.field));
}

/** Every row of the editor: the resource's fields, then a product's options and their values. */
export function translationRows(view: ResourceTranslationsView): TranslationRow[] {
  const own = rowsOf(view.resource, (field) => field.startsWith("item:")
    ? { key: "menuLink", vars: { label: view.resource.source[field] ?? "" } }
    : { key: `field_${field}` });
  const options = view.parts.filter((part) => part.type === "product_option");
  const values = view.parts.filter((part) => part.type === "product_option_value");
  const parts = options.flatMap((option) => [
    ...rowsOf(option, () => ({ key: "optionName", vars: { name: option.title } })),
    ...values
      .filter((value) => value.subtitle === option.id)
      .flatMap((value) => rowsOf(value, () => ({ key: "optionValue", vars: { value: value.title } }))),
  ]);
  return [...own, ...parts];
}

/** The draft key of a row. */
export const draftKey = (row: Pick<TranslationRow, "entry" | "field">) => `${row.entry}\u0000${row.field}`;

/** The saved translation of every row, as the editor's draft. */
export function initialDraft(view: ResourceTranslationsView): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const resource of [view.resource, ...view.parts]) {
    for (const [field, value] of Object.entries(resource.translation?.fields ?? {})) {
      draft[`${resource.type}:${resource.id}\u0000${field}`] = value;
    }
  }
  return draft;
}

/**
 * The save body: the resource's fields (and, for a product, every option and
 * value with its fields, an empty one deleting its translation), its handle.
 */
export function saveBody(
  view: ResourceTranslationsView,
  draft: Record<string, string>,
  context: { locale: string; marketId: string | null; slug: string | null },
): SaveTranslationBody {
  const fieldsOf = (resource: TranslatableResource) => {
    const fields: Record<string, string> = {};
    for (const key of Object.keys(resource.source)) {
      const value = draft[`${resource.type}:${resource.id}\u0000${key}`];
      if (typeof value === "string" && value.trim() !== "") fields[key] = value;
    }
    return fields;
  };
  const partsChanged = view.parts.filter((part) => {
    const next = fieldsOf(part);
    const saved = part.translation?.fields ?? {};
    return !sameFormValue(next, Object.fromEntries(Object.entries(saved).filter(([, value]) => value.trim() !== "")));
  });
  return {
    locale: context.locale,
    marketId: context.marketId,
    fields: fieldsOf(view.resource),
    sourceDigest: view.resource.sourceDigest,
    revision: view.resource.revision,
    ...(view.resource.sourceSlug !== null && !context.marketId ? { slug: context.slug ?? "" } : {}),
    ...(partsChanged.length > 0
      ? { parts: partsChanged.map((part) => ({ type: part.type as "product_option" | "product_option_value", id: part.id, fields: fieldsOf(part), sourceDigest: part.sourceDigest, revision: part.revision })) }
      : {}),
  };
}

/** Whether the draft differs from what is saved. */
export function isDirty(view: ResourceTranslationsView, draft: Record<string, string>, slug: string | null): boolean {
  const saved = initialDraft(view);
  const keys = new Set([...Object.keys(saved), ...Object.keys(draft)]);
  for (const key of keys) if ((saved[key] ?? "").trim() !== (draft[key] ?? "").trim()) return true;
  return (view.resource.slug ?? "") !== (slug ?? "");
}

/** What the merchant edits: each field's translation (by `draftKey`) and the translated web address. */
export interface TranslationDraft {
  fields: Record<string, string>;
  slug: string;
}

/** The saved state of a view, as a draft. */
export function translationDraftOf(view: ResourceTranslationsView): TranslationDraft {
  return { fields: initialDraft(view), slug: view.resource.slug ?? "" };
}

/**
 * Makes `saved` the editor's saved state without losing work: a field the
 * merchant changed since `before` (the saved state they started from, or what
 * a save sent while they kept typing) keeps the edit; every other field takes
 * its saved value. An empty field and a missing one mean the same.
 */
export function rebaseTranslationDraft(before: TranslationDraft, current: TranslationDraft, saved: TranslationDraft): TranslationDraft {
  const fields: Record<string, string> = {};
  for (const key of new Set([...Object.keys(saved.fields), ...Object.keys(current.fields), ...Object.keys(before.fields)])) {
    const edited = (current.fields[key] ?? "") !== (before.fields[key] ?? "");
    const value = edited ? current.fields[key] ?? "" : saved.fields[key] ?? "";
    if (value !== "") fields[key] = value;
  }
  return { fields, slug: current.slug !== before.slug ? current.slug : saved.slug };
}

/**
 * A save response may already show a newer source or another writer. Retained
 * in-flight edits keep their observed source and our transaction's revision;
 * untouched resources adopt the response the merchant is now seeing.
 */
export function rebaseTranslationObservation(
  before: TranslationDraft,
  current: TranslationDraft,
  observed: ResourceTranslationsView,
  saved: ResourceTranslationsView,
): ResourceTranslationsView {
  const oldResources = [observed.resource, ...observed.parts];
  const retain = (resource: TranslatableResource): TranslatableResource => {
    const old = oldResources.find((entry) => entry.type === resource.type && entry.id === resource.id);
    if (!old) return resource;
    const prefix = `${resource.type}:${resource.id}\u0000`;
    const fields = new Set([...Object.keys(before.fields), ...Object.keys(current.fields)]);
    const changed = [...fields].filter((key) => key.startsWith(prefix) && (current.fields[key] ?? "") !== (before.fields[key] ?? ""));
    const changedSlug = resource.type === saved.resource.type && resource.id === saved.resource.id && current.slug !== before.slug;
    if (changed.length === 0 && !changedSlug) return resource;
    // A resource is saved as a complete set of fields. Even its unchanged
    // translation values may have become outdated after our commit.
    return { ...resource, source: old.source, sourceDigest: old.sourceDigest,
      revision: resource.committedRevision !== undefined ? resource.committedRevision : old.revision };
  };
  return { ...saved, resource: retain(saved.resource), parts: saved.parts.map(retain) };
}

/**
 * Whether a Translate & adapt navigation keeps the open draft on screen: list
 * paging and search do; another item, kind, language or market opens another
 * draft, so leaving with edits asks first.
 */
export function translationNavigationKeepsDraft(
  current: { pathname: string; search: unknown },
  next: { pathname: string; search: unknown },
): boolean {
  if (trimTrailingCharacter(current.pathname, "/") !== trimTrailingCharacter(next.pathname, "/")) return false;
  const editorOf = (search: unknown) => {
    const value = (search ?? {}) as Record<string, unknown>;
    return [value.type ?? "product", value.id ?? "", value.locale ?? "", value.market ?? ""].map(String).join("\u0000");
  };
  return editorOf(current.search) === editorOf(next.search);
}
