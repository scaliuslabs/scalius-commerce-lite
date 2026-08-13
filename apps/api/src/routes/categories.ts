import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  getPublicCategories,
  getPublicCategoryBySlug,
  getPublicCategorySection,
} from "@scalius/core/modules/categories/categories.storefront";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/attributes/attributes.public";
import { getStorefrontCategoryProducts } from "@scalius/core/modules/products/products.storefront";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
import {
  normalizePublicFtsSearchQuery,
  normalizePublicListingSearchParam,
  readRepeatedPublicQueryValues,
} from "../utils/public-search-query";
// Create an OpenAPIHono app for category routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Schema for category product filtering
const categoryProductFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
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
  search: z.string().trim().max(100).optional().openapi({ description: "Search within category" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Has discount filter" })
}).superRefine((value, ctx) => {
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
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
});

const storefrontCategoryDetailSchema = storefrontCategorySchema.extend({
  content: z.string().nullable(),
});

const productFacetSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  values: z.array(z.object({ value: z.string(), count: z.number().int().min(0) })),
});

const storefrontCategoryProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  price: z.number(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
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
});

const appliedCategoryFiltersSchema = z.object({
  attributes: z.array(z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    values: z.array(z.string()),
  })),
  sort: z.enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount"]),
  search: z.string().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
});

const agentCategoryProductFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(20).optional().default(20),
  sort: z.enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount"])
    .optional().default("newest"),
  search: z.string().trim().max(100).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
}).superRefine((value, ctx) => {
  if (value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice) {
    ctx.addIssue({ code: "custom", path: ["maxPrice"], message: "Maximum price must be greater than or equal to minimum price" });
  }
});

const publicCategorySlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

const storefrontCategorySectionSchema = z.enum(["summary", "text"]);
const storefrontCategoryTextFieldSchema = z.enum(["description", "content"]);

