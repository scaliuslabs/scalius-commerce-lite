// The kinds of resource Translate & adapt lists (docs/MARKETS-DESIGN.md D9).
// Kept apart from the query options: the route's search check runs in the
// first download, which must not carry the translation API calls.

/** The types the editor lists (a product's options and values are edited with it). */
export const TRANSLATION_EDITOR_TYPES = [
  "product",
  "collection",
  "category",
  "brand",
  "page",
  "menu",
  "shipping_method",
  "payment_method",
] as const;
export type TranslationEditorType = (typeof TRANSLATION_EDITOR_TYPES)[number];

export function isTranslationEditorType(value: unknown): value is TranslationEditorType {
  return (TRANSLATION_EDITOR_TYPES as readonly unknown[]).includes(value);
}

/** The store's languages in the query cache, read by pages that must not carry the API call. */
export const STORE_LANGUAGES_QUERY_KEY = ["settings", "languages"] as const;

/** Translate & adapt's state in its URL. */
export interface TranslationsSearch {
  type?: TranslationEditorType;
  locale?: string;
  market?: string;
  id?: string;
  q?: string;
  page?: number;
}
