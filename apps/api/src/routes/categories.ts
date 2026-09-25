import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  CATEGORY_CHILDREN_LIMIT,
  CATEGORY_TREE_LINK_LIMIT,
  getPublicCategories,
  getPublicCategorySummaries,
  getPublicCategoryBySlug,
  getPublicCategoryBreadcrumb,
  getPublicCategoryChildren,
  getPublicCategorySection,
  getPublicCategorySitemapEntries,
  getPublicCategoryTree,
} from "@scalius/core/modules/categories";
import { getStorefrontCategoryProducts, resolvePublicAttributeFilters } from "@scalius/core/modules/catalog";
import { appliedFacetFilterSchema, appliedFacetFilters, productFacetSchema } from "../schemas/catalog-facets";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, paginationSchema, errorResponses } from "../schemas/responses";

import { ok } from "../utils/api-response";
import {
  normalizePublicFtsSearchQuery,
  normalizePublicListingSearchParam,
  readRepeatedPublicQueryValues,
} from "../utils/public-search-query";
import { optionalProductCardFacts } from "../schemas/product-card-facts";
// Create an OpenAPIHono app for category routes
const app = new OpenAPIHono<{ Bindings: Env }>();

/** Whether a category listing includes its published sub-categories' products. */
const includeSubcategoriesSchema = z
  .enum(["true", "false"])
  .optional()
  .default("true")
  .openapi({
    description:
      "List products of the category's published sub-categories too (default). \"false\" lists the category's own products only.",
  });

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

const listingSortSchema = z.enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount", "rating"]);

// Schema for category product filtering
const categoryProductFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
  sort: listingSortSchema
    .optional()
    .default("newest")
    .openapi({ description: "Sort order. `rating`: the Bayesian review rank, unreviewed products last." }),
  minRating: minRatingQuerySchema,
  search: z.string().trim().max(100).optional().openapi({ description: "Search within category" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Has discount filter" }),
  inStock: z.enum(["true"]).optional().openapi({ description: "Only products a buyer can buy now (exclude sold out)" }),
  includeSubcategories: includeSubcategoriesSchema,
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
  parentId: z.string().nullable(),
  depth: z.number().int().min(0).max(3),
});

const categoryLinkSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  canonicalPath: z.string().nullable(),
});

const categoryChildSchema = categoryLinkSchema.extend({
  imageUrl: z.string().nullable(),
});

const categoryBreadcrumbItemSchema = categoryLinkSchema.extend({
  depth: z.number().int().min(0).max(3),
});

const storefrontCategoryDetailSchema = storefrontCategorySchema.extend({
  content: z.string().nullable(),
  listingTemplate: z.string().nullable(),
  children: z.array(categoryChildSchema).max(CATEGORY_CHILDREN_LIMIT)
    .openapi({ description: "Published sub-categories, name order (sub-category pills and shelves)." }),
  breadcrumb: z.array(categoryBreadcrumbItemSchema).max(4)
    .openapi({ description: "Published ancestors, root first, ending with this category." }),
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
  secondaryImageUrl: z.string().nullable(),
  cardFacts: optionalProductCardFacts,
  category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).nullable(),
  subcategoryId: z.string().nullable().optional().openapi({
    description: "A listing that includes sub-categories: the listed category's child whose subtree holds the product (null in the category itself).",
  }),
  createdAt: z.string().nullable(),
  rating: cardRatingSchema,
});

const appliedCategoryFiltersSchema = z.object({
  attributes: z.array(appliedFacetFilterSchema),
  sort: listingSortSchema,
  minRating: z.number().int().min(1).max(4).optional(),
  search: z.string().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
  inStock: z.enum(["true"]).optional(),
});

