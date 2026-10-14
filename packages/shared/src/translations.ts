/**
 * Translations (docs/MARKETS-DESIGN.md D9, "Step 4b implemented").
 *
 * - The store's languages are one list (`store_languages`): the default
 *   language is the backup market's root presence locale; a presence names a
 *   store language, and only published languages are served.
 * - A translation is one row per resource, locale and (optional) market
 *   holding the translated fields as JSON (Medusa's `Translation`, Shopify's
 *   `marketId`). Localized URL handles are rows of `localized_slugs`, unique
 *   per resource type, locale and slug.
 * - Every buyer-facing read resolves a field with one fallback chain
 *   (Vendure): the page's locale in its market, the page's locale, the store
 *   default locale in the market, the store default locale, then the source
 *   value. A field that is empty falls through, so a partial translation
 *   never shows a blank.
 * - Each translation keeps the digest of the source text it was made from
 *   (Shopify's `translatableContentDigest`), per field: a source edit makes
 *   the field Outdated until it is translated again. Outdated text is still
 *   served, as Shopify does.
 *
 * Browser-safe and free of I/O: the dashboard editor, the API and the
 * storefront share it.
 */
import { HANDLE_MAX_LENGTH, HANDLE_PATTERN } from "./handle";
import { MARKET_LOCALE_PATTERN, isMarketSubfolder } from "./markets";

/** A store language: an ISO 639-1 code, the same grammar as a presence locale. */
export const STORE_LOCALE_PATTERN = MARKET_LOCALE_PATTERN;
/** Shopify's limit of published languages per store. */
export const MAX_STORE_LANGUAGES = 20;

export function isStoreLocale(value: unknown): value is string {
  return typeof value === "string" && STORE_LOCALE_PATTERN.test(value);
}

/** The locale of a subfolder presence (`bn-bd` → `bn`); null for the root or a malformed value. */
export function presenceLocale(presence: string | null | undefined): string | null {
  return isMarketSubfolder(presence) ? presence.slice(0, 2) : null;
}

// ---------------------------------------------------------------------------
// Translatable resources
// ---------------------------------------------------------------------------

/** How a field's text is edited and checked. */
export type TranslatableFieldKind = "line" | "text" | "html";

export interface TranslatableFieldSpec {
  readonly key: string;
  readonly kind: TranslatableFieldKind;
  readonly max: number;
}

export interface TranslatableResourceSpec {
  /**
   * Shopify's order of what to translate first: 1 products and their parts,
   * 2 collections, categories and brands, 3 pages and articles, 4 menus,
   * 5 delivery and payment methods. Store policies are pages (3).
   */
  readonly group: 1 | 2 | 3 | 4 | 5;
  readonly fields: readonly TranslatableFieldSpec[];
  /** The resource has a URL handle that can be localized (`localized_slugs`). */
  readonly slug: boolean;
  /**
   * Per-item fields named `<prefix><item id>` (a menu's links), besides the
   * fixed fields.
   */
  readonly itemFields?: { readonly prefix: string; readonly kind: TranslatableFieldKind; readonly max: number };
  /**
   * The resource whose cache key a translation advances: a SKU, an option
   * and an option value show on their product's page and cards.
   */
  readonly owner?: "product";
}

const line = (key: string, max = 255): TranslatableFieldSpec => ({ key, kind: "line", max });
const text = (key: string, max = 2_000): TranslatableFieldSpec => ({ key, kind: "text", max });
const html = (key: string, max = 200_000): TranslatableFieldSpec => ({ key, kind: "html", max });
const SEO = [line("metaTitle"), text("metaDescription", 1_000)] as const;

