// src/server/routes/products.ts
// Storefront product routes — thin HTTP layer.
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cacheMiddleware } from "../middleware/cache";
import {
  getStorefrontProducts,
  getStorefrontProductBySlug,
  searchStorefrontProducts
} from "@scalius/core/modules/products/products.storefront";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/attributes/attributes.public";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
import { CACHE_TTLS } from "../utils/cache-ttls";
import {
  isPublicProductListCacheable,
  isPublicProductSearchCacheable,
  normalizePublicFtsSearchCacheValue,
  normalizePublicIntegerCacheValue,
  normalizePublicListingSearchParam,
  normalizePublicNumberCacheValue,
} from "../utils/public-search-query";
const app = new OpenAPIHono<{ Bindings: Env }>();

app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:products:",
    varyByQuery: true,
    queryDefaults: (c) => {
      const normalizedPath = c.req.path.replace(/\/$/, "");
      if (normalizedPath.endsWith("/products/search")) {
        return { search: "", page: 1, limit: 10 };
      }
      if (normalizedPath.endsWith("/products")) {
        return { page: 1, limit: 20, sort: "newest" };
      }
      return {};
    },
    queryNormalizers: {
      search: normalizePublicFtsSearchCacheValue,
      page: normalizePublicIntegerCacheValue,
      limit: normalizePublicIntegerCacheValue,
      minPrice: normalizePublicNumberCacheValue,
      maxPrice: normalizePublicNumberCacheValue,
    },
    cacheCondition: (c) => {
      const normalizedPath = c.req.path.replace(/\/$/, "");
      if (normalizedPath.endsWith("/products/search")) {
        return isPublicProductSearchCacheable(c.req.url);
      }
      if (normalizedPath.endsWith("/products")) {
        return isPublicProductListCacheable(c.req.url);
      }
      return true;
    },
    methods: ["GET"]
  }),
);

const productFilterSchema = z.object({
  category: z.string().optional().openapi({ description: "Category slug filter" }),
  search: z.string().optional().openapi({ description: "Search query" }),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
  sort: z
    .enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount"])
    .optional()
    .default("newest")
    .openapi({ description: "Sort order" }),
  minPrice: z.coerce.number().optional().openapi({ description: "Minimum price filter" }),
  maxPrice: z.coerce.number().optional().openapi({ description: "Maximum price filter" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Discount filter" }),
  ids: z.string().optional().openapi({ description: "Comma-separated product IDs" })
});

const productSearchSchema = z.object({
  search: z.string().optional().default("").openapi({ description: "Search query" }),
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(10).openapi({ description: "Items per page" })
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
  imageUrl: z.string().nullable(),
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  discountedPrice: z.number(),
}).passthrough();

const productDetailRecordSchema = z.record(z.string(), z.any());
const productDetailDataSchema = z.object({
  product: productDetailRecordSchema,
  category: productDetailRecordSchema.nullable(),
  images: z.array(productDetailRecordSchema),
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
      })) } },
    },
    400: errorResponses[400],
    500: errorResponses[500],
  }
});

app.openapi(listProductsRoute, async (c) => {
  const db = c.get("db");
  const params = c.req.valid("query");
  const queryParams = c.req.query();
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
