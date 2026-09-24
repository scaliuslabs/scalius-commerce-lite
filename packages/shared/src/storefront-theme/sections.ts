// The page section registry: homepage widgets as versioned
// entries with strict settings (SYNTHESIS.md section 2.3). Every section is
// optional, repeatable and reorderable; a section whose data does not fit
// the store (`requires`) or that has nothing to show renders nothing.
import { z } from "zod";
import { atLeast, type FitCondition } from "./fit";

const sectionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);
const title = z.string().trim().max(80);
const heading = z.string().trim().max(120);
const recordId = z.string().trim().min(1).max(64);
const mediaId = recordId.nullable();
/** A same-store path or an https URL. */
const href = z.string().trim().max(300).regex(/^(\/(?!\/)\S*|https:\/\/\S+)$/, "Use a store path or an https:// link.");

/** Where a product rail, grid or deal takes its products from. */
export const storefrontProductSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("newest") }).strict(),
  z.object({ kind: z.literal("on-sale") }).strict(),
  z.object({ kind: z.literal("popular") }).strict(),
  z.object({ kind: z.literal("collection"), collectionId: recordId }).strict(),
  z.object({ kind: z.literal("category"), categoryId: recordId }).strict(),
]);
export type StorefrontProductSource = z.infer<typeof storefrontProductSourceSchema>;

function section<const Type extends string, Settings extends z.ZodType>(spec: {
  type: Type;
  settings: Settings;
  defaults: z.infer<Settings>;
  requires?: readonly FitCondition[];
}) {
  return {
    version: 1 as const,
    settings: spec.settings,
    defaults: spec.defaults,
    requires: spec.requires ?? [],
    schema: z.object({
      id: sectionIdSchema,
      type: z.literal(spec.type),
      version: z.literal(1),
      settings: spec.settings,
    }).strict(),
  };
}

export const STOREFRONT_SECTION_REGISTRY = {
  hero: section({
    type: "hero",
    settings: z.object({
      // Fabrilife full-bleed 2.6:1; Star Tech contained + 2 side banners;
      // Daraz + app panel; Dawn split; Amazon story cards; Aarong full-screen phone.
      layout: z.enum(["full-bleed", "contained-banners", "app-panel", "split", "story-cards", "full-screen"]),
      /**
       * Star Tech's two stacked promos beside a contained hero (300x240 at
       * 1440px, two across under it on phones). Only `contained-banners`
       * shows them; without them it is the contained banner alone. Optional,
       * so stored version 1 heroes stay valid.
       */
      sideBanners: z.array(z.object({
        mediaId: recordId,
        /** What the image shows (its alt text). */
        alt: z.string().trim().max(160),
        href: href.nullable(),
      }).strict()).max(2).optional(),
    }).strict(),
    defaults: { layout: "full-bleed" },
  }),
  "usp-strip": section({
    type: "usp-strip",
    settings: z.object({
      style: z.enum(["icons", "ticker"]),
      source: z.discriminatedUnion("kind", [
        // Delivery, cash on delivery and returns from the live store settings.
        z.object({ kind: z.literal("delivery-facts") }).strict(),
        z.object({
          kind: z.literal("custom"),
          items: z.array(z.object({ title: z.string().trim().min(1).max(60), detail: z.string().trim().max(80) }).strict()).min(1).max(4),
        }).strict(),
      ]),
    }).strict(),
    defaults: { style: "icons", source: { kind: "delivery-facts" } },
  }),
  "category-tiles": section({
    type: "category-tiles",
    settings: z.object({ style: z.enum(["icons", "round", "photo", "quad"]) }).strict(),
    defaults: { style: "photo" },
    requires: [atLeast("topCategoryCount", 2)],
  }),
  /** The collections the merchant puts on the homepage, each in its own presentation. */
  collections: section({
    type: "collections",
    settings: z.object({}).strict(),
    defaults: {},
  }),
  "product-rail": section({
    type: "product-rail",
    settings: z.object({ title, source: storefrontProductSourceSchema, limit: z.number().int().min(4).max(24) }).strict(),
    defaults: { title: "", source: { kind: "newest" }, limit: 12 },
  }),
  "product-grid": section({
    type: "product-grid",
    settings: z.object({
      title,
      source: storefrontProductSourceSchema,
      columns: z.number().int().min(2).max(6),
      rows: z.number().int().min(1).max(6),
    }).strict(),
    defaults: { title: "", source: { kind: "newest" }, columns: 4, rows: 2 },
  }),
  "deal-block": section({
    type: "deal-block",
    settings: z.object({ title, source: storefrontProductSourceSchema, endsAt: z.iso.datetime().nullable() }).strict(),
    defaults: { title: "", source: { kind: "on-sale" }, endsAt: null },
  }),
  lookbook: section({
    type: "lookbook",
    settings: z.object({ title, mediaId, source: storefrontProductSourceSchema }).strict(),
    defaults: { title: "", mediaId: null, source: { kind: "newest" } },
  }),
  /**
   * One campaign banner. Consecutive banners with the same `two-up` or
   * `four-up` layout share one row (Fabrilife's two campaigns side by side,
   * Target's four promo tiles), each with its own image, words and link.
   */
  banner: section({
    type: "banner",
    settings: z.object({
      layout: z.enum(["full", "two-up", "four-up"]),
      heading,
      text: z.string().trim().max(300),
      mediaId,
      cta: z.object({ label: z.string().trim().min(1).max(40), href }).strict().nullable(),
    }).strict(),
    defaults: { layout: "full", heading: "", text: "", mediaId: null, cta: null },
  }),
  "brand-wall": section({
    type: "brand-wall",
    settings: z.object({ title, style: z.enum(["grid", "rail"]) }).strict(),
    defaults: { title: "", style: "rail" },
    requires: [atLeast("brandCount", 4)],
  }),
  editorial: section({
    type: "editorial",
    settings: z.discriminatedUnion("layout", [
      z.object({ layout: z.literal("rich-text"), heading, body: z.string().trim().max(2000) }).strict(),
      z.object({
        layout: z.literal("image-with-text"),
        heading,
        body: z.string().trim().max(2000),
        mediaId,
        imageSide: z.enum(["start", "end"]),
      }).strict(),
      z.object({
        layout: z.literal("multicolumn"),
        heading,
        columns: z.array(z.object({ title, text: z.string().trim().max(400) }).strict()).max(4),
      }).strict(),
      z.object({
        layout: z.literal("testimonial"),
        quotes: z.array(z.object({ quote: z.string().trim().min(1).max(400), author: title }).strict()).max(6),
      }).strict(),
    ]),
    defaults: { layout: "rich-text", heading: "", body: "" },
  }),
  faq: section({
    type: "faq",
    settings: z.object({
      heading,
      items: z.array(z.object({
        question: z.string().trim().min(1).max(200),
        answer: z.string().trim().min(1).max(1000),
      }).strict()).max(20),
    }).strict(),
    defaults: { heading: "", items: [] },
  }),
  "utility-cards": section({
    type: "utility-cards",
    settings: z.object({
      cards: z.array(z.object({ title: z.string().trim().min(1).max(60), text: z.string().trim().max(120), href }).strict()).max(4),
    }).strict(),
    defaults: { cards: [] },
  }),
  // Daraz "Just For You": off below 40 products.
  "endless-grid": section({
    type: "endless-grid",
    settings: z.object({ title, pageSize: z.union([z.literal(12), z.literal(24), z.literal(36)]) }).strict(),
    defaults: { title: "", pageSize: 24 },
    requires: [atLeast("productCount", 40)],
  }),
  // Long copy below everything (Star Tech, Apple Gadgets).
  "seo-text": section({
    type: "seo-text",
    settings: z.object({ heading, body: z.string().trim().max(8000) }).strict(),
    defaults: { heading: "", body: "" },
  }),
  // A client island after load; never part of the cached page.
  "recently-viewed": section({
    type: "recently-viewed",
    settings: z.object({ title }).strict(),
    defaults: { title: "" },
  }),
  newsletter: section({
    type: "newsletter",
    settings: z.object({ heading, text: z.string().trim().max(300) }).strict(),
    defaults: { heading: "", text: "" },
  }),
};