export const TRANSLATABLE_RESOURCES = {
  product: { group: 1, slug: true, fields: [line("name"), html("description"), ...SEO] },
  product_variant: { group: 1, slug: false, owner: "product", fields: [text("preorderMessage", 500)] },
  product_option: { group: 1, slug: false, owner: "product", fields: [line("name", 100)] },
  product_option_value: { group: 1, slug: false, owner: "product", fields: [line("value", 100)] },
  collection: { group: 2, slug: false, fields: [line("name"), text("description"), html("content"), ...SEO] },
  category: { group: 2, slug: true, fields: [line("name"), text("description"), html("content"), ...SEO] },
  brand: { group: 2, slug: true, fields: [line("name"), text("description"), ...SEO] },
  page: { group: 3, slug: true, fields: [line("title"), html("content"), text("excerpt"), ...SEO] },
  menu: { group: 4, slug: false, fields: [line("title", 120)], itemFields: { prefix: "item:", kind: "line", max: 120 } },
  shipping_method: { group: 5, slug: false, fields: [line("name", 100), text("description", 500), text("pickupHours", 500)] },
  payment_method: { group: 5, slug: false, fields: [line("name", 100), text("description", 500)] },
} as const satisfies Record<string, TranslatableResourceSpec>;

export type TranslatableResourceType = keyof typeof TRANSLATABLE_RESOURCES;
export const TRANSLATABLE_RESOURCE_TYPES = Object.keys(TRANSLATABLE_RESOURCES) as TranslatableResourceType[];

/** Resource types whose URL handle can be localized. */
export const SLUGGED_RESOURCE_TYPES = TRANSLATABLE_RESOURCE_TYPES.filter((type) => TRANSLATABLE_RESOURCES[type].slug) as Array<
  "product" | "category" | "brand" | "page"
>;
export type SluggedResourceType = (typeof SLUGGED_RESOURCE_TYPES)[number];

export function isSluggedResourceType(value: unknown): value is SluggedResourceType {
  return (SLUGGED_RESOURCE_TYPES as readonly unknown[]).includes(value);
}

/** The field spec of a key, or null when the resource has no such field. */
export function translatableField(type: TranslatableResourceType, key: string): TranslatableFieldSpec | null {
  const spec: TranslatableResourceSpec = TRANSLATABLE_RESOURCES[type];
  const fixed = spec.fields.find((field) => field.key === key);
  if (fixed) return fixed;
  const items = spec.itemFields;
  if (items && key.startsWith(items.prefix) && /^[A-Za-z0-9_-]{1,64}$/.test(key.slice(items.prefix.length))) {
    return { key, kind: items.kind, max: items.max };
  }
  return null;
}

/** At most this many fields per translation (a menu's links included). */
export const MAX_TRANSLATION_FIELDS = 200;

export type TranslationFields = Record<string, string>;

export type TranslationFieldIssue =
  | { field: string; code: "unknown_field" }
  | { field: string; code: "too_long"; max: number }
  | { field: string; code: "not_text" };

/**
 * The issues of a translation's fields: an unknown field, a value that is not
 * text or longer than its limit. An empty value is allowed (it clears the
 * field, which then falls back).
 */
export function translationFieldIssues(type: TranslatableResourceType, fields: Record<string, unknown>): TranslationFieldIssue[] {
  const issues: TranslationFieldIssue[] = [];
  for (const [field, value] of Object.entries(fields)) {
    const spec = translatableField(type, field);
    if (!spec) issues.push({ field, code: "unknown_field" });
    else if (typeof value !== "string") issues.push({ field, code: "not_text" });
    else if (value.length > spec.max) issues.push({ field, code: "too_long", max: spec.max });
  }
  return issues;
}

