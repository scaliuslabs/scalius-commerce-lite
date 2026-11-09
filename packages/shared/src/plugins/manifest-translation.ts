// An app's manifest words in one language (`translations.<tag>`, keyed by
// BCP 47 tag; English is the manifest itself). Apart from ./manifest-text,
// which reads a buyer's chain of languages, so a reader of one language (the
// dashboard's navigation) loads nothing else.
import type { PluginTranslation } from "./manifest";

export type PluginTranslations = Readonly<Record<string, PluginTranslation>> | null | undefined;

/** The translation of one language: its exact tag (`pt-BR`), else its language (`pt`). None for English or a language the app lacks. */
export function pluginTranslationFor(translations: PluginTranslations, language: string | null | undefined): PluginTranslation | null {
  if (!translations || !language) return null;
  const wanted = language.toLowerCase();
  const tags = Object.keys(translations);
  const exact = tags.find((tag) => tag.toLowerCase() === wanted);
  if (exact) return translations[exact] ?? null;
  const base = wanted.split("-")[0]!;
  const tag = tags.find((each) => each.toLowerCase() === base);
  return tag ? translations[tag] ?? null : null;
}