export type StorefrontSectionType = keyof typeof STOREFRONT_SECTION_REGISTRY;
export const STOREFRONT_SECTION_TYPES = Object.keys(STOREFRONT_SECTION_REGISTRY) as StorefrontSectionType[];
export const STOREFRONT_MAX_SECTIONS = 24;

const sectionSchemas = STOREFRONT_SECTION_TYPES.map((type) => STOREFRONT_SECTION_REGISTRY[type].schema);

type Registry = typeof STOREFRONT_SECTION_REGISTRY;
export type StorefrontSection = {
  [Type in StorefrontSectionType]: z.infer<Registry[Type]["schema"]>;
}[StorefrontSectionType];
export type StorefrontSectionOf<Type extends StorefrontSectionType> = Extract<StorefrontSection, { type: Type }>;

export const storefrontSectionSchema = z.discriminatedUnion(
  "type",
  sectionSchemas as unknown as [Registry["hero"]["schema"], ...Registry[StorefrontSectionType]["schema"][]],
) as unknown as z.ZodType<StorefrontSection>;

/** A list of sections: unique ids, at most 24. */
export const storefrontSectionListSchema = z.array(storefrontSectionSchema).max(STOREFRONT_MAX_SECTIONS)
  .superRefine((sections, context) => {
    const ids = new Set<string>();
    sections.forEach((each, index) => {
      if (ids.has(each.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Section ids must be unique." });
      ids.add(each.id);
    });
  });

/** A new section of a type with its default settings. */
export function storefrontSectionDefault<Type extends StorefrontSectionType>(type: Type, id: string): StorefrontSectionOf<Type> {
  return {
    id,
    type,
    version: 1,
    settings: structuredClone(STOREFRONT_SECTION_REGISTRY[type].defaults),
  } as StorefrontSectionOf<Type>;
}

/**
 * Section types the storefront renders. The rest wait for their data:
 * brand-wall for the brand entity, recently-viewed for product pages that
 * record views, newsletter for a subscriber list.
 */
export const STOREFRONT_SECTION_RENDERERS = [
  "hero",
  "usp-strip",
  "category-tiles",
  "collections",
  "product-rail",
  "product-grid",
  "deal-block",
  "lookbook",
  "banner",
  "editorial",
  "faq",
  "utility-cards",
  "endless-grid",
  "seo-text",
] as const satisfies readonly StorefrontSectionType[];
export type StorefrontSectionRenderer = (typeof STOREFRONT_SECTION_RENDERERS)[number];

/** The section's storefront renderer (its type), or null while the section waits for its data. */
export function storefrontSectionRenderer(each: StorefrontSection): StorefrontSectionRenderer | null {
  return (STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(each.type)
    ? each.type as StorefrontSectionRenderer
    : null;
}