const agentCategoryProductFilterSchema = z.object({
  includeSubcategories: includeSubcategoriesSchema,
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(20).optional().default(20),
  sort: listingSortSchema.optional().default("newest"),
  minRating: minRatingQuerySchema,
  search: z.string().trim().max(100).optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
  inStock: z.enum(["true"]).optional(),
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

const listCategorySummariesRoute = createRoute({
  method: "get",
  path: "/summaries",
  operationId: "storefront.categories.list_summaries",
  tags: ["Categories"],
  summary: "List bounded public category summaries",
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).max(100_000).default(1),
      limit: z.coerce.number().int().min(1).max(50).default(20),
    }),
  },
  responses: {
    200: {
      description: "Bounded public category summaries",
      content: { "application/json": { schema: successEnvelope(z.object({
        categories: z.array(z.object({
          id: z.string().max(180),
          name: z.string().max(100),
          slug: z.string().max(100),
          imageUrl: z.string().max(2048).nullable(),
          descriptionCharacters: z.number().int().min(0),
          contentCharacters: z.number().int().min(0),
        })).max(50),
        pagination: paginationSchema,
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(listCategorySummariesRoute, async (c) => {
  const query = c.req.valid("query");
  return ok(c, await getPublicCategorySummaries(c.get("db"), query));
});

// GET /categories/sitemap — category pages for XML discovery (registered before /{slug})
const categorySitemapRoute = createRoute({
  method: "get",
  path: "/sitemap",
  operationId: "storefront.categories.sitemap",
  tags: ["Categories"],
  summary: "List category pages for the XML sitemap",
  description: "Published categories without noIndex or a sitemap exclusion, filtered before the limit, with each page's last change.",
  responses: {
    200: {
      description: "Category sitemap entries",
      content: { "application/json": { schema: successEnvelope(z.object({
        categories: z.array(z.object({
          slug: z.string(),
          canonicalPath: z.string().nullable(),
          updatedAt: z.string().nullable(),
        })),
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(categorySitemapRoute, async (c) => {
  return ok(c, { categories: await getPublicCategorySitemapEntries(c.get("db")) });
});

// GET /categories/tree — the published tree for automatic menus
const getCategoryTreeRoute = createRoute({
  method: "get",
  path: "/tree",
  operationId: "storefront.categories.tree",
  tags: ["Categories"],
  summary: "Get the published category tree",
  description:
    `Published categories whose every ancestor is published, flat with parentId, top levels first; at most ${CATEGORY_TREE_LINK_LIMIT} nodes, so a node's parent is always included. Deeper levels live on category pages.`,
  responses: {
    200: {
      description: "Category tree",
      content: { "application/json": { schema: successEnvelope(z.object({
        nodes: z.array(categoryChildSchema.extend({
          parentId: z.string().nullable(),
          depth: z.number().int().min(0).max(3),
        })).max(CATEGORY_TREE_LINK_LIMIT),
        truncated: z.boolean(),
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(getCategoryTreeRoute, async (c) => {
  return ok(c, await getPublicCategoryTree(c.get("db")));
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

const getCategoryChildrenRoute = createRoute({
  method: "get",
  path: "/{slug}/children",
  operationId: "storefront.categories.list_children",
  tags: ["Categories"],
  summary: "List a category's published sub-categories",
  request: {
    params: z.object({ slug: publicCategorySlugSchema }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(CATEGORY_CHILDREN_LIMIT).optional().default(CATEGORY_CHILDREN_LIMIT),
    }),
  },
  responses: {
    200: {
      description: "Published sub-categories in name order",
      content: { "application/json": { schema: successEnvelope(z.object({
        children: z.array(categoryChildSchema).max(CATEGORY_CHILDREN_LIMIT),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getCategoryChildrenRoute, async (c) => {
  const { slug } = c.req.valid("param");
  const { limit } = c.req.valid("query");
  const db = c.get("db");
  const [breadcrumb, children] = await Promise.all([
    getPublicCategoryBreadcrumb(db, slug),
    getPublicCategoryChildren(db, slug, { limit }),
  ]);
  if (breadcrumb.length === 0) throw new NotFoundError("Category not found");
  return ok(c, { children });
});

const getCategoryBreadcrumbRoute = createRoute({
  method: "get",
  path: "/{slug}/breadcrumb",
  operationId: "storefront.categories.get_breadcrumb",
  tags: ["Categories"],
  summary: "Get a category's breadcrumb",
  request: { params: z.object({ slug: publicCategorySlugSchema }) },
  responses: {
    200: {
      description: "Published ancestors, root first, ending with the category",
      content: { "application/json": { schema: successEnvelope(z.object({
        breadcrumb: z.array(categoryBreadcrumbItemSchema).min(1).max(4),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getCategoryBreadcrumbRoute, async (c) => {
  const { slug } = c.req.valid("param");
  const breadcrumb = await getPublicCategoryBreadcrumb(c.get("db"), slug);
  if (breadcrumb.length === 0) throw new NotFoundError("Category not found");
  return ok(c, { breadcrumb });
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
        category: storefrontCategoryDetailSchema.omit({ updatedAt: true }),
        products: z.array(storefrontCategoryProductSchema),
        pagination: paginationSchema,
        priceRange: z.object({
          min: z.number().min(0),
          max: z.number().min(0),
        }),
        facets: z.array(productFacetSchema),
        ratingFacet: ratingFacetSchema,
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
    parentId: category.parentId,
    depth: category.depth,
    listingTemplate: category.listingTemplate,
    children: category.children,
    breadcrumb: category.breadcrumb,
    createdAt: category.createdAt,
  };

  const { includeSubcategories, ...filters } = params;
  const result = await getStorefrontCategoryProducts(db, categoryForProducts, {
    ...filters,
    search,
    attributeFilters,
  }, {
    // Only a category with published children has a subtree to list.
    includeDescendants: includeSubcategories === "true" && category.children.length > 0,
  });

  const appliedFilters: z.infer<typeof appliedCategoryFiltersSchema> = {
    attributes: appliedFacetFilters(attributeFilters),
    sort: params.sort,
  };
  if (normalizedSearch) appliedFilters.search = normalizedSearch;
  if (params.minRating !== undefined) appliedFilters.minRating = params.minRating;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;
  if (params.inStock !== undefined) appliedFilters.inStock = params.inStock;

  return ok(c, {
    category: categoryForProducts,
    products: result.products,
    pagination: result.pagination,
    priceRange: result.priceRange,
    facets: result.facets,
    ratingFacet: result.ratingFacet,
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
        ratingFacet: ratingFacetSchema,
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
  const { includeSubcategories, ...filters } = params;
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
  }, {
    ...filters,
    search: normalizePublicListingSearchParam(params.search),
    attributeFilters,
  }, {
    includeDescendants: includeSubcategories === "true",
  });
  const appliedFilters: z.infer<typeof appliedCategoryFiltersSchema> = {
    attributes: appliedFacetFilters(attributeFilters),
    sort: params.sort,
  };
  const normalizedSearch = normalizePublicFtsSearchQuery(params.search);
  if (normalizedSearch) appliedFilters.search = normalizedSearch;
  if (params.minRating !== undefined) appliedFilters.minRating = params.minRating;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;
  if (params.inStock !== undefined) appliedFilters.inStock = params.inStock;
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
