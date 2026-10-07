// What the theme editor's bridge posts to the storefront's preview-only
// routes (storefront-theme.md, "Editor"): the editor's unsaved sections of
// one page (`render`) or its unsaved document (`paint`). Both are validated
// with the same schemas as a save, so the preview never draws anything a
// save would refuse.
import { z } from "zod";
import { MARKET_SUBFOLDER_PATTERN } from "../markets";
import { THEME_PREVIEW_MARK_PATTERN, THEME_PREVIEW_REGIONS, type ThemePreviewRegion } from "../theme-editor-bridge";
import { storefrontThemeDocumentSchema, type StorefrontThemeDocument, type StorefrontThemePages } from "./document";
import { STOREFRONT_PAGE_TEMPLATES, storefrontLandingSlugSchema } from "./pages";
import { STOREFRONT_MAX_SECTIONS, storefrontSectionListSchema, type StorefrontSection } from "./sections";

/** The page whose sections a render draws. */
export const storefrontPreviewScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("home") }).strict(),
  z.object({ kind: z.literal("landing"), slug: storefrontLandingSlugSchema }).strict(),
  z.object({
    kind: z.literal("template"),
    template: z.enum(STOREFRONT_PAGE_TEMPLATES),
    /** How many of the sections come before the fixed part. */
    main: z.number().int().min(0).max(STOREFRONT_MAX_SECTIONS),
  }).strict(),
]);
export type StorefrontPreviewScope = z.infer<typeof storefrontPreviewScopeSchema>;

export const storefrontPreviewRenderSchema = z.object({
  scope: storefrontPreviewScopeSchema,
  /** The page's sections as the editor has them now. */
  sections: storefrontSectionListSchema,
  /** Draw only the unit holding this section; otherwise every region of the page. */
  only: z.string().regex(THEME_PREVIEW_MARK_PATTERN).optional(),
  /** The region a new section joins (the bridge's fallback when it has no neighbour). */
  region: z.enum(THEME_PREVIEW_REGIONS).optional(),
  /** The previewed market presence (`en-in`); none: the root. */
  presence: z.string().regex(MARKET_SUBFOLDER_PATTERN).optional(),
}).strict().refine((body) => body.scope.kind !== "template" || body.scope.main <= body.sections.length, {
  path: ["scope", "main"],
  message: "The fixed part sits between the template's sections.",
});
export type StorefrontPreviewRender = z.infer<typeof storefrontPreviewRenderSchema>;

export const storefrontPreviewPaintSchema = z.object({ theme: storefrontThemeDocumentSchema }).strict();

/** The document with one page's sections replaced by the editor's (the rest as saved). */
export function storefrontThemeWithScope(
  theme: StorefrontThemeDocument,
  scope: StorefrontPreviewScope,
  sections: StorefrontSection[],
): StorefrontThemeDocument {
  const pages = theme.pages;
  switch (scope.kind) {
    case "home":
      return { ...theme, pages: { ...pages, home: sections } };
    case "landing": {
      const page = pages.landing[scope.slug] ?? { title: scope.slug, description: "", sections: [] };
      return { ...theme, pages: { ...pages, landing: { ...pages.landing, [scope.slug]: { ...page, sections } } } };
    }
    case "template":
      return { ...theme, pages: { ...pages, templates: { ...pages.templates, [scope.template]: { sections, main: scope.main } } } };
  }
}

/** The regions a scope shows, each with its (resolved) sections, in page order. */
export function storefrontScopeRegions(
  pages: StorefrontThemePages,
  scope: StorefrontPreviewScope,
): Array<{ region: ThemePreviewRegion; sections: StorefrontSection[] }> {
  switch (scope.kind) {
    case "home":
      return [{ region: "page", sections: pages.home }];
    case "landing":
      return [{ region: "page", sections: pages.landing[scope.slug]?.sections ?? [] }];
    case "template": {
      const template = pages.templates[scope.template];
      return [
        { region: "before", sections: template.sections.slice(0, template.main) },
        { region: "after", sections: template.sections.slice(template.main) },
      ];
    }
  }
}

