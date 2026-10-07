// Translate & adapt (docs/MARKETS-DESIGN.md D9): the editor's rows, drafts and
// save bodies, kept free of React so tests read them directly.
import { translatableField, type TranslatableResourceType } from "@scalius/shared/translations";
import type { BadgeVariant } from "~/components/ui/badge";
import type { ResourceTranslationsView, SaveTranslationBody, TranslatableResource, TranslationEditorType } from "~/lib/api-query-options/translations";

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
    return JSON.stringify(next) !== JSON.stringify(Object.fromEntries(Object.entries(saved).filter(([, value]) => value.trim() !== "")));
  });
  return {
    locale: context.locale,
    marketId: context.marketId,
    fields: fieldsOf(view.resource),
    ...(view.resource.sourceSlug !== null && !context.marketId ? { slug: context.slug ?? "" } : {}),
    ...(partsChanged.length > 0
      ? { parts: partsChanged.map((part) => ({ type: part.type as "product_option" | "product_option_value", id: part.id, fields: fieldsOf(part) })) }
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
