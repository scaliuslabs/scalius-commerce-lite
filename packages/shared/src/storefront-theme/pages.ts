// Landing pages (section pages at `/pages/<slug>`) and page templates (the
// sections around the product, listing, cart and CMS pages' fixed parts),
// composed from the same section registry, draft, preview and publish as
// the homepage. A fixed part's own structure is the document's
// `blocks.product` and `blocks.listing` (modules, toolbar pieces, filters).
import { z } from "zod";
import { MARKET_SUBFOLDER_PATTERN } from "../markets";
import { STOREFRONT_MAX_SECTIONS, storefrontSectionListSchema } from "./sections";

export const STOREFRONT_MAX_LANDING_PAGES = 20;
export const STOREFRONT_LANDING_TITLE_MAX = 120;
export const STOREFRONT_LANDING_DESCRIPTION_MAX = 320;

/**
 * The handles no landing page has ever been allowed, whatever the storefront
 * reserves today. Frozen: a name added to `STOREFRONT_ROUTE_SEGMENTS` later must
 * not be added here, or a stored document that holds it would stop reading.
 */
const LANDING_HANDLES_NEVER_VALID: ReadonlySet<string> = new Set([
  "404", "500", "account", "admin", "api", "apps", "blog", "brands", "buy", "cart", "categories", "checkout",
  "collections", "health", "localization", "newsletter", "order-success", "pages", "payment-recovery", "products",
  "search", "track-order",
]);

/**
 * A landing page's URL handle: one lowercase CMS-style segment, never a market
 * subfolder or one of the frozen names above. The page lives at
 * `/pages/<handle>`, so a top-level route cannot collide with it and the
 * storefront's route list does not apply: a stored document keeps every
 * handle it was saved with.
 */
export const storefrontLandingSlugSchema = z.string().min(1).max(100)
  .refine(
    (slug) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) && !MARKET_SUBFOLDER_PATTERN.test(slug) && !LANDING_HANDLES_NEVER_VALID.has(slug),
    "Use a non-reserved lowercase URL handle.",
  );

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
 * 2.0): every product page, every collection, category and brand page, and
 * every CMS page. Each has one fixed part (the product information, the
 * products and filters, the page's content) that moves among the sections
 * but is never removed. The fixed part's own structure stays
 * `blocks.product` and `blocks.listing`. A buyer's private page (the cart,
 * checkout, receipt, account) takes no template sections: the theme only
 * arranges its host parts (`privatePages`); a document naming a cart template
 * is refused (`STOREFRONT_PRIVATE_TEMPLATE_REASON`).
 */
export const STOREFRONT_PAGE_TEMPLATES = ["product", "collection", "page"] as const;
/** The machine-readable reason a theme naming a template for a private page is refused. */
export const STOREFRONT_PRIVATE_TEMPLATE_REASON = "private_page_template";
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
  const templates = z.object(Object.fromEntries(STOREFRONT_PAGE_TEMPLATES.map((kind) => [kind, template])) as Record<StorefrontPageTemplate, Template>).strict();
  // The cart's template, once offered: an empty one (what every document carried) is left out; one with
  // sections is refused by name and reason, never as a bare unknown key. A preprocess keeps the input and
  // output JSON Schema the strict object's.
  return z.preprocess((value, context) => {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, "cart")) return value;
    const { cart, ...rest } = value as Record<string, unknown>;
    const sections = typeof cart === "object" && cart !== null ? (cart as { sections?: unknown }).sections : undefined;
    if (Array.isArray(sections) && sections.length === 0) return rest;
    context.addIssue({
      code: "custom",
      path: ["cart"],
      input: value,
      message: "The cart is a buyer's private page and takes no sections: arrange its parts in privatePages.pages.cart instead.",
      params: { reason: STOREFRONT_PRIVATE_TEMPLATE_REASON },
    });
    return value;
  }, templates);
}

export const storefrontPageTemplateSchema = storefrontPageTemplateSchemaOf(storefrontSectionListSchema);
export type StorefrontPageTemplateValue = z.infer<typeof storefrontPageTemplateSchema>;

/** Every template empty: the fixed part alone, as before templates had sections. */
export function emptyStorefrontPageTemplates(): Record<StorefrontPageTemplate, StorefrontPageTemplateValue> {
  return Object.fromEntries(STOREFRONT_PAGE_TEMPLATES.map((kind) => [kind, { sections: [], main: 0 }])) as unknown as Record<StorefrontPageTemplate, StorefrontPageTemplateValue>;
}
