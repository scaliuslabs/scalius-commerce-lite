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
} from "@scalius/core/modules/products/products.storefront";
import {
  STOREFRONT_PRODUCT_TEXT_CHUNK_MAX,
  getStorefrontProductSection,
  storefrontProductSectionQuerySchema,
  storefrontProductSectionSchema,
} from "@scalius/core/modules/products/products.storefront-sections";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/attributes/attributes.public";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
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

const productFilterSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug or ID filter" }),
  search: z.string().optional().openapi({ description: "Search query" }),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
  sort: z
    .enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount"])
    .optional()
    .default("newest")
    .openapi({ description: "Sort order" }),
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
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
}).passthrough();

const buyerPriceRangeSchema = z.object({
  min: z.number().min(0),
  max: z.number().min(0),
});

const productFacetSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  values: z.array(z.object({ value: z.string(), count: z.number().int().min(0) })),
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
  productCondition: z.enum(PRODUCT_CONDITION_VALUES).nullable(),
  hasVariants: z.boolean(),
  availableForSale: z.boolean(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
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
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

const relatedProductSchema = z.object({
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
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
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
    attributes: z.array(productAttributeSchema),
    additionalInfo: z.array(productAdditionalInfoSchema),
  }),
  category: productCategoryDetailSchema.nullable(),
  media: z.array(productMediaSchema),
  variants: z.array(productDetailVariantSchema),
  relatedProducts: z.array(relatedProductSchema),
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
  z.object({ section: z.literal("related_products"), ...storefrontProductSectionPageFields(relatedProductSchema, 10) }),
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
