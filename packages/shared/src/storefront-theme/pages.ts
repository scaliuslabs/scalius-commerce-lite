// Landing pages (section pages at `/pages/<slug>`) and page templates (the
// sections around the product, listing, cart and CMS pages' fixed parts),
// composed from the same section registry, draft, preview and publish as
// the homepage. A fixed part's own structure is the document's
// `blocks.product` and `blocks.listing` (modules, toolbar pieces, filters).
import { z } from "zod";
import { isValidResourceCanonicalPath } from "../seo-canonical";
import { STOREFRONT_MAX_SECTIONS, storefrontSectionListSchema } from "./sections";

export const STOREFRONT_MAX_LANDING_PAGES = 20;
export const STOREFRONT_LANDING_TITLE_MAX = 120;
export const STOREFRONT_LANDING_DESCRIPTION_MAX = 320;

/** A landing page's URL handle: one lowercase CMS-style segment, never a reserved route. */
export const storefrontLandingSlugSchema = z.string().min(1).max(100)
  .refine((slug) => isValidResourceCanonicalPath("page", `/${slug}`) && slug !== "pages", "Use a non-reserved lowercase URL handle.");

/** A landing page whose sections are `sections` (the document's own section list schema). */
export function storefrontLandingPageSchemaOf<Sections extends typeof storefrontSectionListSchema>(sections: Sections) {
  return z.object({
    /** The page's title: its `<title>`, Open Graph title and the hidden heading. */
    title: z.string().trim().min(1).max(STOREFRONT_LANDING_TITLE_MAX),
    /** The search-result description; blank leaves the meta description out. */
    description: z.string().trim().max(STOREFRONT_LANDING_DESCRIPTION_MAX),
    sections,
    /** Hidden from search engines: the page stays public (`noindex,follow`) and leaves the sitemap. */
    noIndex: z.boolean().optional(),
    /** Left out of the XML sitemap only; the page stays indexable. */
    excludeFromSitemap: z.boolean().optional(),
  }).strict();
}

/** The document's landing pages by handle, each a `page`. */
export function storefrontLandingPagesSchemaOf<Page extends z.ZodType>(page: Page) {
  return z.record(storefrontLandingSlugSchema, page)
    .refine((pages) => Object.keys(pages).length <= STOREFRONT_MAX_LANDING_PAGES, `Keep at most ${STOREFRONT_MAX_LANDING_PAGES} landing pages.`);
}

export const storefrontLandingPageSchema = storefrontLandingPageSchemaOf(storefrontSectionListSchema);

export type StorefrontLandingPage = z.infer<typeof storefrontLandingPageSchema>;

/**
 * The page templates a merchant adds ordinary sections to (Online Store
 * 2.0): every product page, every collection, category and brand page, the
 * cart and every CMS page. Each has one fixed part (the product
 * information, the products and filters, the cart, the page's content) that
 * moves among the sections but is never removed. The fixed part's own
 * structure stays `blocks.product` and `blocks.listing`.
 */
export const STOREFRONT_PAGE_TEMPLATES = ["product", "collection", "cart", "page"] as const;
export type StorefrontPageTemplate = (typeof STOREFRONT_PAGE_TEMPLATES)[number];

/** A template's sections; the first `main` of them come before its fixed part. */
export function storefrontPageTemplateSchemaOf<Sections extends typeof storefrontSectionListSchema>(sections: Sections) {
  return z.object({
    sections,
    main: z.number().int().min(0).max(STOREFRONT_MAX_SECTIONS),
  }).strict().refine((template) => template.main <= (template as unknown as { sections: readonly unknown[] }).sections.length, {
    path: ["main"],
    message: "The fixed part sits between the template's sections.",
  });
}

export function storefrontPageTemplatesSchemaOf<Template extends z.ZodType>(template: Template) {
  return z.object(Object.fromEntries(STOREFRONT_PAGE_TEMPLATES.map((kind) => [kind, template])) as Record<StorefrontPageTemplate, Template>).strict();
}

export const storefrontPageTemplateSchema = storefrontPageTemplateSchemaOf(storefrontSectionListSchema);
export type StorefrontPageTemplateValue = z.infer<typeof storefrontPageTemplateSchema>;

/** Every template empty: the fixed part alone, as before templates had sections. */
export function emptyStorefrontPageTemplates(): Record<StorefrontPageTemplate, StorefrontPageTemplateValue> {
  return Object.fromEntries(STOREFRONT_PAGE_TEMPLATES.map((kind) => [kind, { sections: [], main: 0 }])) as unknown as Record<StorefrontPageTemplate, StorefrontPageTemplateValue>;
}
