// Translations on the wire (docs/MARKETS-DESIGN.md D9).
import { z } from "@hono/zod-openapi";

/**
 * A resource's URL handles by language: present only when it has a
 * localized handle, so a single-language store's responses keep their bytes.
 */
export const localizedHandleFields = {
  localizedSlugs: z.record(z.string().length(2), z.string().max(100)).optional().openapi({
    description: "The resource's URL handle by language (ISO 639-1), where it has a localized one: its hreflang alternates. Absent without a localized handle.",
  }),
  sourceSlug: z.string().max(200).optional().openapi({
    description: "The resource's source URL handle (every language without its own), beside `localizedSlugs`.",
  }),
} as const;

// ── The dashboard: store languages ──────────────────────────────────────────

const localeParamSchema = z.string().regex(/^[a-z]{2}$/, "A two-letter language code (ISO 639-1), lower case.");

export const storeLanguageSchema = z.object({
  locale: z.string().length(2).openapi({ description: "ISO 639-1 language code." }),
  published: z.boolean().openapi({ description: "Only a published language's market web addresses are served." }),
  isDefault: z.boolean().openapi({ description: "The default language: the store's own URL (the backup market's root) and the source text." }),
  presences: z.array(z.string()).openapi({ description: "Market web addresses in this language (`en-in`; `''` is the store's own URL)." }),
  translatedResources: z.number().int().min(0).openapi({ description: "Resources with a translation in this language (any market)." }),
}).openapi("StoreLanguage");

export const createStoreLanguageSchema = z.object({
  locale: localeParamSchema,
  published: z.boolean().optional().openapi({ description: "Publish at once; default false (translate first, then publish)." }),
}).openapi("CreateStoreLanguage");

export const updateStoreLanguageSchema = z.object({
  published: z.boolean().optional(),
  isDefault: z.literal(true).optional().openapi({ description: "Make it the default language (the store's own URL); publishes it." }),
}).openapi("UpdateStoreLanguage");

export const storeLanguageLocaleParam = z.object({ locale: localeParamSchema });

// ── The dashboard: translations ─────────────────────────────────────────────

export const TRANSLATION_EDITOR_TYPES = [
  "product", "collection", "category", "brand", "page", "menu", "shipping_method", "payment_method",
] as const;
export const TRANSLATION_PART_TYPES = ["product_option", "product_option_value", "product_variant"] as const;

const translationFieldsSchema = z.record(z.string().max(120), z.string().max(200_000)).openapi({
  description: "Translated text by field (`name`, `description`, `metaTitle`; a menu's links as `item:<id>`). Fields left out or empty fall back to the source.",
});

export const translatableResourceSchema = z.object({
  type: z.string(),
  id: z.string(),
  title: z.string().openapi({ description: "The resource's source title." }),
  subtitle: z.string().nullable(),
  source: z.record(z.string(), z.string().nullable()).openapi({ description: "Source text by field." }),
  sourceSlug: z.string().nullable().openapi({ description: "The source URL handle (types with handles)." }),
  translation: z.object({
    locale: z.string(),
    marketId: z.string().nullable(),
    fields: z.record(z.string(), z.string()),
    outdated: z.array(z.string()).openapi({ description: "Translated fields whose source changed since (Outdated)." }),
    updatedAt: z.string().nullable(),
  }).nullable(),
  slug: z.string().nullable().openapi({ description: "The localized URL handle in this language, or null." }),
  status: z.enum(["translated", "outdated", "partial", "untranslated"]),
}).openapi("TranslatableResource");

export const translationContextQuerySchema = z.object({
  locale: localeParamSchema,
  marketId: z.string().min(1).max(64).optional().openapi({ description: "A market-specific translation (adapt); omit for every market." }),
});

export const listTranslatableResourcesQuerySchema = translationContextQuerySchema.extend({
  type: z.enum(TRANSLATION_EDITOR_TYPES),
  search: z.string().trim().max(120).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const translationEntrySchema = z.object({
  fields: translationFieldsSchema,
  slug: z.string().max(100).nullable().optional().openapi({ description: "The localized URL handle; empty or null keeps the source address. Every-market translations only." }),
});

export const saveTranslationSchema = translationEntrySchema.extend({
  locale: localeParamSchema,
  marketId: z.string().min(1).max(64).nullable().optional(),
  parts: z.array(translationEntrySchema.omit({ slug: true }).extend({
    type: z.enum(TRANSLATION_PART_TYPES),
    id: z.string().min(1).max(64),
  })).max(199).optional().openapi({ description: "A product's options and option values, saved with it." }),
}).openapi("SaveTranslation");

export const machineTranslateSchema = z.object({
  providerId: z.string().min(3).max(120).openapi({ description: "An installed app's translation provider (`<plugin id>:<provider id>`)." }),
  locale: localeParamSchema,
  texts: z.array(z.object({
    key: z.string().min(1).max(80),
    text: z.string().max(200_000),
    format: z.enum(["text", "html"]).default("text"),
  })).min(1).max(100),
}).openapi("MachineTranslate");
