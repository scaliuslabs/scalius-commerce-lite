// The page section registry: homepage widgets as versioned
// entries with strict settings (SYNTHESIS.md section 2.3). Every section is
// optional, repeatable and reorderable; a section whose data does not fit
// the store (`requires`) or that has nothing to show renders nothing.
import { z } from "zod";
import { storefrontAppKeySchema, storefrontAppValuesSchema, storefrontSkinRefSchema } from "./apps";
import { atLeast, type FitCondition } from "./fit";
import { storefrontLinkSchema } from "./links";
import { storefrontSettingBindingsSchema } from "./bindings";
import { isCustomFieldKey, isCustomFieldNamespace } from "../custom-field-keys";

const sectionIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/);

/**
 * A block (one item of a section's list: a slide, a card, a question) the
 * merchant hid: it keeps its settings and renders nothing
 * (`storefrontVisibleSection`). Optional, so stored items stay valid.
 */
const blockHidden = { hidden: z.boolean().optional(), bindings: storefrontSettingBindingsSchema.optional() };
/**
 * A section an AI drafted that no one has opened in the editor yet. It
 * renders like any other; the editor marks it until it is opened, and the
 * publish summary names it.
 */
const aiDraft = z.literal(true).optional();

/** How `category-tiles` draws the categories (see the section's comment). */
export const STOREFRONT_CATEGORY_TILE_STYLES = ["photo", "photo-grid", "round", "round-small", "round-row", "icons", "quad", "square"] as const;
export type StorefrontCategoryTileStyle = (typeof STOREFRONT_CATEGORY_TILE_STYLES)[number];

/** Categories a tile style needs to render: one for the photo styles (today's rail), two for the denser ones. */
export function storefrontCategoryTilesMinimum(style: StorefrontCategoryTileStyle): 1 | 2 {
  return style === "photo" || style === "photo-grid" ? 1 : 2;
}
const title = z.string().trim().max(80);
const heading = z.string().trim().max(120);
const recordId = z.string().trim().min(1).max(64);
const mediaId = recordId.nullable();
/** A same-store path or an https URL. */
const href = z.string().trim().max(300).regex(/^(\/(?!\/)\S*|https:\/\/\S+)$/, "Use a store path or an https:// link.");
/** Ids a section names (categories, collections): unique, in the merchant's order. */
const idList = (max: number, what: string) =>
  z.array(recordId).max(max).refine((ids) => new Set(ids).size === ids.length, `Each ${what} appears once.`);

/** Slides one hero holds (each a computer image and an optional phone image). */
export const STOREFRONT_HERO_SLIDE_LIMIT = 10;
/** Categories one category-tiles section shows. */
export const STOREFRONT_CATEGORY_TILES_LIMIT = 12;
/** Collections one collections section shows, each a row of its products. */
export const STOREFRONT_COLLECTIONS_LIMIT = 8;
export const STOREFRONT_HERO_SLIDE_TEXT_LIMITS = { alt: 160, heading: 160, text: 160, buttonLabel: 40 } as const;
/** How a newsletter signup asks for the e-mail (the phone is always asked). */
export const STOREFRONT_NEWSLETTER_EMAIL_FIELDS = ["optional", "required", "hidden"] as const;
export type StorefrontNewsletterEmailField = (typeof STOREFRONT_NEWSLETTER_EMAIL_FIELDS)[number];
export const STOREFRONT_NEWSLETTER_BUTTON_LABEL_MAX = 40;

/**
 * Where a photo's subject is, as percentages of its width (`x`) and height
 * (`y`): a cropped banner keeps that point in frame.
 */
export const storefrontFocalPointSchema = z.object({
  x: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
}).strict();
export type StorefrontFocalPoint = z.infer<typeof storefrontFocalPointSchema>;
export const STOREFRONT_DEFAULT_FOCAL_POINT: Readonly<StorefrontFocalPoint> = Object.freeze({ x: 50, y: 50 });

/**
 * One hero slide: its computer image (also the phone image unless
 * `phoneImage` names one), each with its own focal point, the alt text
 * (what the image shows; never drawn over it), optional words over the
 * image and a link (a navigation-safe href; null: the slide is not a link).
 * The button shows only with a link.
 */
