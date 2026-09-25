// Content blocks, bundles, template and EMI in the HTTP contract: the
// dashboard's product sections and the storefront product page.
import { z } from "@hono/zod-openapi";
import {
  PRODUCT_CONTENT_BLOCK_PLACEMENTS,
  PRODUCT_CONTENT_BLOCK_REGISTRY,
  PRODUCT_CONTENT_BLOCKS_MAX,
} from "@scalius/shared/product-content-blocks";
import { PRODUCT_BUNDLE_DISCOUNT_TYPES, PRODUCT_BUNDLES_MAX } from "@scalius/shared/product-bundles";

const placementSchema = z.enum(PRODUCT_CONTENT_BLOCK_PLACEMENTS);

/** A bundle tier in the decimal contract (editor and product page). */
export const productBundleTierSchema = z.object({
  quantity: z.number().int().min(2).max(100),
  discountType: z.enum(PRODUCT_BUNDLE_DISCOUNT_TYPES),
  /** `percentage`: the percentage off each unit; null for `fixed_price`. */
  discountPercentage: z.number().nullable(),
  /** `fixed_price`: the price of the whole set of `quantity` units; null for `percentage`. */
  price: z.number().nullable(),
  label: z.string().nullable(),
  isActive: z.boolean(),
}).openapi("ProductBundleTier");

const semanticPageFields = {
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  nextOffset: z.number().int().nonnegative().nullable(),
} as const;

/** The dashboard product sections added for merchandising (content blocks, template, bundles). */
export const productMerchandisingSectionResponseSchemas = [
  z.object({
    section: z.literal("content_blocks"),
    aggregateRevision: z.number().int().min(1),
    items: z.array(z.object({
      id: z.string(),
      placement: placementSchema,
      position: z.number().int().nonnegative(),
      type: z.string(),
      version: z.number().int().min(1),
      legacy: z.boolean().openapi({
        description: "A tab mirrored from Additional information: read-only here, edited through the additional_info section.",
      }),
      settingsCharacters: z.number().int().nonnegative(),
      settings: z.record(z.string(), z.unknown()).nullable().openapi({
        description: "Inline while the page stays small; null means read it with the content_block section (itemId).",
      }),
    })).max(PRODUCT_CONTENT_BLOCKS_MAX),
    ...semanticPageFields,
  }),
  z.object({
    section: z.literal("content_block"),
    aggregateRevision: z.number().int().min(1),
    itemId: z.string(),
    placement: placementSchema,
    position: z.number().int().nonnegative(),
    type: z.string(),
    version: z.number().int().min(1),
    legacy: z.boolean(),
    value: z.string().max(12_000).openapi({ description: "A chunk of the block's settings JSON text." }),
    totalCharacters: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    nextOffset: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    section: z.literal("template"),
    aggregateRevision: z.number().int().min(1),
    pageTemplate: z.string().nullable(),
  }),
  z.object({
    section: z.literal("bundles"),
    aggregateRevision: z.number().int().min(1),
    items: z.array(productBundleTierSchema.extend({ id: z.string() })).max(PRODUCT_BUNDLES_MAX),
  }),
] as const;

type RegistrySchemas = (typeof PRODUCT_CONTENT_BLOCK_REGISTRY)[keyof typeof PRODUCT_CONTENT_BLOCK_REGISTRY]["schema"];
const blockSchemas = Object.values(PRODUCT_CONTENT_BLOCK_REGISTRY).map((spec) =>
  (spec.schema as RegistrySchemas).extend({ id: z.string(), placement: placementSchema }));

/** One product page content block: its strict type and settings, id and placement. */
export const productPageContentBlockSchema = z.discriminatedUnion(
  "type",
  blockSchemas as unknown as [typeof blockSchemas[number], ...typeof blockSchemas],
).openapi("ProductPageContentBlock");

/** The product page's merchandising facts. */
export const productPageMerchandisingFields = {
  /** The product page template id from the theme; null renders the theme's default (today's classic page). */
  pageTemplate: z.string().nullable(),
  contentBlocks: z.array(productPageContentBlockSchema).max(PRODUCT_CONTENT_BLOCKS_MAX).openapi({
    description: "Blocks other than the tabs (`additionalInfo`), in placement then page order.",
  }),
  contentBlockMedia: z.array(z.object({
    id: z.string(),
    kind: z.enum(["image", "video"]),
    url: z.string(),
    altText: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    posterUrl: z.string().nullable(),
  })).openapi({ description: "The ready files the blocks name; a block's missing file is simply absent." }),
  bundles: z.array(productBundleTierSchema).max(PRODUCT_BUNDLES_MAX).openapi({
    description: "Active quantity tiers. Checkout prices them exactly this way (they add to promotions, which are evaluated at catalog prices).",
  }),
  emi: z.object({
    provider: z.string(),
    months: z.number().int(),
    monthly: z.number(),
    monthlyMinor: z.number().int(),
  }).nullable().openapi({
    description: "\"EMI on card payment, from X/month\": the lowest monthly amount of the store's EMI plans. Informational only (no checkout EMI); null unless the store has EMI plans on and the product is EMI-eligible.",
  }),
};
