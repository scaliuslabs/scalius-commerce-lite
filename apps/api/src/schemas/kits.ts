// Kits (a SKU made of other SKUs) and a product page's placed offers in the
// HTTP contract: the storefront product read and the dashboard's product
// sections (rules/catalog/kits-sell-as-components.md).
import { z } from "@hono/zod-openapi";
import { BUYER_AVAILABILITY_BANDS } from "@scalius/shared/buyer-availability";
import { KIT_COMPONENT_PROBLEMS } from "@scalius/core/modules/products";

const optionValuesSchema = z.array(z.object({ name: z.string(), value: z.string() })).max(5).openapi({
  description: "The SKU's chosen option values (platform, format), in option order.",
});

const deliverySchema = z.enum(["physical", "service", "digital_key", "digital_file"]).openapi({
  description: "How the item reaches the buyer, from its own fulfilment setting: shipped or picked up, performed, a licence key, or a file. The theme words it.",
});

export const storefrontKitSchema = z.object({
  components: z.array(z.object({
    variantId: z.string(),
    productId: z.string(),
    productName: z.string(),
    productSlug: z.string().nullable().openapi({ description: "Its product page; null when that page is not public." }),
    imageUrl: z.string().nullable(),
    imageMediaId: z.string().nullable(),
    imageAlt: z.string().nullable(),
    options: optionValuesSchema,
    quantity: z.number().int().min(1),
    delivery: deliverySchema,
    price: z.number().openapi({ description: "One unit's price in the page's currency." }),
  })).max(20),
  price: z.number().openapi({ description: "What one kit costs: its own price, never more than `compareAtPrice`. Send it as the cart line's price." }),
  compareAtPrice: z.number().openapi({ description: "Its items at their current prices, summed (computed on read)." }),
  saving: z.number(),
  savingPercent: z.number().int(),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS).openapi({
    description: "From its items: as many kits as the scarcest item allows; `out_of_stock` when an item can't be sold.",
  }),
}).openapi("StorefrontKit", { description: "A SKU made of other SKUs: checkout sells it as them." });

export const storefrontPlacedOfferSchema = z.object({
  variantId: z.string(),
  productId: z.string(),
  productName: z.string(),
  productSlug: z.string(),
  sku: z.string(),
  options: optionValuesSchema,
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  fulfillmentKind: z.string(),
  price: z.number().openapi({ description: "One unit's price in the page's currency (a kit's: its own price)." }),
  compareAtPrice: z.number().nullable().openapi({ description: "A kit's items summed; null for a SKU that is not a kit." }),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS),
  kit: z.union([storefrontKitSchema, z.null()]),
}).openapi("StorefrontPlacedOffer", { description: "A SKU of another product shown under this page's own offers." });

const problemSchema = z.enum(KIT_COMPONENT_PROBLEMS).openapi({
  description: "Why buyers can't buy it: its SKU or product was deleted, its product is a draft or archived, unpublished, or a gift card.",
});

/** The editor's `kits` section: the product's kit SKUs, in the store's currency. */
export const productKitsSectionSchema = z.object({
  section: z.literal("kits"),
  aggregateRevision: z.number().int().min(1),
  items: z.array(z.object({
    variantId: z.string(),
    sku: z.string(),
    ownPrice: z.number().openapi({ description: "The kit SKU's own price." }),
    price: z.number().openapi({ description: "What a buyer pays: its own price, never more than its items." }),
    compareAtPrice: z.number(),
    saving: z.number(),
    savingPercent: z.number().int(),
    availableQuantity: z.number().int().nonnegative().nullable().openapi({ description: "How many kits the items' stock allows; null when no item tracks stock." }),
    unavailable: z.array(z.object({ componentVariantId: z.string(), reason: problemSchema })).max(20).openapi({
      description: "Why buyers can't buy it now; empty when they can (stock allowing).",
    }),
    components: z.array(z.object({
      variantId: z.string(),
      productId: z.string().nullable(),
      productName: z.string().nullable(),
      sku: z.string().nullable(),
      options: optionValuesSchema,
      quantity: z.number().int().min(1),
      price: z.number().nullable(),
      stock: z.number().int().nullable().openapi({ description: "Available units (on hand less reserved); null when it does not track stock." }),
      problem: problemSchema.nullable(),
    })).max(20),
  })).max(100),
});

/** The editor's `page_offers` section. */
export const productPageOffersSectionSchema = z.object({
  section: z.literal("page_offers"),
  aggregateRevision: z.number().int().min(1),
  items: z.array(z.object({
    variantId: z.string(),
    productId: z.string().nullable(),
    productName: z.string().nullable(),
    sku: z.string().nullable(),
    options: optionValuesSchema,
    position: z.number().int().nonnegative(),
    isKit: z.boolean(),
    price: z.number().nullable(),
    problem: problemSchema.nullable(),
  })).max(20),
});

/** A page of the SKU picker (`dashboard.products.sku_options`). */
export const productSkuOptionsSchema = z.object({
  items: z.array(z.object({
    variantId: z.string(),
    productId: z.string(),
    productName: z.string(),
    productActive: z.boolean().openapi({ description: "False for a draft or archived product: a bundle holding it can't be sold." }),
    sku: z.string(),
    options: optionValuesSchema,
    imageUrl: z.string().nullable().openapi({ description: "The SKU's picture, else its product's." }),
    price: z.number().openapi({ description: "One unit's price in the store's currency, its discount applied." }),
    available: z.number().int().nullable().openapi({ description: "Units on hand less reserved; null when it does not track stock." }),
    isKit: z.boolean().openapi({ description: "It is a bundle (a SKU made of other SKUs): it can't be an item of another." }),
    isGiftCard: z.boolean().openapi({ description: "A gift card: it can't be in a bundle." }),
  })).max(20),
  page: z.number().int().min(1),
  hasMore: z.boolean(),
});