export const storefrontHeroSlideSchema = z.object({
  image: recordId,
  phoneImage: recordId.optional(),
  focalPoint: storefrontFocalPointSchema,
  phoneFocalPoint: storefrontFocalPointSchema.optional(),
  alt: z.string().trim().min(1).max(STOREFRONT_HERO_SLIDE_TEXT_LIMITS.alt),
  heading: z.string().trim().max(STOREFRONT_HERO_SLIDE_TEXT_LIMITS.heading).optional(),
  text: z.string().trim().max(STOREFRONT_HERO_SLIDE_TEXT_LIMITS.text).optional(),
  buttonLabel: z.string().trim().max(STOREFRONT_HERO_SLIDE_TEXT_LIMITS.buttonLabel).optional(),
  link: storefrontLinkSchema.nullable(),
  ...blockHidden,
}).strict();
export type StorefrontHeroSlide = z.infer<typeof storefrontHeroSlideSchema>;

/** Where a product rail, grid or deal takes its products from. */
export const storefrontProductSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("newest") }).strict(),
  z.object({ kind: z.literal("on-sale") }).strict(),
  z.object({ kind: z.literal("popular") }).strict(),
  z.object({ kind: z.literal("collection"), collectionId: recordId }).strict(),
  z.object({ kind: z.literal("category"), categoryId: recordId }).strict(),
]);
export type StorefrontProductSource = z.infer<typeof storefrontProductSourceSchema>;

/**
 * One step of a section type's upgrade chain: its settings at version `n`
 * (JSON as stored) in, its settings at `n + 1` out. Pure; it throws when the
 * settings cannot be upgraded (the document then reads as unreadable).
 */
export type StorefrontSectionSettingsUpgrade = (settings: unknown) => unknown;