// GET /categories — list all categories
const listCategoriesRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.categories.list",
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
  operationId: "storefront.categories.get",
  tags: ["Categories"],
  summary: "Get category by slug",
  request: {
    params: z.object({
      slug: publicCategorySlugSchema,
    }),
  },
  responses: {
    200: {
      description: "Category details",
      content: { "application/json": { schema: successEnvelope(z.object({
        category: storefrontCategoryDetailSchema,
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

const getCategorySectionRoute = createRoute({
  method: "get",
  path: "/{slug}/sections/{section}",
  operationId: "storefront.categories.get_section",
  tags: ["Categories"],
  summary: "Get a bounded category section",
  request: {
    params: z.object({
      slug: publicCategorySlugSchema,
      section: storefrontCategorySectionSchema,
    }),
    query: z.object({
      field: storefrontCategoryTextFieldSchema.optional(),
      offset: z.coerce.number().int().min(0).max(100_000).optional().default(0),
    }),
  },
  responses: {
    200: {
      description: "Bounded category section",
      content: { "application/json": { schema: successEnvelope(z.union([
        z.object({
          section: z.literal("summary"),
          category: z.object({
            id: z.string(),
            name: z.string(),
            slug: z.string(),
            imageUrl: z.string().nullable(),
            metaTitle: z.string().nullable(),
            metaDescription: z.string().nullable(),
            canonicalPath: z.string().nullable(),
            noIndex: z.boolean(),
            excludeFromSitemap: z.boolean(),
            descriptionCharacters: z.number().int().min(0),
            contentCharacters: z.number().int().min(0),
            createdAt: z.string().nullable(),
            updatedAt: z.string().nullable(),
          }),
        }),
        z.object({
          section: z.literal("text"),
          field: storefrontCategoryTextFieldSchema,
          value: z.string().max(12_000),
          totalCharacters: z.number().int().min(0),
          offset: z.number().int().min(0),
          nextOffset: z.number().int().min(0).nullable(),
          isNull: z.boolean(),
        }),
      ])) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getCategorySectionRoute, async (c) => {
  const { slug, section } = c.req.valid("param");
  const query = c.req.valid("query");
  const result = await getPublicCategorySection(c.get("db"), slug, section, query);
  if (!result) throw new NotFoundError("Category not found");
  return ok(c, result);
});

// GET /categories/:slug/products — get products in a category
const getCategoryProductsRoute = createRoute({
  method: "get",
  path: "/{slug}/products",
  operationId: "storefront.categories.list_products",
  tags: ["Categories"],
  summary: "Get products in a category with filtering",
  request: {
    params: z.object({
      slug: publicCategorySlugSchema,
    }),
    query: categoryProductFilterSchema
  },
  responses: {
    200: {
      description: "Category products with pagination and filters",
      content: { "application/json": { schema: successEnvelope(z.object({
        category: storefrontCategoryDetailSchema,
        products: z.array(storefrontCategoryProductSchema),
        pagination: paginationSchema,
        priceRange: z.object({
          min: z.number().min(0),
          max: z.number().min(0),
        }),
        facets: z.array(productFacetSchema),
        appliedFilters: appliedCategoryFiltersSchema,
      })) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCategoryProductsRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const params = c.req.valid("query");
  const queryParams = readRepeatedPublicQueryValues(c.req.url);
  const [category, attributeFilters] = await Promise.all([
    getPublicCategoryBySlug(db, slug),
    resolvePublicAttributeFilters(db, queryParams, Object.keys(params)),
  ]);

  if (!category) {
    throw new NotFoundError("Category not found");
  }
  const normalizedSearch = normalizePublicFtsSearchQuery(params.search);
  const search = normalizePublicListingSearchParam(params.search);

  const categoryForProducts = {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    content: category.content,
    imageUrl: category.imageUrl,
    metaTitle: category.metaTitle,
    metaDescription: category.metaDescription,
    canonicalPath: category.canonicalPath,
    noIndex: category.noIndex,
    excludeFromSitemap: category.excludeFromSitemap,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };

  const result = await getStorefrontCategoryProducts(db, categoryForProducts, {
    ...params,
    search,
    attributeFilters,
  });

  const appliedFilters: z.infer<typeof appliedCategoryFiltersSchema> = {
    attributes: attributeFilters,
    sort: params.sort,
  };
  if (normalizedSearch) appliedFilters.search = normalizedSearch;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;

  return ok(c, {
    category: categoryForProducts,
    products: result.products,
    pagination: result.pagination,
    priceRange: result.priceRange,
    facets: result.facets,
    appliedFilters,
  });
});

const getCategoryProductSummariesRoute = createRoute({
  method: "get",
  path: "/{slug}/product-summaries",
  operationId: "storefront.categories.list_product_summaries",
  tags: ["Categories"],
  summary: "Get a bounded page of products in a category",
  request: {
    params: z.object({ slug: publicCategorySlugSchema }),
    query: agentCategoryProductFilterSchema,
  },
  responses: {
    200: {
      description: "Bounded category product summaries",
      content: { "application/json": { schema: successEnvelope(z.object({
        category: z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          imageUrl: z.string().nullable(),
          canonicalPath: z.string().nullable(),
          noIndex: z.boolean(),
          excludeFromSitemap: z.boolean(),
          descriptionCharacters: z.number().int().min(0),
          contentCharacters: z.number().int().min(0),
        }),
        products: z.array(storefrontCategoryProductSchema).max(20),
        pagination: paginationSchema,
        priceRange: z.object({ min: z.number().min(0), max: z.number().min(0) }),
        facets: z.array(productFacetSchema),
        appliedFilters: appliedCategoryFiltersSchema,
      })) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getCategoryProductSummariesRoute, async (c) => {
  const { slug } = c.req.valid("param");
  const params = c.req.valid("query");
  const summary = await getPublicCategorySection(c.get("db"), slug, "summary");
  if (!summary || summary.section !== "summary") throw new NotFoundError("Category not found");
  const category = summary.category;
  const queryParams = readRepeatedPublicQueryValues(c.req.url);
  const attributeFilters = await resolvePublicAttributeFilters(c.get("db"), queryParams, Object.keys(params));
  const result = await getStorefrontCategoryProducts(c.get("db"), {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: null,
    imageUrl: category.imageUrl,
    metaTitle: category.metaTitle,
    metaDescription: category.metaDescription,
    canonicalPath: category.canonicalPath,
    noIndex: category.noIndex,
    excludeFromSitemap: category.excludeFromSitemap,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  }, {
    ...params,
    search: normalizePublicListingSearchParam(params.search),
    attributeFilters,
  });
  const appliedFilters: z.infer<typeof appliedCategoryFiltersSchema> = {
    attributes: attributeFilters,
    sort: params.sort,
  };
  const normalizedSearch = normalizePublicFtsSearchQuery(params.search);
  if (normalizedSearch) appliedFilters.search = normalizedSearch;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;
  return ok(c, {
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      imageUrl: category.imageUrl,
      canonicalPath: category.canonicalPath,
      noIndex: category.noIndex,
      excludeFromSitemap: category.excludeFromSitemap,
      descriptionCharacters: category.descriptionCharacters,
      contentCharacters: category.contentCharacters,
    },
    ...result,
    appliedFilters,
  });
});

// Export the category routes
export { app as categoryRoutes };
