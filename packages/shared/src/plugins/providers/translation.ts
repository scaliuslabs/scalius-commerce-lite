// The translation port (docs/MARKETS-DESIGN.md D9, "Step 4b implemented"):
// machine translation of a resource's source text into a store language. The
// platform has no built-in provider; an app provides one (`translate`). The
// translation editor sends a resource's fields and fills the target
// language with the answer for the merchant to review: nothing is saved
// until the merchant saves, so a provider never writes the store.

import { z } from "zod";

const localeSchema = z.string().regex(/^[a-z]{2}$/, "An ISO 639-1 language code, lower case.");

export const translationTranslateInputSchema = z.object({
  /** The source text's language: the store default language. */
  sourceLocale: localeSchema,
  targetLocale: localeSchema,
  /** At most 100 texts; `key` names the field the answer fills. */
  texts: z.array(z.object({
    key: z.string().min(1).max(80),
    text: z.string().max(200_000),
    /** `html`: keep the markup and translate the text between tags. */
    format: z.enum(["text", "html"]),
  }).strict()).min(1).max(100),
}).strict();

export const translationTranslateOutputSchema = z.object({
  /** One answer per text the provider translated (by `key`); a text left out keeps no translation. */
  texts: z.array(z.object({
    key: z.string().min(1).max(80),
    text: z.string().max(400_000),
  }).strict()).max(100),
}).strict();

export const TRANSLATION_PORT = {
  translate: { input: translationTranslateInputSchema, output: translationTranslateOutputSchema },
} as const;

export type TranslationTranslateInput = z.infer<typeof translationTranslateInputSchema>;
export type TranslationTranslateOutput = z.infer<typeof translationTranslateOutputSchema>;
