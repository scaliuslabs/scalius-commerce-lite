// src/server/routes/products.ts
// Storefront product routes — thin HTTP layer.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { PRODUCT_CONDITION_VALUES } from "@scalius/shared/product-condition";
import { BUYER_AVAILABILITY_BANDS } from "@scalius/shared/buyer-availability";
import {
  getStorefrontFeedProducts,
  getStorefrontSitemapProducts,
  getStorefrontProducts,
  getStorefrontProductBySlug,
  searchStorefrontProducts,
  DEFAULT_RECOMMENDATION_LIMIT,
  MAX_RECOMMENDATION_LIMIT,
  MAX_RECOMMENDATION_SOURCE_IDS,
  getStorefrontProductRecommendations,
  normalizeRecommendationSourceIds,
  STOREFRONT_PRODUCT_TEXT_CHUNK_MAX,
  getStorefrontProductSection,
  storefrontProductSectionQuerySchema,
  storefrontProductSectionSchema,
  resolvePublicAttributeFilters,
  getStorefrontProductComparison,
  normalizeCompareIds,
  MAX_COMPARE_PRODUCTS,
} from "@scalius/core/modules/catalog";
import { productFacetSchema } from "../schemas/catalog-facets";
import { NotFoundError, ValidationError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";
import { customizationViewSchema, fulfillmentKindSchema } from "../schemas/order-lines";

import { ok } from "../utils/api-response";
import { productPageMerchandisingFields } from "../schemas/product-merchandising";
import { productPageReviewFields } from "../schemas/reviews";
import {
  normalizePublicListingSearchParam,
  readRepeatedPublicQueryValues,
} from "../utils/public-search-query";
const app = new OpenAPIHono<{ Bindings: Env }>();

const PRODUCT_FEED_CURSOR_PATTERN = /^feed-v1\.[0-9a-z]+\.[A-Za-z0-9_-]+$/;

function validatePriceRange(
  value: { minPrice?: number; maxPrice?: number },
  ctx: z.RefinementCtx,
): void {
  if (
    value.minPrice !== undefined &&
    value.maxPrice !== undefined &&
    value.minPrice > value.maxPrice
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["maxPrice"],
      message: "Maximum price must be greater than or equal to minimum price",
    });
  }
}

// Review ratings on listing cards and the "N★ & up" facet (Wave B §2.4).
const cardRatingSchema = z.object({
  average: z.number().min(1).max(5).openapi({ description: "Average of the published reviews, two decimals truncated (4.66)." }),
  count: z.number().int().min(1).openapi({ description: "Published reviews." }),
}).nullable().openapi({ description: "Published-review rating; null when the product has no published review." });
const ratingFacetSchema = z.array(z.object({
  min: z.number().int().min(1).max(4).openapi({ description: "Whole stars: products averaging at least this (`minRating`)." }),
  count: z.number().int().min(0).openapi({ description: "Products matching the other selections and this threshold." }),
})).max(4).openapi({
  description: "\"N★ & up\" rating facet, highest first: empty when no product in scope has a published review, otherwise 4, 3, 2 (plus a selected `minRating`), counts may be 0.",
});
const minRatingQuerySchema = z.coerce.number().int().min(1).max(4).optional().openapi({
  description: "Only products whose published-review average is at least this many whole stars (1-4).",
});

const productFilterSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug or ID filter" }),
  search: z.string().optional().openapi({ description: "Search query" }),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
  sort: z
    .enum(["relevance", "newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount", "rating"])
    .optional()
    .openapi({ description: "Sort order. Defaults to relevance when `search` is set, otherwise newest. `rating`: the Bayesian review rank, unreviewed products last." }),
  minRating: minRatingQuerySchema,
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Discount filter" }),
  ids: z.string().optional().openapi({ description: "Comma-separated product IDs" })
}).superRefine(validatePriceRange);

const productSearchSchema = z.object({
  search: z.string().optional().default("").openapi({ description: "Search query" }),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10).openapi({ description: "Items per page" })
});

const productFeedSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug or ID filter" }),
  search: z.string().optional().openapi({ description: "Search query" }),
  cursor: z.string().max(512).regex(PRODUCT_FEED_CURSOR_PATTERN).optional().openapi({
    description: "Opaque continuation cursor returned by the previous feed response",
  }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(100).openapi({ description: "Items per page" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  ids: z.string().optional().openapi({
    description: "Comma-separated product IDs, product handles, variant IDs, or SKUs",
  }),
}).superRefine(validatePriceRange);

const productSitemapSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(5000).optional().default(100).openapi({ description: "Items per page" }),
});

// Storefront product list item
const storefrontProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  slug: z.string(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  hasVariants: z.boolean(),
  availableForSale: z.boolean(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  secondaryImageUrl: z.string().nullable().openapi({
    description: "The next photo in gallery order, for a card's hover swap. Never a video.",
  }),
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
  rating: cardRatingSchema,
}).passthrough();

const buyerPriceRangeSchema = z.object({
  min: z.number().min(0),
  max: z.number().min(0),
});


const storefrontFeedVariantSchema = z.object({
  id: z.string(),
  productId: z.string(),
  imageId: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  selectedOptions: z.array(z.object({
    optionDefinitionId: z.string(),
    optionValueId: z.string(),
    name: z.string(),
    value: z.string(),
    position: z.number().int(),
    valuePosition: z.number().int(),
    standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
  })),
  weight: z.number().nullable(),
  sku: z.string(),
  price: z.number(),
  stock: z.number(),
  reservedStock: z.number(),
  lowStockThreshold: z.number().int().nonnegative().nullable(),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS),
  isDefault: z.boolean(),
  trackInventory: z.boolean(),
  barcode: z.string().nullable(),
  barcodeType: z.string().nullable(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  deletedAt: z.string().nullable(),
});

const storefrontFeedAttributeSchema = z.object({
  name: z.string(),
  slug: z.string(),
  value: z.string(),
});

const storefrontFeedProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  canonicalPath: z.string().nullable(),
  options: z.array(z.object({
    id: z.string(),
    name: z.string(),
    position: z.number().int(),
    standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
  })),
  description: z.string().nullable(),
  price: z.number(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  discountedPrice: z.number(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  excludeFromProductFeed: z.boolean(),
  /** A buyer input is required: an agent (variant + quantity) cart can't buy it; send the buyer to the product page. */
  requiresCustomization: z.boolean(),
  productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
  hasVariants: z.boolean(),
  availableForSale: z.boolean(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  /** The published brand record; null means no brand (feeds omit `<g:brand>`, never a placeholder). */
  brand: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  attributes: z.array(storefrontFeedAttributeSchema),
  variants: z.array(storefrontFeedVariantSchema),
  updatedAt: z.string().nullable(),
});

const storefrontSitemapProductSchema = z.object({
  slug: z.string(),
  canonicalPath: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const productMediaSchema = z.object({
  id: z.string(),
  mediaId: z.string(),
  kind: z.enum(["image", "video"]),
  url: z.string(),
  posterMediaId: z.string().nullable(),
  posterUrl: z.string().nullable(),
  altText: z.string(),
  caption: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  isPrimary: z.boolean(),
  sortOrder: z.number().int().nonnegative(),
  status: z.enum(["ready", "trashed"]),
});

const selectedProductOptionSchema = z.object({
  optionDefinitionId: z.string(),
  optionValueId: z.string(),
  name: z.string(),
  value: z.string(),
  position: z.number().int(),
  valuePosition: z.number().int(),
  standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
});

const productSearchVariantSchema = z.object({
  id: z.string(),
  productId: z.string(),
  optionCombinationKey: z.string().nullable(),
  imageId: z.string().nullable(),
  selectedOptions: z.array(selectedProductOptionSchema),
  weight: z.number().nullable(),
  sku: z.string(),
  price: z.number(),
  stock: z.number(),
  reservedStock: z.number(),
  lowStockThreshold: z.number().int().nonnegative().nullable(),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS),
  isDefault: z.boolean(),
  trackInventory: z.boolean(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
});

const productOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.number().int(),
  standardMapping: z.enum(["size", "color", "material", "pattern", "none"]),
  values: z.array(z.object({
    id: z.string(),
    value: z.string(),
    position: z.number().int(),
  })),
});
const productOptionSummarySchema = productOptionSchema.omit({ values: true }).extend({
  valueCount: z.number().int().nonnegative(),
});
const productOptionValueSchema = z.object({
  id: z.string(),
  value: z.string(),
  position: z.number().int(),
});

const productAttributeSchema = z.object({
  name: z.string(),
  slug: z.string(),
  value: z.string(),
});

const productAdditionalInfoSchema = z.object({
  id: z.string(),
  title: z.string(),
  content: z.string(),
});

const productCategoryDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
});

