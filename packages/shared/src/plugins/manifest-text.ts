// An app's manifest words in a reader's language (`translations.<tag>`,
// keyed by BCP 47 tag; English is the manifest itself). The dashboard reads
// one language, the staff member's; a buyer's page reads them through
// `translationChain()`: the page's language, then the store's default, then
// the manifest. Each word falls through on its own, so a partial translation
// never shows a blank. Browser-safe and free of I/O: the API (checkout), the
// storefront layout and the dashboard share it.
import { translationChain } from "../translations";
import { lineInputTextRevision } from "../line-properties";
import type { PluginTranslation } from "./manifest";
import { pluginTranslationFor, type PluginTranslations } from "./manifest-translation";

// One language's lookup lives apart, so the dashboard shell (app names in the
// navigation) does not load the buyer-page chain and its translation rules.
export { pluginTranslationFor, type PluginTranslations } from "./manifest-translation";

/** Where a buyer reads an app's words: the page's language and the store's default (`translationChain()`'s locales). */
export interface PluginTextContext {
  locale: string;
  defaultLocale: string;
}

/**
 * The translations a buyer's page reads, first to last: the page's language,
 * then the store's default (`translationChain()`). Empty when the app has
 * neither: every word is the manifest's.
 */
export function pluginTextChain(translations: PluginTranslations, context: PluginTextContext): PluginTranslation[] {
  if (!translations) return [];
  const rows = translationChain(
    [...new Set([context.locale, context.defaultLocale])].map((locale) => ({ locale, marketId: null, fields: {} })),
    { locale: context.locale, marketId: null, defaultLocale: context.defaultLocale },
  );
  return rows.map((row) => pluginTranslationFor(translations, row.locale)).filter((text): text is PluginTranslation => text !== null);
}

/** The first non-empty word of the chain, else the manifest's. */
function word(chain: readonly PluginTranslation[], read: (text: PluginTranslation) => string | undefined, source: string): string {
  for (const text of chain) {
    const value = read(text);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return source;
}

/** Translated text by key inside one translation; `hasOwn` so a key named like a prototype member reads nothing. */
function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** An app's name (manifest `name`) in the chain's language. */
export function localizedAppName(name: string, chain: readonly PluginTranslation[]): string {
  return word(chain, (text) => text.name, name);
}

type LineInputWords = {
  key: string; label: string; help?: string;
  options?: ReadonlyArray<{ value: string; label: string; confirm?: { text: string; title?: string; agree?: string } }>;
  bulk?: { apply?: { label: string; value?: string }; clear?: { label: string } };
  textRevision?: string;
};

/**
 * An app's line inputs (`checkout.lineInputs`) in the chain's language:
 * label, help, option labels, a choice's confirmation (text, title, tick
 * box) and the bulk actions' labels. An input with a choice that needs
 * confirmation gets the revision of its words as this reader sees them
 * (`lineInputTextRevision`), which the answer to that choice must carry.
 */
export function localizedLineInputs<T extends LineInputWords>(
  inputs: readonly T[],
  chain: readonly PluginTranslation[],
): T[] {
  const localized = chain.length === 0 ? [...inputs] : inputs.map((input) => {
    const text = (each: PluginTranslation) => own(each.checkout?.lineInputs, input.key);
    const confirmText = (each: PluginTranslation, value: string) => own(text(each)?.confirm, value);
    return {
      ...input,
      label: word(chain, (each) => text(each)?.label, input.label),
      ...(input.help !== undefined ? { help: word(chain, (each) => text(each)?.help, input.help) } : {}),
      ...(input.options ? {
        options: input.options.map((option) => ({
          ...option,
          label: word(chain, (each) => own(text(each)?.options, option.value), option.label),
          ...(option.confirm ? {
            confirm: {
              text: word(chain, (each) => confirmText(each, option.value)?.text, option.confirm.text),
              ...(option.confirm.title !== undefined ? { title: word(chain, (each) => confirmText(each, option.value)?.title, option.confirm.title) } : {}),
              ...(option.confirm.agree !== undefined ? { agree: word(chain, (each) => confirmText(each, option.value)?.agree, option.confirm.agree) } : {}),
            },
          } : {}),
        })),
      } : {}),
      ...(input.bulk ? {
        bulk: {
          ...(input.bulk.apply ? { apply: { ...input.bulk.apply, label: word(chain, (each) => text(each)?.bulk?.apply, input.bulk.apply.label) } } : {}),
          ...(input.bulk.clear ? { clear: { label: word(chain, (each) => text(each)?.bulk?.clear, input.bulk.clear.label) } } : {}),
        },
      } : {}),
    };
  });
  return localized.map((input) => (input.options?.some((option) => option.confirm) ? { ...input, textRevision: lineInputTextRevision(input) } : input));
}

/** An app's checkout attributes (`checkout.attributes`) in the chain's language: label, help and choice labels. */
export function localizedCheckoutAttributes<T extends { key: string; label: string; help?: string; choices?: ReadonlyArray<{ value: string; label: string }> }>(
  fields: readonly T[],
  chain: readonly PluginTranslation[],
): T[] {
  if (chain.length === 0) return [...fields];
  return fields.map((field) => {
    const text = (each: PluginTranslation) => own(each.checkout?.attributes, field.key);
    return {
      ...field,
      label: word(chain, (each) => text(each)?.label, field.label),
      ...(field.help !== undefined ? { help: word(chain, (each) => text(each)?.help, field.help) } : {}),
      ...(field.choices ? { choices: field.choices.map((choice) => ({ ...choice, label: word(chain, (each) => own(text(each)?.choices, choice.value), choice.label) })) } : {}),
    };
  });
}

/** An app's purchase options (`checkout.purchaseOptions`) in the chain's language: title and description. */
export function localizedPurchaseOptions<T extends { key: string; title: string; description?: string }>(
  options: readonly T[],
  chain: readonly PluginTranslation[],
): T[] {
  if (chain.length === 0) return [...options];
  return options.map((option) => {
    const text = (each: PluginTranslation) => own(each.checkout?.purchaseOptions, option.key);
    return {
      ...option,
      title: word(chain, (each) => text(each)?.title, option.title),
      ...(option.description !== undefined ? { description: word(chain, (each) => text(each)?.description, option.description) } : {}),
    };
  });
}

/** An app object type's name, description and field names in one translation (the dashboard's language). */
export function localizedObjectType<T extends { type: string; name: string; description: string | null; fields: ReadonlyArray<{ key: string; name: string; description?: string | null }> }>(
  objectType: T,
  text: PluginTranslation | null,
): T {
  const typeText = text ? own(text.objects, objectType.type) : undefined;
  if (!typeText) return objectType;
  return {
    ...objectType,
    name: typeText.name ?? objectType.name,
    description: objectType.description ? typeText.description ?? objectType.description : objectType.description,
    fields: objectType.fields.map((field) => {
      const fieldText = own(typeText.fields, field.key);
      return fieldText ? { ...field, name: fieldText.name ?? field.name, ...(field.description ? { description: fieldText.description ?? field.description } : {}) } : field;
    }),
  };
}

/** An app custom field's name and description in one translation (the dashboard's language). */
export function localizedCustomField<T extends { ownerType: string; key: string; name: string; description?: string | null }>(field: T, text: PluginTranslation | null): T {
  const fieldText = text ? own(own(text.customFields, field.ownerType), field.key) : undefined;
  if (!fieldText) return field;
  return { ...field, name: fieldText.name ?? field.name, ...(field.description ? { description: fieldText.description ?? field.description } : {}) };
}
