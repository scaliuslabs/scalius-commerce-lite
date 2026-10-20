// Translatable theme text (../storefront-theme.md, "Compatibility"): which
// settings hold buyer words, and the document's `translations`. A row is
// shaped like the store's translations (`translations` table, one per locale
// and market), but keyed by the source words themselves: a translation
// follows its words through moves, duplicates and template switches, and an
// edited source shows itself until it is translated again. translate.ts
// applies them.

import { z } from "zod";
import { STORE_LOCALE_PATTERN } from "../translations";
import type { StorefrontSectionType } from "./sections";

/**
 * Each section type's buyer words, as settings paths (`*`: every item of a
 * list). A path that a layout does not have is skipped. Ids, links and
 * choices are never text.
 */
export const STOREFRONT_SECTION_TEXT = {
  hero: ["slides.*.alt", "slides.*.heading", "slides.*.text", "slides.*.buttonLabel", "sideBanners.*.alt"],
  "usp_strip": ["source.items.*.title", "source.items.*.detail"],
  "category_tiles": ["title"],
  collections: ["title"],
  "product_rail": ["title"],
  "product_grid": ["title"],
  "deal_block": ["title"],
  "product_tabs": ["title", "tabs.*.label"],
  "shop_by": ["title", "cards.*.title", "cards.*.subtitle"],
  "banner_mosaic": ["tiles.*.alt"],
  lookbook: ["title"],
  banner: ["heading", "text", "cta.label"],
  "brand_wall": ["title"],
  editorial: ["heading", "body", "columns.*.title", "columns.*.text", "quotes.*.quote", "quotes.*.author"],
  specifications: ["heading", "rows.*.label", "rows.*.value"],
  faq: ["heading", "items.*.question", "items.*.answer"],
  "utility_cards": ["cards.*.title", "cards.*.text"],
  "endless_grid": ["title"],
  "seo_text": ["heading", "body"],
  "recently_viewed": ["title"],
  objects: ["heading"],
  newsletter: ["heading", "text", "buttonLabel"],
} as const satisfies Record<StorefrontSectionType, readonly string[]>;

/** The announcement's and the footer's words (`blocks.<slot>.settings.<key>`). */
export const STOREFRONT_BLOCK_TEXT = {
  topBar: ["text"],
  footer: ["tagline", "about", "copyright"],
} as const;

/** A landing page's words (`pages.landing.<slug>.<key>`). */
export const STOREFRONT_LANDING_TEXT = ["title", "description"] as const;

export const STOREFRONT_THEME_TRANSLATION_LIMITS = {
  /** Rows: a store's 20 languages, each for every market and for one more. */
  rows: 40,
  /** Translated words per row. */
  fields: 2_000,
  /** One source text or translation (the longest setting, `seo_text` body, is 8,000). */
  text: 8_000,
} as const;

/** One language's (and optionally one market's) translations of the theme's words, keyed by the source words. */
export const storefrontThemeTranslationSchema = z.object({
  /** A store language (`store_languages`): served only at presences of that language while it is published. */
  locale: z.string().regex(STORE_LOCALE_PATTERN),
  /** A market-specific translation; null serves every market. */
  marketId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).nullable(),
  fields: z.record(
    z.string().min(1).max(STOREFRONT_THEME_TRANSLATION_LIMITS.text),
    z.string().max(STOREFRONT_THEME_TRANSLATION_LIMITS.text),
  ).refine((fields) => Object.keys(fields).length <= STOREFRONT_THEME_TRANSLATION_LIMITS.fields, `At most ${STOREFRONT_THEME_TRANSLATION_LIMITS.fields} translated texts per language.`),
}).strict();
export type StorefrontThemeTranslation = z.infer<typeof storefrontThemeTranslationSchema>;

/** The document's translations: one row per locale and market. */
export const storefrontThemeTranslationsSchema = z.array(storefrontThemeTranslationSchema)
  .max(STOREFRONT_THEME_TRANSLATION_LIMITS.rows)
  .refine((rows) => new Set(rows.map((row) => `${row.locale}:${row.marketId ?? ""}`)).size === rows.length, "One row per language and market.");