const productDetailVariantSchema = z.object({
  id: z.string(),
  productId: z.string(),
  optionCombinationKey: z.string().nullable(),
  imageId: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  selectedOptions: z.array(selectedProductOptionSchema),
  weight: z.number().nullable(),
  sku: z.string(),
  price: z.number(),
  stock: z.number(),
  reservedStock: z.number(),
  lowStockThreshold: z.number().int().nonnegative().nullable(),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS),
  isDefault: z.boolean(),
  trackInventory: z.boolean(),
  barcode: z.string().nullable(),
  barcodeType: z.string().nullable(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  /** physical (shipped or picked up), digital, or service (performed, no delivery). */
  fulfillmentKind: fulfillmentKindSchema,
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const recommendedProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  slug: z.string(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  discountedPrice: z.number(),
  hasVariants: z.boolean(),
  availableForSale: z.boolean(),
  priceVaries: z.boolean(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  secondaryImageUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  rating: cardRatingSchema,
});

const productRecommendationsSchema = z.object({
  reason: z.enum(["also_bought", "similar", "popular", "new_arrivals"]).openapi({
    description:
      "What the list mostly is, for an honest title: `also_bought` only when at least half the products were bought together with the source products by two or more different buyers; `similar` for category, collection, attribute and price matches; `popular` and `new_arrivals` for lists without source products.",
  }),
  products: z.array(recommendedProductSchema),
});

const productDetailDataSchema = z.object({
  product: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    price: z.number(),
    categoryId: z.string().nullable(),
    slug: z.string(),
    metaTitle: z.string().nullable(),
    metaDescription: z.string().nullable(),
    canonicalPath: z.string().nullable(),
    productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
    noIndex: z.boolean(),
    discountType: z.string(),
    discountPercentage: z.number(),
    discountAmount: z.number(),
    discountedPrice: z.number(),
    freeDelivery: z.boolean(),
    isActive: z.boolean(),
    deletedAt: z.string().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    hasVariants: z.boolean(),
    imageUrl: z.string().nullable(),
    imageMediaId: z.string().nullable(),
    imageAlt: z.string().nullable(),
    options: z.array(productOptionSchema),
    features: z.array(z.string()),
    /** Gift-card product: every SKU is a denomination (Wave B). */
    isGiftCard: z.boolean(),
    /** Buyer inputs asked above Add to cart; null when none. Posted in the cart line body, never a URL. */
    customization: customizationViewSchema.nullable(),
    /** Some buyer input is required: quick-buy links must send the buyer to this page. */
    requiresCustomization: z.boolean(),
    /** The saved buyer-input schema is unreadable: the product can't be bought until the store fixes it. */
    customizationUnavailable: z.boolean(),
    attributes: z.array(productAttributeSchema),
    additionalInfo: z.array(productAdditionalInfoSchema),
    /** The published brand record (JSON-LD `brand`, the buy-box brand link); null means none. */
    brand: z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      canonicalPath: z.string().nullable(),
    }).nullable(),
    ...productPageMerchandisingFields,
    ...productPageReviewFields,
    offers: z.array(z.object({
      promotionId: z.string(),
      title: z.string(),
      role: z.enum(["buy", "get"]).openapi({
        description: "\"buy\": this product counts toward the offer and `products` are what the buyer gets; \"get\": this product is what the buyer gets and `products` are what to buy.",
      }),
      buyQuantity: z.number().int().nullable(),
      buyAmount: z.number().nullable(),
      getQuantity: z.number().int(),
      percentOff: z.number().openapi({ description: "100 means the items to get are free." }),
      endsAtEpochSeconds: z.number().int().nullable(),
      products: z.array(z.object({
        id: z.string(),
        slug: z.string(),
        name: z.string(),
        variantId: z.string().nullable(),
        price: z.number().nullable(),
      })),
    })).openapi({ description: "Active automatic Buy X get Y discounts this product counts toward or is given by." }),
  }),
  category: productCategoryDetailSchema.nullable(),
  media: z.array(productMediaSchema),
  variants: z.array(productDetailVariantSchema),
  recommendations: productRecommendationsSchema,
});
type ProductDetailData = z.infer<typeof productDetailDataSchema>;

