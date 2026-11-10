// Plugin settings (packages/plugin-sdk/docs/apps.md): the merchant-facing settings a
// plugin declares in its manifest. The dashboard renders the form from this
// schema (no plugin JavaScript), the API validates every write with it, and
// `secret` values are encrypted at rest and decrypted only inside the plugin
// bridge. Part of the versioned plugin API.

import { z } from "zod";
import { PLUGIN_KEY_PATTERN, PLUGIN_KEY_RULE, PLUGIN_URL_NAME_PATTERN, PLUGIN_URL_NAME_RULE } from "./manifest-patterns";

export const PLUGIN_SETTING_TYPES = [
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "secret",
  "url",
  "email",
  "color",
  // Storefront component settings only (sections, blocks and skins an app's storefront
  // module draws): the storefront resolves them before the component renders.
  "image",
  "products",
  "product",
  "link",
  "list",
] as const;
export type PluginSettingType = (typeof PLUGIN_SETTING_TYPES)[number];

/**
 * Types only a storefront component's settings may use (`storefront.sections`
 * drawn by the storefront module, `storefront.components` and `storefront.skins`;
 * skins and components name no images or products). A component gets
 * them resolved: an image as its URLs and size, a product source as its
 * products' cards, a link as a safe href, a list as its items.
 */
export const PLUGIN_STOREFRONT_SETTING_TYPES = ["image", "products", "product", "link", "list"] as const satisfies readonly PluginSettingType[];
export type PluginStorefrontSettingType = (typeof PLUGIN_STOREFRONT_SETTING_TYPES)[number];

/** The most items one `list` setting holds. */
export const PLUGIN_SETTING_LIST_MAX = 24;
/** The most products one `products` setting shows. */
export const PLUGIN_SETTING_PRODUCTS_MAX = 36;

