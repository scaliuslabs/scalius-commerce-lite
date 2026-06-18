import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { getPublicCategories, getPublicCategoryBySlug } from "@scalius/core/modules/categories/categories.storefront";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/attributes/attributes.public";
import { getStorefrontCategoryProducts } from "@scalius/core/modules/products/products.storefront";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
import { CACHE_TTLS } from "../utils/cache-ttls";
// Create an OpenAPIHono app for category routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:categories:",
    varyByQuery: true,
    queryDefaults: (c) =>
      c.req.path.replace(/\/$/, "").endsWith("/products")
        ? { page: 1, limit: 20, sort: "newest" }
        : {},
    methods: ["GET"]
  }),
);

// Schema for category product filtering
const categoryProductFilterSchema = z.object({
  page: z.coerce.number().optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().optional().default(20).openapi({ description: "Items per page" }),
  sort: z
    .enum([
      "newest",
      "price-asc",
      "price-desc",
      "name-asc",
      "name-desc",
      "discount",
    ])
    .optional()
    .default("newest")
    .openapi({ description: "Sort order" }),
  search: z.string().optional().openapi({ description: "Search within category" }),
  minPrice: z.coerce.number().optional().openapi({ description: "Minimum price filter" }),
  maxPrice: z.coerce.number().optional().openapi({ description: "Maximum price filter" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Has discount filter" })
});

const storefrontCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
}).passthrough();

type AppliedFilterValue =
  | string
  | number
  | Array<{ slug: string; value: string }>;

// GET /categories — list all categories
const listCategoriesRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Categories"],
  summary: "List all categories",
  responses: {
    200: {
      description: "Category list",
      content: { "application/json": { schema: successEnvelope(z.object({
        categories: z.array(storefrontCategorySchema),
      })) } },
    },
    500: errorResponses[500],
  }
});

app.openapi(listCategoriesRoute, async (c) => {
  const db = c.get("db");
  const categoriesList = await getPublicCategories(db);
  return ok(c, { categories: categoriesList });
});

// GET /categories/:slug — get category by slug
const getCategoryBySlugRoute = createRoute({
  method: "get",
  path: "/{slug}",
  tags: ["Categories"],
  summary: "Get category by slug",
  request: {
    params: z.object({
      slug: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Category details",
      content: { "application/json": { schema: successEnvelope(z.object({
        category: storefrontCategorySchema,
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCategoryBySlugRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const category = await getPublicCategoryBySlug(db, slug);
  if (!category) throw new NotFoundError("Category not found");
  return ok(c, { category });
});

// GET /categories/:slug/products — get products in a category
const getCategoryProductsRoute = createRoute({
  method: "get",
  path: "/{slug}/products",
  tags: ["Categories"],
  summary: "Get products in a category with filtering",
  request: {
    params: z.object({
      slug: z.string(),
    }),
    query: categoryProductFilterSchema
  },
  responses: {
    200: {
      description: "Category products with pagination and filters",
      content: { "application/json": { schema: successEnvelope(z.object({
        category: storefrontCategorySchema,
        products: z.array(z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          price: z.number(),
          discountType: z.string().nullable(),
          discountPercentage: z.number().nullable(),
          discountAmount: z.number().nullable(),
          discountedPrice: z.number(),
        }).passthrough()),
        pagination: paginationSchema,
        appliedFilters: z.record(z.string(), z.any()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCategoryProductsRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const params = c.req.valid("query");
  const queryParams = c.req.query();
  const [category, attributeFilters] = await Promise.all([
    getPublicCategoryBySlug(db, slug),
    resolvePublicAttributeFilters(db, queryParams, Object.keys(params)),
  ]);

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  const categoryForProducts = {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    imageUrl: category.imageUrl,
    metaTitle: category.metaTitle,
    metaDescription: category.metaDescription,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };

  const result = await getStorefrontCategoryProducts(db, categoryForProducts, {
    ...params,
    attributeFilters,
  });

  const appliedFilters: Record<string, AppliedFilterValue> = {
    attributes: attributeFilters,
    sort: params.sort,
  };
  if (params.search !== undefined) appliedFilters.search = params.search;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;

  return ok(c, {
    category: categoryForProducts,
    products: result.products,
    pagination: result.pagination,
    appliedFilters,
  });
});

// Export the category routes
export { app as categoryRoutes };