const storefrontProductSectionPageFields = <T extends z.ZodTypeAny>(item: T, maxItems: number) => ({
  items: z.array(item).max(maxItems),
  total: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(maxItems),
  nextOffset: z.number().int().nonnegative().nullable(),
});

const productSectionSummarySchema = z.object({
  section: z.literal("summary"),
  product: z.object({
    id: z.string(),
    name: z.string(),
    price: z.number(),
    categoryId: z.string().nullable(),
    slug: z.string(),
    canonicalPath: z.string().nullable(),
    productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
    noIndex: z.boolean(),
    discountType: z.string(),
    discountPercentage: z.number(),
    discountAmount: z.number(),
    discountedPrice: z.number(),
    freeDelivery: z.boolean(),
    hasVariants: z.boolean(),
    imageUrl: z.string().nullable(),
    imageMediaId: z.string().nullable(),
    imageAlt: z.string().nullable(),
    createdAt: z.string().nullable(),
    updatedAt: z.string().nullable(),
    category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
    textLengths: z.object({
      description: z.number().int().nonnegative(),
      metaTitle: z.number().int().nonnegative(),
      metaDescription: z.number().int().nonnegative(),
    }),
    counts: z.object({
      media: z.number().int().nonnegative(),
      attributes: z.number().int().nonnegative(),
      additionalInfo: z.number().int().nonnegative(),
      options: z.number().int().nonnegative(),
      variants: z.number().int().nonnegative(),
      relatedProducts: z.number().int().nonnegative(),
    }),
  }),
});

const productSectionTextSchema = z.object({
  section: z.enum(["text", "additional_info_text"]),
  itemId: z.string().optional(),
  field: z.enum(["description", "metaTitle", "metaDescription", "title", "content"]),
  value: z.string().max(STOREFRONT_PRODUCT_TEXT_CHUNK_MAX),
  totalCharacters: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative().nullable(),
  isNull: z.boolean(),
});

const productSectionVariantSchema = productDetailVariantSchema.omit({
  stock: true,
  reservedStock: true,
  lowStockThreshold: true,
  trackInventory: true,
  deletedAt: true,
});

const storefrontProductSectionResponseSchema = z.union([
  productSectionSummarySchema,
  productSectionTextSchema,
  z.object({ section: z.literal("media"), ...storefrontProductSectionPageFields(productMediaSchema, 20) }),
  z.object({ section: z.literal("attributes"), ...storefrontProductSectionPageFields(productAttributeSchema, 50) }),
  z.object({
    section: z.literal("additional_info"),
    ...storefrontProductSectionPageFields(z.object({
      id: z.string(),
      titleCharacters: z.number().int().nonnegative(),
      contentCharacters: z.number().int().nonnegative(),
    }), 50),
  }),
  z.object({ section: z.literal("options"), ...storefrontProductSectionPageFields(productOptionSummarySchema, 5) }),
  z.object({
    section: z.literal("option_values"),
    itemId: z.string(),
    ...storefrontProductSectionPageFields(productOptionValueSchema, 50),
  }),
  z.object({ section: z.literal("variants"), ...storefrontProductSectionPageFields(productSectionVariantSchema, 10) }),
  z.object({ section: z.literal("related_products"), ...storefrontProductSectionPageFields(recommendedProductSchema, 10) }),
]);

