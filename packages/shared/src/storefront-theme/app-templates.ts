// Templates installed apps offer (`storefront.templates` of a manifest): a
// ready-made look the template library applies in one step, like a built-in
// template. A template may set the tokens, any blocks, the slots apps fill
// and the homepage sections; the merchant's brand, landing pages, page
// templates and other content stay. The API lists only templates that parse
// against the live document schema, and the applied document is checked
// whole (contrast included) when it is saved, so an app can never write a
// theme the storefront cannot draw.

import { z } from "zod";
import { storefrontThemeAppsSchema } from "./apps";
import { storefrontThemeBlocksSchema } from "./blocks";
import { storefrontSectionListSchema, type StorefrontSection } from "./sections";
import { storefrontThemeTokensSchema } from "./tokens";
import type { StorefrontThemeDocument } from "./document";

export const storefrontAppTemplateThemeSchema = z.object({
  tokens: storefrontThemeTokensSchema.optional(),
  blocks: storefrontThemeBlocksSchema.partial().optional(),
  apps: storefrontThemeAppsSchema.omit({ template: true }).optional(),
  /** The homepage sections. */
  sections: storefrontSectionListSchema.optional(),
}).strict();
export type StorefrontAppTemplateTheme = z.infer<typeof storefrontAppTemplateThemeSchema>;

/** The template's theme, or null when it does not parse against this document version. */
export function readStorefrontAppTemplateTheme(value: unknown): StorefrontAppTemplateTheme | null {
  const parsed = storefrontAppTemplateThemeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The document with an app template applied: its tokens, blocks and slots
 * replace the document's, its sections become the homepage's, and the
 * document records the template it came from (`apps.template`). A homepage
 * section whose id the template reuses keeps the merchant's values.
 */
export function applyStorefrontAppTemplate(
  document: StorefrontThemeDocument,
  key: string,
  template: StorefrontAppTemplateTheme,
): StorefrontThemeDocument {
  const previous = new Map(document.pages.home.map((section) => [section.id, section]));
  const home = template.sections
    ? template.sections.map((section) => {
      const kept = previous.get(section.id);
      return kept && kept.type === section.type ? kept : section;
    })
    : document.pages.home;
  return {
    ...document,
    tokens: template.tokens ?? document.tokens,
    blocks: { ...document.blocks, ...(template.blocks ?? {}) },
    apps: { ...(template.apps ?? {}), template: key },
    pages: { ...document.pages, home },
  };
}

/**
 * A page preset's sections (`storefront.pagePresets`), or null when they do
 * not parse against this document version: what a new landing page starts with.
 */
export function readStorefrontPagePresetSections(value: unknown): StorefrontSection[] | null {
  const parsed = storefrontSectionListSchema.safeParse(value);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}