function storefrontSectionRegistryOf(
  skin: typeof storefrontSkinRefSchema,
  bindings: typeof storefrontSettingBindingsSchema,
  productSource: typeof storefrontProductSourceSchema,
) {
  const blockHidden = { hidden: z.boolean().optional(), bindings: bindings.optional() };
  /**
   * One section type. `version` is its settings' version (1 unless given);
   * `upgrades[n]` turns its settings at version `n` into version `n + 1`
   * (upgrade.ts runs them on read), so stored sections of an older version
   * still read. Bump the version only with the step from the one before.
   */
  function section<const Type extends string, Settings extends z.ZodType, const Version extends number = 1>(spec: {
    type: Type;
    version?: Version;
    upgrades?: Readonly<Record<number, StorefrontSectionSettingsUpgrade>>;
    settings: Settings;
    defaults: z.infer<Settings>;
    requires?: readonly FitCondition[];
  }) {
    const version = (spec.version ?? 1) as Version;
    return {
      version,
      upgrades: spec.upgrades ?? {},
      settings: spec.settings,
      defaults: spec.defaults,
      requires: spec.requires ?? [],
      schema: z.object({
        id: sectionIdSchema,
        type: z.literal(spec.type),
        version: z.literal(version),
        hidden: z.boolean().optional(),
        aiDraft,
        settings: spec.settings,
        bindings: bindings.optional(),
        /** An app skin draws this section from its projection; core draws it while the skin cannot. */
        skin: skin.optional(),
      }).strict(),
    };
  }

  return {
    hero: section({
      type: "hero",
      settings: z.object({
        // Full-bleed 2.6:1; contained (+ 2 side banners); split halves; a
        // full-screen phone frame; wide editorial (copy beside the image).
        layout: z.enum(["full-bleed", "contained-banners", "split", "full-screen", "wide-editorial"]),
        /** The slides, in order. A hero without one renders nothing. */
        slides: z.array(storefrontHeroSlideSchema).max(STOREFRONT_HERO_SLIDE_LIMIT),
        /** Keep the desktop order, but let category tiles lead on phones. */
        phonePlacement: z.enum(["after-categories"]).optional(),
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
          ...blockHidden,
        }).strict()).max(2).optional(),
        /**
         * `full-screen` on phones: the first screen (`screen`, the default), or
         * Aarong's `compact` 65svh frame (23-35rem) when the phone banners carry
         * no words, so a photo-only banner does not take the whole screen.
         */
        phoneHeight: z.enum(["screen", "compact"]).optional(),
      }).strict(),
      defaults: { layout: "full-bleed", slides: [] },
    }),
    /** Delivery facts or the merchant's points. The section's presence is its switch. */
    "usp-strip": section({
      type: "usp-strip",
      settings: z.object({
        style: z.enum(["icons", "ticker"]),
        source: z.discriminatedUnion("kind", [
          // Delivery, cash on delivery and returns from the live store settings.
          z.object({ kind: z.literal("delivery-facts") }).strict(),
          z.object({
            kind: z.literal("custom"),
            items: z.array(z.object({ title: z.string().trim().min(1).max(60), detail: z.string().trim().max(80), ...blockHidden }).strict()).min(1).max(4),
          }).strict(),
        ]),
      }).strict(),
      defaults: { style: "icons", source: { kind: "delivery-facts" } },
    }),
    /**
     * The categories the merchant picks (`categoryIds`, in order; published
     * ones show) under its title (empty: "Shop by category"). `photo` is a
     * scrolling rail of portrait photos (a grid from 640px); `photo-grid`
     * Aarong's department grid (two to four across); `round` a grid of round
     * photos (3 to 8 across); `round-small` Apple Gadgets' 56px circles;
     * `round-row` Target's round photos in one scrolling row on phones;
     * `icons` Star Tech's icon grid; `quad` Amazon's cards of four; `square`
     * eBay's gallery.
     */
    "category-tiles": section({
      type: "category-tiles",
      settings: z.object({
        style: z.enum(STOREFRONT_CATEGORY_TILE_STYLES),
        title,
        categoryIds: idList(STOREFRONT_CATEGORY_TILES_LIMIT, "category"),
      }).strict(),
      defaults: { style: "photo", title: "", categoryIds: [] },
      requires: [atLeast("topCategoryCount", 2)],
    }),
    /**
     * The collections the merchant picks (`collectionIds`, in order; active
     * ones with products show), each in its own presentation. Without one,
     * the section shows the newest products. A carousel collection's cards are
     * `large` (1.4 cards on a phone, 3 to 5 across) or Apple Gadgets'
     * `compact` shelf (2.3 on a phone, up to 5.3 across).
     */
    collections: section({
      type: "collections",
      settings: z.object({
        carousel: z.enum(["large", "compact"]),
        collectionIds: idList(STOREFRONT_COLLECTIONS_LIMIT, "collection"),
        // The heading over the newest products shown until collections are chosen (each collection has its own name).
        title: title.optional(),
      }).strict(),
      defaults: { carousel: "large", collectionIds: [] },
    }),
    "product-rail": section({
      type: "product-rail",
      settings: z.object({ title, source: productSource, limit: z.number().int().min(4).max(24) }).strict(),
      defaults: { title: "", source: { kind: "newest" }, limit: 12 },
    }),
    "product-grid": section({
      type: "product-grid",
      settings: z.object({
        title,
        source: productSource,
        columns: z.number().int().min(2).max(6),
        rows: z.number().int().min(1).max(6),
      }).strict(),
      defaults: { title: "", source: { kind: "newest" }, columns: 4, rows: 2 },
    }),
    /**
     * Daraz's flash sale: a product row whose countdown counts to the end of a
     * real promotion (`promotionId`, an active discount with an end time),
     * never to a typed-in date. Without one, or once it has ended, the row has
     * no countdown.
     */
    "deal-block": section({
      type: "deal-block",
      settings: z.object({
        title,
        source: productSource,
        promotionId: recordId.nullable().optional(),
        mediaId: mediaId.optional(),
      }).strict(),
      defaults: { title: "", source: { kind: "on-sale" }, promotionId: null },
    }),
    /**
     * Multi-list tabs (Game Ghor, Walmart, Chaldal): one heading and 2 to 4
     * tabs, each a product source. Works without script (radio tabs); each tab
     * shows its first `limit` products.
     */
    "product-tabs": section({
      type: "product-tabs",
      settings: z.object({
        title,
        tabs: z.array(z.object({ label: z.string().trim().max(40), source: productSource, ...blockHidden }).strict()).min(2).max(4),
        limit: z.number().int().min(4).max(12),
      }).strict(),
      defaults: {
        title: "",
        tabs: [
          { label: "", source: { kind: "newest" } },
          { label: "", source: { kind: "on-sale" } },
          { label: "", source: { kind: "popular" } },
        ],
        limit: 8,
      },
    }),
    /**
     * "Shop by" image cards (Target's and Walmart's occasion cards, Amazon's
     * quad cards): the merchant's photos, each with a label and a link.
     */
    "shop-by": section({
      type: "shop-by",
      settings: z.object({
        title,
        cards: z.array(z.object({ mediaId: recordId, title: z.string().trim().min(1).max(60), subtitle: z.string().trim().max(120).optional(), href, ...blockHidden }).strict()).max(8),
      }).strict(),
      defaults: { title: "", cards: [] },
    }),
    /**
     * A promo banner mosaic (Daraz, Aarong, Walmart): one large tile beside up
     * to four smaller ones, each an image with its link.
     */
    "banner-mosaic": section({
      type: "banner-mosaic",
      settings: z.object({
        tiles: z.array(z.object({
          mediaId: recordId,
          /** What the image shows (its alt text). */
          alt: z.string().trim().max(160),
          href: href.nullable(),
          ...blockHidden,
        }).strict()).max(5),
      }).strict(),
      defaults: { tiles: [] },
    }),
    /**
     * A lifestyle photo beside a grid of the list's products: `tall` fills the
     * height of the grid beside it (2:3 columns); `square` is Fabrilife's
     * square photo in a 1:2 split.
     */
    lookbook: section({
      type: "lookbook",
      settings: z.object({ title, mediaId, source: productSource, photo: z.enum(["tall", "square"]) }).strict(),
      defaults: { title: "", mediaId: null, source: { kind: "newest" }, photo: "tall" },
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
          columns: z.array(z.object({ title, text: z.string().trim().max(400), ...blockHidden }).strict()).max(4),
        }).strict(),
        z.object({
          layout: z.literal("testimonial"),
          quotes: z.array(z.object({ quote: z.string().trim().min(1).max(400), author: title, ...blockHidden }).strict()).max(6),
        }).strict(),
      ]),
      defaults: { layout: "rich-text", heading: "", body: "" },
    }),
    specifications: section({
      type: "specifications",
      settings: z.object({
        heading,
        objectField: z.string().trim().max(166).refine((value) => {
          if (!value) return true;
          const separator = value.lastIndexOf(".");
          return isCustomFieldNamespace(value.slice(0, separator)) && isCustomFieldKey(value.slice(separator + 1));
        }, "Use a qualified custom field, such as custom.size_chart.").optional(),
        rows: z.array(z.object({ label: title, value: z.string().trim().max(1000), ...blockHidden }).strict()).max(24),
      }).strict(),
      defaults: { heading: "Specifications", rows: [] },
    }),
    faq: section({
      type: "faq",
      settings: z.object({
        heading,
        items: z.array(z.object({
          question: z.string().trim().min(1).max(200),
          answer: z.string().trim().min(1).max(1000),
          ...blockHidden,
        }).strict()).max(20),
      }).strict(),
      defaults: { heading: "", items: [] },
    }),
    "utility-cards": section({
      type: "utility-cards",
      settings: z.object({
        cards: z.array(z.object({ title: z.string().trim().min(1).max(60), text: z.string().trim().max(120), href, ...blockHidden }).strict()).max(4),
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
    /**
     * A object content type's published entries (Shopify's object
     * sections): an FAQ, a size chart, designers, store locations. The
     * merchant picks the content type (it must allow storefront access); the
     * section shows up to `limit` entries in their order, each its display
     * field and the rest of its fields, as a list, cards or questions that
     * open. Nothing shows while the type is unset, gone or private.
     */
    objects: section({
      type: "objects",
      settings: z.object({
        heading,
        typeId: z.string().trim().max(160),
        layout: z.enum(["list", "grid", "accordion"]),
        limit: z.number().int().min(1).max(24),
      }).strict(),
      defaults: { heading: "", typeId: "", layout: "list", limit: 12 },
    }),
    /**
     * The newsletter signup (Dawn's email signup, Fabrilife's band): the
     * phone always (customer identity; it subscribes to SMS), the e-mail as
     * `email` says, and with `whatsapp` a box that adds WhatsApp for the same
     * number. The form states the channels it subscribes. An empty heading,
     * text or button label shows the storefront's own words in the store's
     * language. `email`, `whatsapp` and `buttonLabel` are optional, so stored
     * version 1 newsletters stay valid (no `email`: optional).
     */
    newsletter: section({
      type: "newsletter",
      settings: z.object({
        heading,
        text: z.string().trim().max(300),
        mediaId: mediaId.optional(),
        email: z.enum(STOREFRONT_NEWSLETTER_EMAIL_FIELDS).optional(),
        whatsapp: z.boolean().optional(),
        buttonLabel: z.string().trim().max(STOREFRONT_NEWSLETTER_BUTTON_LABEL_MAX).optional(),
      }).strict(),
      defaults: { heading: "", text: "", email: "optional", whatsapp: false },
    }),
  };
}

export const STOREFRONT_SECTION_REGISTRY = storefrontSectionRegistryOf(
  storefrontSkinRefSchema, storefrontSettingBindingsSchema, storefrontProductSourceSchema,
);

export type StorefrontSectionType = keyof typeof STOREFRONT_SECTION_REGISTRY;
export const STOREFRONT_SECTION_TYPES = Object.keys(STOREFRONT_SECTION_REGISTRY) as StorefrontSectionType[];
export const STOREFRONT_MAX_SECTIONS = 24;

/**
 * A section an installed app draws (apps.ts): `settings.app` names it
 * `<plugin id>/<type>`, `settings.values` are the merchant's values for the
 * app's section settings.
 */
export const storefrontAppSectionSchema = z.object({
  id: sectionIdSchema,
  type: z.literal("app"),
  version: z.literal(1),
  hidden: z.boolean().optional(),
  aiDraft,
  settings: z.object({ app: storefrontAppKeySchema, values: storefrontAppValuesSchema }).strict(),
  bindings: storefrontSettingBindingsSchema.optional(),
}).strict();
export type StorefrontAppSection = z.infer<typeof storefrontAppSectionSchema>;

const sectionSchemas = STOREFRONT_SECTION_TYPES.map((type) => STOREFRONT_SECTION_REGISTRY[type].schema);

type Registry = typeof STOREFRONT_SECTION_REGISTRY;
/** A platform section (a registry type with its own settings). */
export type StorefrontPlatformSection = {
  [Type in StorefrontSectionType]: z.infer<Registry[Type]["schema"]>;
}[StorefrontSectionType];
export type StorefrontSection = StorefrontPlatformSection | StorefrontAppSection;
/** The platform section of one registry type (an app section is never one: its type is not in the registry). */
export type StorefrontSectionOf<Type extends StorefrontSectionType> = Extract<StorefrontPlatformSection, { type: Type }>;

/** Whether a section is an app's (rendered by the app, not by a platform renderer). */
export function isStorefrontAppSection(section: StorefrontSection): section is StorefrontAppSection {
  return section.type === "app";
}

/** One section of any type, using shared schemas for repeated placement and source values. */
function storefrontSectionSchemaOf(
  skin: typeof storefrontSkinRefSchema,
  bindings: typeof storefrontSettingBindingsSchema = storefrontSettingBindingsSchema,
  productSource: typeof storefrontProductSourceSchema = storefrontProductSourceSchema,
) {
  const schemas = skin === storefrontSkinRefSchema && bindings === storefrontSettingBindingsSchema && productSource === storefrontProductSourceSchema
    ? sectionSchemas
    : Object.values(storefrontSectionRegistryOf(skin, bindings, productSource)).map((entry) => entry.schema);
  const app = bindings === storefrontSettingBindingsSchema
    ? storefrontAppSectionSchema
    : storefrontAppSectionSchema.extend({ bindings: bindings.optional() });
  return z.discriminatedUnion(
    "type",
    [...schemas, app] as unknown as [Registry["hero"]["schema"], ...Registry[StorefrontSectionType]["schema"][]],
  ) as unknown as z.ZodType<StorefrontSection>;
}

export const storefrontSectionSchema = storefrontSectionSchemaOf(storefrontSkinRefSchema);

/**
 * A list of sections: unique ids, at most 24. The API passes named shared
 * schemas so repeated skins, bindings and product sources are stated once.
 */
export function storefrontSectionListSchemaOf(
  skin: typeof storefrontSkinRefSchema = storefrontSkinRefSchema,
  bindings: typeof storefrontSettingBindingsSchema = storefrontSettingBindingsSchema,
  productSource: typeof storefrontProductSourceSchema = storefrontProductSourceSchema,
) {
  return z.array(storefrontSectionSchemaOf(skin, bindings, productSource)).max(STOREFRONT_MAX_SECTIONS)
    .superRefine((sections, context) => {
      const ids = new Set<string>();
      sections.forEach((each, index) => {
        if (ids.has(each.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Section ids must be unique." });
        ids.add(each.id);
      });
    });
}

export const storefrontSectionListSchema = storefrontSectionListSchemaOf();

/** A new section id on a page: the type (`app` for an app's), then -2, -3… until it is free. */
export function storefrontNextSectionId(type: string, taken: Iterable<{ id: string }>): string {
  const used = new Set([...taken].map((each) => each.id));
  if (!used.has(type)) return type;
  for (let number = 2; ; number += 1) {
    if (!used.has(`${type}-${number}`)) return `${type}-${number}`;
  }
}

/** A new section of a type with its default settings. */
export function storefrontSectionDefault<Type extends StorefrontSectionType>(type: Type, id: string): StorefrontSectionOf<Type> {
  return {
    id,
    type,
    version: STOREFRONT_SECTION_REGISTRY[type].version,
    settings: structuredClone(STOREFRONT_SECTION_REGISTRY[type].defaults),
  } as StorefrontSectionOf<Type>;
}

/** Section types the storefront renders (every registered type today). */
export const STOREFRONT_SECTION_RENDERERS = [
  "hero",
  "usp-strip",
  "category-tiles",
  "collections",
  "product-rail",
  "product-grid",
  "deal-block",
  "product-tabs",
  "lookbook",
  "banner",
  "shop-by",
  "banner-mosaic",
  "brand-wall",
  "editorial",
  "faq",
  "specifications",
  "utility-cards",
  "endless-grid",
  "seo-text",
  "recently-viewed",
  "objects",
  "newsletter",
] as const satisfies readonly StorefrontSectionType[];
export type StorefrontSectionRenderer = (typeof STOREFRONT_SECTION_RENDERERS)[number];

/** The section's storefront renderer (its type), or null while the section waits for its data. */
export function storefrontSectionRenderer(each: StorefrontSection): StorefrontSectionRenderer | null {
  return (STOREFRONT_SECTION_RENDERERS as readonly string[]).includes(each.type)
    ? each.type as StorefrontSectionRenderer
    : null;
}

function filled(...values: Array<string | null | undefined>): boolean {
  return values.some((value) => Boolean(value?.trim()));
}

/**
 * Whether a section's own settings leave it nothing to show: merchant words
 * or photos it needs and does not have. The dashboard flags these and the
 * storefront never renders them. Sections that show store data (products,
 * categories, brands, delivery facts) are judged on that data instead.
 */
export function storefrontSectionNeedsContent(section: StorefrontSection): boolean {
  // Hidden blocks show nothing: a hero whose slides are all hidden needs content.
  const each = storefrontVisibleSection(section);
  switch (each.type) {
    case "hero":
      return each.settings.slides.length === 0;
    case "category-tiles":
      return each.settings.categoryIds.length < storefrontCategoryTilesMinimum(each.settings.style);
    case "usp-strip":
      return each.settings.source.kind === "custom" && each.settings.source.items.length === 0;
    case "banner":
      return each.settings.mediaId === null && !filled(each.settings.heading, each.settings.text);
    case "shop-by":
      return each.settings.cards.length === 0;
    case "banner-mosaic":
      return each.settings.tiles.length === 0;
    case "editorial":
      switch (each.settings.layout) {
        case "rich-text":
          return !filled(each.settings.heading, each.settings.body);
        case "image-with-text":
          return each.settings.mediaId === null && !filled(each.settings.heading, each.settings.body);
        case "multicolumn":
          return !each.settings.columns.some((column) => filled(column.title, column.text));
        case "testimonial":
          return each.settings.quotes.length === 0;
        default:
          return true;
      }
    case "faq":
      return each.settings.items.length === 0;
    case "specifications":
      return !filled(each.settings.objectField) && !each.settings.rows.some((row) => filled(row.label) && filled(row.value));
    case "utility-cards":
      return each.settings.cards.length === 0;
    case "seo-text":
      return !filled(each.settings.body);
    // Nothing to show until a content type is picked; its entries are store data.
    case "objects":
      return !each.settings.typeId;
    // A signup always has its form and the storefront's default words.
    case "newsletter":
      return false;
    default:
      return false;
  }
}

/**
 * The blocks of each section type: the lists in its settings whose items a
 * merchant adds, orders, hides and removes one by one (Shopify's blocks).
 * `path` is the list's place in the settings (`source.items` for a custom
 * strip); a list another layout does not have is simply absent.
 */
export const STOREFRONT_SECTION_BLOCKS = {
  hero: [{ path: "slides", kind: "slide" }, { path: "sideBanners", kind: "side-banner" }],
  "usp-strip": [{ path: "source.items", kind: "point" }],
  "product-tabs": [{ path: "tabs", kind: "tab" }],
  "shop-by": [{ path: "cards", kind: "card" }],
  "banner-mosaic": [{ path: "tiles", kind: "tile" }],
  editorial: [{ path: "columns", kind: "column" }, { path: "quotes", kind: "quote" }],
  faq: [{ path: "items", kind: "question" }],
  specifications: [{ path: "rows", kind: "specification" }],
  "utility-cards": [{ path: "cards", kind: "link-card" }],
} as const satisfies Partial<Record<StorefrontSectionType, ReadonlyArray<{ path: string; kind: string }>>>;
export type StorefrontBlockKind = (typeof STOREFRONT_SECTION_BLOCKS)[keyof typeof STOREFRONT_SECTION_BLOCKS][number]["kind"];

/** A section type's block lists ([] for a section without blocks or for an app section). */
export function storefrontSectionBlockLists(type: StorefrontSection["type"]): ReadonlyArray<{ path: string; kind: StorefrontBlockKind }> {
  return (STOREFRONT_SECTION_BLOCKS as Partial<Record<string, ReadonlyArray<{ path: string; kind: StorefrontBlockKind }>>>)[type] ?? [];
}

/** The value at a dotted settings path, or undefined. */
export function storefrontSettingAt(settings: unknown, path: string): unknown {
  let value: unknown = settings;
  for (const key of path.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** Settings with the value at a dotted path replaced (a copy along the path; the rest shared). */
export function storefrontSettingWith<Settings>(settings: Settings, path: string, next: unknown): Settings {
  const [key, ...rest] = path.split(".");
  const record = (settings ?? {}) as Record<string, unknown>;
  return { ...record, [key!]: rest.length === 0 ? next : storefrontSettingWith(record[key!], rest.join("."), next) } as Settings;
}

const isHidden = (item: unknown) => (item as { hidden?: unknown } | null)?.hidden === true;

/**
 * The section as buyers see it: its hidden blocks left out. The resolver
 * and the section data planner read sections through this, so a hidden
 * slide neither renders nor reads its image.
 */
export function storefrontVisibleSection<Section extends StorefrontSection>(section: Section): Section {
  let settings: unknown = section.settings;
  for (const { path } of storefrontSectionBlockLists(section.type)) {
    const list = storefrontSettingAt(settings, path);
    if (!Array.isArray(list) || !list.some(isHidden)) continue;
    settings = storefrontSettingWith(settings, path, list.filter((item) => !isHidden(item)));
  }
  return settings === section.settings ? section : { ...section, settings } as Section;
}
