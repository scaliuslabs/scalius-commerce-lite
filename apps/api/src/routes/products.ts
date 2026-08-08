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
const productDetailRecordSchema = z.record(z.string(), z.any());
const productDetailDataSchema = z.object({
  product: productDetailRecordSchema,
  category: productDetailRecordSchema.nullable(),
  media: z.array(productMediaSchema),
  variants: z.array(productDetailRecordSchema),
  relatedProducts: z.array(productDetailRecordSchema),
});
type ProductDetailData = z.infer<typeof productDetailDataSchema>;

// GET /api/storefront/products
const listProductsRoute = createRoute({
  method: "get",
  path: "/",
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
          variants: z.array(z.record(z.string(), z.unknown())),
        }).passthrough()),
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

// GET /api/storefront/products/:slug
const getProductBySlugRoute = createRoute({
  method: "get",
  path: "/{slug}",
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