// GET /api/storefront/products
const listProductsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.products.list",
  tags: ["Products"],
  summary: "List storefront products",
  request: {
    query: productFilterSchema
  },
  responses: {
    200: {
      description: "Product list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(storefrontProductSchema),
        pagination: paginationSchema,
        priceRange: buyerPriceRangeSchema,
        facets: z.array(productFacetSchema),
        ratingFacet: ratingFacetSchema,
        correctedQuery: z.string().nullable().openapi({
          description: "Set when `search` matched nothing and these products are for the closest catalog words instead (typo or Bangla correction).",
        }),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(listProductsRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("query");
  const queryParams = readRepeatedPublicQueryValues(c.req.url);
  const search = normalizePublicListingSearchParam(params.search);

  const attributeFilters = await resolvePublicAttributeFilters(
    db,
    queryParams,
    Object.keys(params),
  );

  const result = await getStorefrontProducts(db, { ...params, search, attributeFilters });
  return ok(c, result);
});

// GET /api/storefront/products/search
const searchProductsRoute = createRoute({
  method: "get",
  path: "/search",
  operationId: "storefront.products.search_legacy",
  tags: ["Products"],
  summary: "Search storefront products with variant data",
  request: {
    query: productSearchSchema
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: successEnvelope(z.object({
        data: z.array(z.object({
          id: z.string(),
          name: z.string(),
          price: z.number(),
          slug: z.string(),
          imageUrl: z.string().nullable(),
          imageMediaId: z.string().nullable(),
          imageAlt: z.string().nullable(),
          discountType: z.string().nullable(),
          discountPercentage: z.number().nullable(),
          discountAmount: z.number().nullable(),
          freeDelivery: z.boolean(),
          variants: z.array(productSearchVariantSchema),
        })),
        pagination: paginationSchema.extend({ hasNextPage: z.boolean(), hasPrevPage: z.boolean() }),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(searchProductsRoute, async (c) => {
  const db = c.get("db");
  const { search, page, limit } = c.req.valid("query");
  const normalizedSearch = normalizePublicListingSearchParam(search) ?? "";
  const result = await searchStorefrontProducts(db, { search: normalizedSearch, page, limit });
  return ok(c, result);
});

// GET /api/storefront/products/feed
const feedProductsRoute = createRoute({
  method: "get",
  path: "/feed",
  tags: ["Products"],
  summary: "List storefront products for catalog feeds",
  request: {
    query: productFeedSchema
  },
  responses: {
    200: {
      description: "Feed product list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(storefrontFeedProductSchema),
        pagination: z.object({
          limit: z.number().int().min(1).max(100),
          cursor: z.string().optional(),
          hasNextPage: z.boolean(),
        }),
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(feedProductsRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("query");
  const search = normalizePublicListingSearchParam(params.search);
  const result = await getStorefrontFeedProducts(db, { ...params, search });
  return ok(c, result);
});

// GET /api/v1/products/sitemap
const sitemapProductsRoute = createRoute({
  method: "get",
  path: "/sitemap",
  tags: ["Products"],
  summary: "List storefront products for XML sitemaps",
  request: {
    query: productSitemapSchema
  },
  responses: {
    200: {
      description: "Sitemap product list with pagination",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(storefrontSitemapProductSchema),
        pagination: paginationSchema,
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(sitemapProductsRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("query");
  const result = await getStorefrontSitemapProducts(db, params);
  return ok(c, result);
});

// GET /api/v1/products/recommendations
const productRecommendationsRoute = createRoute({
  method: "get",
  path: "/recommendations",
  operationId: "storefront.products.list_recommendations",
  tags: ["Products"],
  summary: "Recommend products for products the buyer is looking at or has in the cart",
  description:
    "Ranked buyable products for the given source products (excluding them): bought together first, then same category, collection, attributes and price band, then popular or newest. Without `productIds` it returns popular products, or the newest when there is not enough order history.",
  request: {
    query: z.object({
      productIds: z.string().max(4_000).optional().openapi({
        description: `Comma-separated product IDs, such as the cart's products. At most ${MAX_RECOMMENDATION_SOURCE_IDS} are used.`,
      }),
      limit: z.coerce.number().int().min(1).max(MAX_RECOMMENDATION_LIMIT).optional()
        .default(DEFAULT_RECOMMENDATION_LIMIT)
        .openapi({ description: "Products to return" }),
    }),
  },
  responses: {
    200: {
      description: "Recommended products and what kind of list it is",
      content: { "application/json": { schema: successEnvelope(productRecommendationsSchema) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(productRecommendationsRoute, async (c) => {
  const { productIds, limit } = c.req.valid("query");
  const result = await getStorefrontProductRecommendations(c.get("db"), {
    productIds: normalizeRecommendationSourceIds(productIds),
    limit,
  });
  return ok(c, result);
});

// GET /api/v1/products/compare?ids=
const compareProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  price: z.number(),
  discountedPrice: z.number(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  priceVaries: z.boolean(),
  hasVariants: z.boolean(),
  availableForSale: z.boolean(),
  availabilityBand: z.enum(BUYER_AVAILABILITY_BANDS),
  brand: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
});

const productSpecGroupSchema = z.object({
  id: z.string().nullable().openapi({ description: "The attribute group; null for attributes without one (listed last)." }),
  name: z.string().nullable(),
  rows: z.array(z.object({
    attributeId: z.string(),
    name: z.string(),
    slug: z.string(),
    unit: z.string().nullable(),
    keySpec: z.boolean(),
    highlight: z.boolean(),
    values: z.array(z.string().nullable()).max(MAX_COMPARE_PRODUCTS).openapi({
      description: "One display value per compared product, in `products` order; null where the product has none.",
    }),
  })),
});

const compareProductsRoute = createRoute({
  method: "get",
  path: "/compare",
  operationId: "storefront.products.compare",
  tags: ["Products"],
  summary: "Compare up to four products side by side",
  description:
    `Public products and their specs grouped by attribute group, one value column per product in the requested order. Ids that are not public are left out. At most ${MAX_COMPARE_PRODUCTS} ids.`,
  request: {
    query: z.object({
      ids: z.string().trim().min(1).max(1_000).openapi({ description: "Comma-separated product IDs." }),
    }),
  },
  responses: {
    200: {
      description: "The compared products and their grouped specs",
      content: {
        "application/json": {
          schema: successEnvelope(z.object({
            products: z.array(compareProductSchema).max(MAX_COMPARE_PRODUCTS),
            groups: z.array(productSpecGroupSchema),
          })),
        },
      },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  },
});

app.openapi(compareProductsRoute, async (c) => {
  const ids = normalizeCompareIds(c.req.valid("query").ids);
  if (ids.length === 0 || ids.length > MAX_COMPARE_PRODUCTS) {
    throw new ValidationError(`Compare 1 to ${MAX_COMPARE_PRODUCTS} products.`);
  }
  return ok(c, await getStorefrontProductComparison(c.get("db"), ids));
});

// GET /api/storefront/products/:slug/sections/:section
const getProductSectionRoute = createRoute({
  method: "get",
  path: "/{slug}/sections/{section}",
  operationId: "storefront.products.get_section",
  tags: ["Products"],
  summary: "Get one bounded, reconstructable storefront product section",
  request: {
    params: z.object({
      slug: z.string().trim().min(1).max(100),
      section: storefrontProductSectionSchema,
    }),
    query: storefrontProductSectionQuerySchema,
  },
  responses: {
    200: {
      description: "Bounded public product section",
      content: { "application/json": { schema: successEnvelope(storefrontProductSectionResponseSchema) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getProductSectionRoute, async (c) => {
  const db = c.get("db");
  const { slug, section } = c.req.valid("param");
  const result = await getStorefrontProductSection(db, slug, section, c.req.valid("query"));
  if (!result) throw new NotFoundError("Product not found");
  return ok(c, result as z.infer<typeof storefrontProductSectionResponseSchema>);
});

// GET /api/storefront/products/:slug
const getProductBySlugRoute = createRoute({
  method: "get",
  path: "/{slug}",
  operationId: "storefront.products.get",
  tags: ["Products"],
  summary: "Get product by slug",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Product details",
      content: { "application/json": { schema: successEnvelope(productDetailDataSchema) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getProductBySlugRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const result = await getStorefrontProductBySlug(db, slug);
  if (!result) throw new NotFoundError("Product not found");
  return ok(c, result as unknown as ProductDetailData);
});

export { app as productRoutes };
