// Landing pages: section pages at `/pages/<slug>`, composed from the same
// section registry, draft, preview and publish as the homepage. Product,
// collection and search pages are not here: their structure is the
// document's `blocks.product` and `blocks.listing` (modules, toolbar pieces,
// filters), which the storefront already renders and the editor edits.
import { z } from "zod";
import { isValidResourceCanonicalPath } from "../seo-canonical";
import { storefrontSectionListSchema } from "./sections";

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
export const storefrontLandingPagesSchema = storefrontLandingPagesSchemaOf(storefrontLandingPageSchema);

export type StorefrontLandingPage = z.infer<typeof storefrontLandingPageSchema>;
