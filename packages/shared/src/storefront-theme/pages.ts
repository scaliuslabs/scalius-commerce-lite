import { z } from "zod";
import { isValidResourceCanonicalPath } from "../seo-canonical";
import { storefrontSectionListSchema } from "./sections";

export const STOREFRONT_PRODUCT_PAGE_BLOCKS = [
  "gallery", "title-price", "options", "buy-buttons", "description", "specs", "reviews", "related-products", "apps",
] as const;
export const STOREFRONT_LISTING_PAGE_BLOCKS = ["breadcrumbs", "banner", "filters", "grid"] as const;
export type StorefrontProductPageBlockId = (typeof STOREFRONT_PRODUCT_PAGE_BLOCKS)[number];
export type StorefrontListingPageBlockId = (typeof STOREFRONT_LISTING_PAGE_BLOCKS)[number];
export type StorefrontPageBlockId = StorefrontProductPageBlockId | StorefrontListingPageBlockId;

/** Fixed blocks remain in the document when hidden, so showing one restores its position. */
function pageTemplateSchema<const Id extends string>(ids: readonly [Id, ...Id[]]) {
  return z.object({
    blocks: z.array(z.object({ id: z.enum(ids), hidden: z.boolean() }).strict()).length(ids.length)
      .refine((blocks) => new Set(blocks.map((block) => block.id)).size === ids.length, "Each page block appears once."),
  }).strict();
}

export const storefrontProductPageTemplateSchema = pageTemplateSchema(STOREFRONT_PRODUCT_PAGE_BLOCKS);
export const storefrontListingPageTemplateSchema = pageTemplateSchema(STOREFRONT_LISTING_PAGE_BLOCKS);
export type StorefrontProductPageTemplate = z.infer<typeof storefrontProductPageTemplateSchema>;
export type StorefrontListingPageTemplate = z.infer<typeof storefrontListingPageTemplateSchema>;
export type StorefrontPageTemplate = StorefrontProductPageTemplate | StorefrontListingPageTemplate;

export const STOREFRONT_MAX_LANDING_PAGES = 20;
export const storefrontLandingSlugSchema = z.string().min(1).max(100)
  .refine((slug) => isValidResourceCanonicalPath("page", `/${slug}`) && slug !== "pages", "Use a non-reserved lowercase URL handle.");
export const storefrontLandingPageSchema = z.object({
  title: z.string().trim().min(1).max(120),
  sections: storefrontSectionListSchema,
  overrideCms: z.boolean().default(false),
}).strict();
export const storefrontLandingPagesSchema = z.record(storefrontLandingSlugSchema, storefrontLandingPageSchema)
  .refine((pages) => Object.keys(pages).length <= STOREFRONT_MAX_LANDING_PAGES, `Keep at most ${STOREFRONT_MAX_LANDING_PAGES} landing pages.`);
export type StorefrontLandingPage = z.infer<typeof storefrontLandingPageSchema>;

export function storefrontProductPageTemplateDefault(): StorefrontProductPageTemplate {
  return { blocks: STOREFRONT_PRODUCT_PAGE_BLOCKS.map((id) => ({ id, hidden: false })) };
}
export function storefrontListingPageTemplateDefault(): StorefrontListingPageTemplate {
  return { blocks: STOREFRONT_LISTING_PAGE_BLOCKS.map((id) => ({ id, hidden: false })) };
}

/** Visible blocks, in merchant order; data and fit guards still apply in each renderer. */
export function storefrontVisiblePageBlocks<Id extends StorefrontPageBlockId>(template: { blocks: readonly { id: Id; hidden: boolean }[] }): Id[] {
  return template.blocks.filter((block) => !block.hidden).map((block) => block.id);
}