/** The fields worth storing: trimmed lines, without empty values. */
export function normalizeTranslationFields(type: TranslatableResourceType, fields: Record<string, string>): TranslationFields {
  const normalized: TranslationFields = {};
  for (const [key, value] of Object.entries(fields)) {
    const spec = translatableField(type, key);
    if (!spec) continue;
    const next = spec.kind === "line" ? value.trim() : value;
    if (next.trim() !== "") normalized[key] = next;
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// Localized URL handles
// ---------------------------------------------------------------------------

/** A localized handle has the grammar of every handle (`/products/<handle>`): ASCII words joined by dashes. */
export function isLocalizedSlug(value: unknown): value is string {
  return typeof value === "string" && value.length <= HANDLE_MAX_LENGTH && HANDLE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Source digests: Outdated markers
// ---------------------------------------------------------------------------

/**
 * A short, stable digest of one source text (53-bit cyrb53 as 14 hex digits).
 * It only tells "the source changed" apart from "it did not": no secret, no
 * collision resistance needed.
 */
export function sourceTextDigest(value: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value53 = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value53.toString(16).padStart(14, "0");
}

/** The source values a translation is made from: field → text (null: the source has none). */
export type TranslationSource = Record<string, string | null | undefined>;

/**
 * The `source_digest` a translation stores: each translated field's source
 * digest, as JSON with sorted keys (`{"description":"…","name":"…"}`).
 */
export function translationSourceDigest(source: TranslationSource, fields: Iterable<string>): string {
  const digests: Record<string, string> = {};
  for (const field of [...new Set(fields)].sort()) digests[field] = sourceTextDigest(source[field] ?? "");
  return JSON.stringify(digests);
}

function parseDigest(stored: string | null | undefined): Record<string, string> {
  if (!stored) return {};
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return {};
  }
}

/**
 * The translated fields whose source changed since they were translated
 * (Shopify's Outdated), in the translation's field order. A field translated
 * without a recorded digest counts as Outdated.
 */
export function outdatedTranslationFields(
  translated: TranslationFields,
  storedDigest: string | null | undefined,
  source: TranslationSource,
): string[] {
  const digests = parseDigest(storedDigest);
  return Object.keys(translated).filter((field) => digests[field] !== sourceTextDigest(source[field] ?? ""));
}

// ---------------------------------------------------------------------------
// The fallback resolver
// ---------------------------------------------------------------------------

/** One stored translation as a read sees it. */
export interface TranslationRow {
  locale: string;
  /** The market it is specific to; null: every market. */
  marketId: string | null;
  fields: TranslationFields;
}

/** Where a page is: its locale, its market, and the store default locale. */
export interface TranslationContext {
  locale: string;
  marketId: string | null;
  defaultLocale: string;
}

/**
 * The rows of a resource in fallback order (Vendure's chain, with Shopify's
 * market-specific rows first): the page's locale in its market, the page's
 * locale, the default locale in the market, the default locale.
 */
export function translationChain(rows: readonly TranslationRow[], context: TranslationContext): TranslationRow[] {
  const locales = context.locale === context.defaultLocale ? [context.locale] : [context.locale, context.defaultLocale];
  const chain: TranslationRow[] = [];
  for (const locale of locales) {
    if (context.marketId) {
      const own = rows.find((row) => row.locale === locale && row.marketId === context.marketId);
      if (own) chain.push(own);
    }
    const shared = rows.find((row) => row.locale === locale && row.marketId === null);
    if (shared) chain.push(shared);
  }
  return chain;
}

/** One field through the chain: the first non-empty translation, else the source value. */
export function resolveTranslatedField<T>(chain: readonly TranslationRow[], field: string, source: T): T | string {
  for (const row of chain) {
    const value = row.fields[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return source;
}

/**
 * The record with each translatable field of `keys` resolved through the
 * chain. Without a translated field the record is returned as it is (the
 * same object), so an untranslated read keeps its bytes.
 */
export function resolveTranslatedRecord<T extends object>(
  record: T,
  chain: readonly TranslationRow[],
  keys: readonly string[],
): T {
  if (chain.length === 0) return record;
  let next: T | null = null;
  for (const key of keys) {
    const current = (record as Record<string, unknown>)[key];
    const resolved = resolveTranslatedField(chain, key, current);
    if (resolved !== current) {
      next ??= { ...record };
      (next as Record<string, unknown>)[key] = resolved;
    }
  }
  return next ?? record;
}

/** Parses a stored `fields` JSON object (text values only); malformed input reads as no fields. */
export function parseTranslationFields(value: unknown): TranslationFields {
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

// ---------------------------------------------------------------------------
// Machine translation (the `translation` provider port)
// ---------------------------------------------------------------------------