/** A media library id (an `image` setting's value). */
export const PLUGIN_MEDIA_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** A product id (a `product` setting's value). */
export const PLUGIN_PRODUCT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A product source (a `products` setting's value), as the theme names one:
 * `newest`, `on-sale`, `popular`, `collection:<id>` or `category:<id>`.
 */
export const PLUGIN_PRODUCT_SOURCE = /^(?:newest|on-sale|popular|(?:collection|category):[A-Za-z0-9_-]{1,64})$/;
/** A same-store path (`/collections/new`) or an https URL (a `link` setting's value). */
export const PLUGIN_LINK = /^(?:\/(?!\/)[^\s]*|https:\/\/[^\s]+)$/;

/** A setting key: snake_case (the manifest's key rule), unique per plugin. */
export const PLUGIN_SETTING_KEY = PLUGIN_KEY_PATTERN;

const label = z.string().trim().min(1).max(80);
const help = z.string().trim().min(1).max(280).optional();
const choice = z.object({ value: z.string().min(1).max(64), label }).strict();

/**
 * A settings group (snake_case) or a provider id (snake_case or
 * kebab-case: it is a URL path segment): `manifest.admin.settingsGroups[].id`,
 * `manifest.providers.*[].id`.
 */
export const PLUGIN_SETTING_GROUP = PLUGIN_URL_NAME_PATTERN;

const base = {
  key: z.string().regex(PLUGIN_SETTING_KEY, PLUGIN_KEY_RULE),
  label,
  help,
  required: z.boolean().default(false),
  /**
   * An app setting the app's storefront components may read
   * (`context.app.settings`, in the page's language): a price to show, a
   * policy link. App settings only (`manifest.settings`), never a secret or a
   * storefront-only type. The value is public: anyone can read the page.
   */
  public: z.boolean().optional(),
  /**
   * Where the dashboard shows the field: one of the manifest's
   * `settingsGroups` (an app-wide section), or one of its provider ids (the
   * field is that provider's, shown with it where the merchant sets the
   * provider up). Left out: the app's general settings, or the provider whose
   * `settings` names it. Presentation only; storage and validation ignore it.
   */
  group: z.string().regex(PLUGIN_SETTING_GROUP, PLUGIN_URL_NAME_RULE).optional(),
};

/**
 * Buyer-facing text the merchant enters per store language (an app setting
 * only): the settings form shows one field per language, and buyers read it
 * in theirs (`localizePluginSettingValues`).
 */
const translatable = z.boolean().optional();
const textField = z.object({ ...base, type: z.literal("text"), default: z.string().max(500).optional(), maxLength: z.number().int().min(1).max(500).default(200), translatable }).strict();
const textareaField = z.object({ ...base, type: z.literal("textarea"), default: z.string().max(5000).optional(), maxLength: z.number().int().min(1).max(5000).default(2000), translatable }).strict();
const numberField = z.object({
  ...base,
  type: z.literal("number"),
  default: z.number().finite().optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  integer: z.boolean().default(false),
}).strict();
const booleanField = z.object({ ...base, type: z.literal("boolean"), default: z.boolean().default(false) }).strict();
const selectField = z.object({ ...base, type: z.literal("select"), options: z.array(choice).min(1).max(50), default: z.string().optional() }).strict();
const urlField = z.object({ ...base, type: z.literal("url"), default: z.string().url().optional() }).strict();
const colorField = z.object({ ...base, type: z.literal("color"), default: z.string().regex(/^#[0-9a-f]{6}$/).optional() }).strict();
/** A media library image; the component gets its URLs, size and alt text. */
const imageField = z.object({ ...base, type: z.literal("image") }).strict();
/** One product the merchant picks; the component gets its card (null once it is gone or not public). */
const productField = z.object({ ...base, type: z.literal("product") }).strict();
/** A same-store path or an https link. */
const linkField = z.object({ ...base, type: z.literal("link"), default: z.string().max(2048).regex(PLUGIN_LINK).optional() }).strict();
/** Where products come from; the component gets up to `limit` product cards. */
const productsField = z.object({
  ...base,
  type: z.literal("products"),
  default: z.string().regex(PLUGIN_PRODUCT_SOURCE).optional(),
  limit: z.number().int().min(1).max(PLUGIN_SETTING_PRODUCTS_MAX).default(8),
}).strict();

/** The fields one item of a `list` setting has (no lists in lists, no products). */
export const pluginSettingItemFieldSchema = z.discriminatedUnion("type", [
  textField,
  textareaField,
  numberField,
  booleanField,
  selectField,
  urlField,
  colorField,
  imageField,
  linkField,
]);
export type PluginSettingItemField = z.infer<typeof pluginSettingItemFieldSchema>;

/** Repeatable items (slides, quotes, questions), each with the same fields. */
const listField = z.object({
  ...base,
  type: z.literal("list"),
  fields: z.array(pluginSettingItemFieldSchema).min(1).max(12),
  /** What one item is called in the editor ("Slide"). */
  itemLabel: label.optional(),
  min: z.number().int().min(0).max(PLUGIN_SETTING_LIST_MAX).default(0),
  max: z.number().int().min(1).max(PLUGIN_SETTING_LIST_MAX).default(12),
}).strict().superRefine((field, context) => {
  const seen = new Set<string>();
  field.fields.forEach((item, index) => {
    if (seen.has(item.key)) context.addIssue({ code: "custom", path: ["fields", index, "key"], message: `Duplicate item field ${item.key}.` });
    seen.add(item.key);
  });
  if (field.min > field.max) context.addIssue({ code: "custom", path: ["min"], message: "min must not exceed max." });
});

export const pluginSettingFieldSchema = z.discriminatedUnion("type", [
  textField,
  textareaField,
  numberField,
  booleanField,
  selectField,
  z.object({ ...base, type: z.literal("multiselect"), options: z.array(choice).min(1).max(50), default: z.array(z.string()).optional() }).strict(),
  // Never echoed back: reads report only whether a value is set.
  z.object({ ...base, type: z.literal("secret") }).strict(),
  urlField,
  z.object({ ...base, type: z.literal("email"), default: z.string().email().optional() }).strict(),
  colorField,
  imageField,
  productsField,
  productField,
  linkField,
  listField,
]);
export type PluginSettingField = z.infer<typeof pluginSettingFieldSchema>;

/** The most fields one storefront section, block or skin declares. */
export const PLUGIN_SURFACE_SETTINGS_MAX = 40;
/**
 * The most fields of an app's own settings: a pack with many features (each
 * service with its own keys) declares more than one section does.
 */
export const PLUGIN_APP_SETTINGS_MAX = 80;

const settingsArray = (max: number) => z
  .array(pluginSettingFieldSchema)
  .max(max)
  .superRefine((fields, context) => {
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (seen.has(field.key)) context.addIssue({ code: "custom", path: [index, "key"], message: `Duplicate setting key ${field.key}.` });
      seen.add(field.key);
      if ((field.type === "select" || field.type === "multiselect") && field.default !== undefined) {
        const values = new Set(field.options.map((option) => option.value));
        const defaults = Array.isArray(field.default) ? field.default : [field.default];
        if (!defaults.every((value) => values.has(value))) {
          context.addIssue({ code: "custom", path: [index, "default"], message: "The default must be one of the options." });
        }
      }
      if (field.type === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) {
        context.addIssue({ code: "custom", path: [index, "min"], message: "min must not exceed max." });
      }
    });
  });
export const pluginSettingsSchemaSchema = settingsArray(PLUGIN_SURFACE_SETTINGS_MAX);
/** An app's own settings (`manifest.settings`). */
export const pluginAppSettingsSchemaSchema = settingsArray(PLUGIN_APP_SETTINGS_MAX);
export type PluginSettingsSchema = z.infer<typeof pluginSettingsSchemaSchema>;

/** One item of a `list` setting: its fields' values by key. */
export type PluginSettingItem = Record<string, string | number | boolean | null>;
export type PluginSettingValue = string | number | boolean | string[] | PluginSettingItem[] | null;
export type PluginSettingValues = Record<string, PluginSettingValue>;

/** One `list` item: each declared field's value (an unset optional field is null or absent). */
function itemSchema(fields: readonly PluginSettingItemField[]): z.ZodType<PluginSettingItem> {
  const shape: Record<string, z.ZodType> = {};
  for (const field of fields) {
    const value = valueSchema(field) as z.ZodType;
    shape[field.key] = field.required ? value : z.union([value, z.null(), z.literal("")]).optional();
  }
  return z.object(shape).strict() as unknown as z.ZodType<PluginSettingItem>;
}

/** The zod schema of one field's value (null clears an optional field). */
function valueSchema(field: PluginSettingField | PluginSettingItemField): z.ZodType<PluginSettingValue> {
  switch (field.type) {
    case "text":
    case "textarea":
      return z.string().max(field.maxLength);
    case "secret":
      return z.string().min(1).max(4096);
    case "number": {
      let number = z.number().finite();
      if (field.integer) number = number.int();
      if (field.min !== undefined) number = number.min(field.min);
      if (field.max !== undefined) number = number.max(field.max);
      return number;
    }
    case "boolean":
      return z.boolean();
    case "select":
      return z.enum(field.options.map((option) => option.value) as [string, ...string[]]);
    case "multiselect":
      return z.array(z.enum(field.options.map((option) => option.value) as [string, ...string[]])).max(field.options.length);
    case "url":
      return z.string().url().max(2048).refine((value) => value.startsWith("https://"), "Use an https:// address.");
    case "email":
      return z.string().email().max(254);
    case "color":
      return z.string().regex(/^#[0-9a-f]{6}$/);
    case "image":
      return z.string().regex(PLUGIN_MEDIA_ID);
    case "products":
      return z.union([z.string().regex(PLUGIN_PRODUCT_SOURCE), z.array(z.string().regex(PLUGIN_PRODUCT_ID)).max(PLUGIN_SETTING_PRODUCTS_MAX)]);
    case "product":
      return z.string().regex(PLUGIN_PRODUCT_ID);
    case "link":
      return z.string().max(2048).regex(PLUGIN_LINK, "Use a store path (/…) or an https:// link.");
    case "list":
      return z.array(itemSchema(field.fields)).min(field.min).max(field.max);
  }
}

/**
 * Validates a settings write against the schema: unknown keys are rejected,
 * required fields must end up set (an omitted secret keeps its stored value,
 * which `secretsSet` reports), and `null` clears an optional field.
 */
export function validatePluginSettingValues(
  schema: PluginSettingsSchema,
  values: Record<string, unknown>,
  secretsSet: ReadonlySet<string> = new Set(),
): { ok: true; values: PluginSettingValues } | { ok: false; errors: Array<{ key: string; message: string }> } {
  const errors: Array<{ key: string; message: string }> = [];
  const byKey = new Map(schema.map((field) => [field.key, field]));
  for (const key of Object.keys(values)) {
    if (!byKey.has(key)) errors.push({ key, message: "Unknown setting." });
  }
  const result: PluginSettingValues = {};
  for (const field of schema) {
    const raw = values[field.key];
    if (raw === undefined || raw === null || raw === "") {
      const keptSecret = field.type === "secret" && raw === undefined && secretsSet.has(field.key);
      if (field.required && !keptSecret) errors.push({ key: field.key, message: "Required." });
      if (raw === null || raw === "") result[field.key] = null;
      continue;
    }
    const parsed = valueSchema(field).safeParse(raw);
    if (parsed.success) result[field.key] = parsed.data;
    else errors.push({ key: field.key, message: parsed.error.issues[0]?.message ?? "Invalid value." });
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, values: result };
}

/**
 * Stored values read against the schema as it is now (the app may have been
 * updated since they were saved): every valid value is kept, an unknown key
 * is dropped, a value never set or no longer valid falls back to the field's
 * default, `null` stays cleared (absent) and an empty text stays empty.
 * Never fails; secrets are never resolved.
 */
export function resolvePluginSettingValues(schema: PluginSettingsSchema, stored: unknown): PluginSettingValues {
  const values = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored as Record<string, unknown> : {};
  const result: PluginSettingValues = {};
  for (const field of schema) {
    if (field.type === "secret") continue;
    const fallback = "default" in field && field.default !== undefined ? field.default : undefined;
    if (!Object.prototype.hasOwnProperty.call(values, field.key) || values[field.key] === undefined) {
      if (fallback !== undefined) result[field.key] = fallback;
      continue;
    }
    const raw = values[field.key];
    if (raw === null) continue;
    if (raw === "" && (field.type === "text" || field.type === "textarea")) {
      result[field.key] = "";
      continue;
    }
    const parsed = valueSchema(field).safeParse(raw);
    if (parsed.success) result[field.key] = parsed.data;
    else if (fallback !== undefined) result[field.key] = fallback;
  }
  return result;
}

/**
 * Stored storefront values with their buyer words translated: each `text` and
 * `textarea` setting, and those fields of `list` items, through `text`, kept
 * only within the field's `maxLength`. Everything else stays as stored; the
 * same object comes back when nothing changes.
 */
export function translatePluginSettingValues(schema: PluginSettingsSchema, stored: unknown, text: (source: string) => string): unknown {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return stored;
  const values = stored as Record<string, unknown>;
  const words = (field: { type: string; maxLength?: number }, value: unknown): unknown => {
    if ((field.type !== "text" && field.type !== "textarea") || typeof value !== "string" || value === "") return value;
    const translated = text(value);
    return translated.length <= (field.maxLength ?? Number.POSITIVE_INFINITY) ? translated : value;
  };
  let next: Record<string, unknown> | null = null;
  for (const field of schema) {
    const value = values[field.key];
    let translated: unknown = value;
    if (field.type === "list" && Array.isArray(value)) {
      const items = value.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
        let changed: Record<string, unknown> | null = null;
        for (const itemField of field.fields) {
          const entry = (item as Record<string, unknown>)[itemField.key];
          const result = words(itemField, entry);
          if (result !== entry) (changed ??= { ...item })[itemField.key] = result;
        }
        return changed ?? item;
      });
      if (items.some((item, index) => item !== value[index])) translated = items;
    } else {
      translated = words(field, value);
    }
    if (translated !== value) (next ??= { ...values })[field.key] = translated;
  }
  return next ?? stored;
}

/** Defaults for a fresh installation (secrets have none). */
export function pluginSettingDefaults(schema: PluginSettingsSchema): PluginSettingValues {
  const values: PluginSettingValues = {};
  for (const field of schema) {
    if (field.type !== "secret" && "default" in field && field.default !== undefined) values[field.key] = field.default;
  }
  return values;
}

// ── Translatable settings ────────────────────────────────────────────────

/**
 * Where a translatable setting's other languages are kept in the stored
 * settings document: `{ "$translations": { "<locale>": { "<key>": text } } }`.
 * No setting key can be named so (keys start with a letter), and every reader
 * of values drops it (`resolvePluginSettingValues` reads declared keys only).
 * The setting's own value is its text in the store's default language.
 */
export const PLUGIN_SETTING_TRANSLATIONS_KEY = "$translations";
/** A store language code (`store_languages`): two lower-case letters. */
const SETTING_LOCALE = /^[a-z]{2}$/;
/** The most languages one app's settings are kept in (the store's language limit). */
export const PLUGIN_SETTING_TRANSLATION_LOCALES_MAX = 20;
/** Text by store language, then setting key. */
export type PluginSettingTranslations = Record<string, Record<string, string>>;

type TranslatableField = Extract<PluginSettingField, { type: "text" | "textarea" }>;
function translatableFields(schema: readonly PluginSettingField[]): Map<string, TranslatableField> {
  return new Map(schema.filter((field): field is TranslatableField => (field.type === "text" || field.type === "textarea") && field.translatable === true).map((field) => [field.key, field]));
}

/**
 * Checks a merchant's translations against the schema: only translatable
 * settings, store language codes, each text within its field's `maxLength`;
 * an empty or null text is dropped (that language falls back). The result is
 * what is stored.
 */
export function validatePluginSettingTranslations(
  schema: readonly PluginSettingField[],
  input: unknown,
): { ok: true; translations: PluginSettingTranslations } | { ok: false; errors: Array<{ key: string; message: string }> } {
  const fields = translatableFields(schema);
  const errors: Array<{ key: string; message: string }> = [];
  const translations: PluginSettingTranslations = {};
  if (input === undefined || input === null) return { ok: true, translations };
  if (typeof input !== "object" || Array.isArray(input)) return { ok: false, errors: [{ key: PLUGIN_SETTING_TRANSLATIONS_KEY, message: "Translations are text by language, then setting." }] };
  const locales = Object.entries(input as Record<string, unknown>);
  if (locales.length > PLUGIN_SETTING_TRANSLATION_LOCALES_MAX) errors.push({ key: PLUGIN_SETTING_TRANSLATIONS_KEY, message: `At most ${PLUGIN_SETTING_TRANSLATION_LOCALES_MAX} languages.` });
  for (const [locale, texts] of locales.slice(0, PLUGIN_SETTING_TRANSLATION_LOCALES_MAX)) {
    if (!SETTING_LOCALE.test(locale)) { errors.push({ key: locale, message: "Use a store language code such as bn." }); continue; }
    if (typeof texts !== "object" || texts === null || Array.isArray(texts)) { errors.push({ key: locale, message: "Text by setting key." }); continue; }
    for (const [key, text] of Object.entries(texts as Record<string, unknown>)) {
      const field = fields.get(key);
      if (!field) { errors.push({ key, message: "This setting is not translatable." }); continue; }
      if (text === null || text === undefined || text === "") continue;
      if (typeof text !== "string") { errors.push({ key, message: "Text only." }); continue; }
      if (text.length > field.maxLength) { errors.push({ key, message: `At most ${field.maxLength} characters.` }); continue; }
      (translations[locale] ??= {})[key] = text;
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, translations };
}

/**
 * The stored translations read against the schema as it is now: a setting
 * no longer translatable, a text past its field's limit or a malformed entry
 * is left out. Never fails.
 */
export function storedPluginSettingTranslations(schema: readonly PluginSettingField[], stored: unknown): PluginSettingTranslations {
  const raw = typeof stored === "object" && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)[PLUGIN_SETTING_TRANSLATIONS_KEY]
    : undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const fields = translatableFields(schema);
  const translations: PluginSettingTranslations = {};
  for (const [locale, texts] of Object.entries(raw as Record<string, unknown>).slice(0, PLUGIN_SETTING_TRANSLATION_LOCALES_MAX)) {
    if (!SETTING_LOCALE.test(locale) || typeof texts !== "object" || texts === null || Array.isArray(texts)) continue;
    for (const [key, text] of Object.entries(texts as Record<string, unknown>)) {
      const field = fields.get(key);
      if (field && typeof text === "string" && text.trim() !== "" && text.length <= field.maxLength) (translations[locale] ??= {})[key] = text;
    }
  }
  return translations;
}

/** Where a reader reads translatable settings: the page's (or staff member's) language and the store's default. */
export interface PluginSettingLanguage {
  locale: string;
  defaultLocale: string;
}

/**
 * Values with each translatable setting in the reader's language, through
 * the store's one fallback chain (`translationChain()`'s order): the
 * reader's language, then the store's default, then the setting's own value
 * (the text the merchant entered for the default language). An empty
 * translation falls through, so a partial translation never shows a blank.
 * Every other value is unchanged; without translatable settings the same
 * object comes back.
 */
export function localizePluginSettingValues(
  schema: readonly PluginSettingField[],
  values: PluginSettingValues,
  stored: unknown,
  language: PluginSettingLanguage | null,
): PluginSettingValues {
  if (!language) return values;
  const fields = translatableFields(schema);
  if (fields.size === 0) return values;
  const translations = storedPluginSettingTranslations(schema, stored);
  const chain = [...new Set([language.locale, language.defaultLocale].map((locale) => locale.trim().toLowerCase().split("-")[0]!))];
  let next: PluginSettingValues | null = null;
  for (const key of fields.keys()) {
    const text = chain.map((locale) => translations[locale]?.[key]).find((entry) => entry !== undefined);
    if (text !== undefined && text !== values[key]) (next ??= { ...values })[key] = text;
  }
  return next ?? values;
}

/**
 * The settings an app's storefront components read (`context.app.settings`):
 * its `public` settings, defaults filled, in the page's language. Never a
 * secret (the manifest refuses a public one) and never a storefront-only type.
 */
export function pluginPublicSettingValues(
  schema: readonly PluginSettingField[],
  stored: unknown,
  language: PluginSettingLanguage | null,
): Record<string, string | number | boolean | string[] | null> {
  const fields = schema.filter((field) => field.public === true && field.type !== "secret");
  if (fields.length === 0) return {};
  const values = localizePluginSettingValues(schema, resolvePluginSettingValues(fields as PluginSettingsSchema, stored), stored, language);
  const result: Record<string, string | number | boolean | string[] | null> = {};
  for (const field of fields) {
    const value = values[field.key];
    result[field.key] = typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      || (Array.isArray(value) && value.every((item) => typeof item === "string")) ? value as string | number | boolean | string[] : null;
  }
  return result;
}
