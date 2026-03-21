import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  categories,
  products,
  productImages,
  productAttributes,
  productAttributeValues
} from "@scalius/database/schema";
import { eq, isNull, sql, and, desc, inArray, or } from "drizzle-orm";
import { ftsMatch } from "@scalius/core/search";
import { getPublicCategories, getPublicCategoryBySlug } from "@scalius/core/modules/categories/categories.storefront";
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

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

const storefrontCategorySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
}).passthrough();

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
        category: z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough(),
        products: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), price: z.number() }).passthrough()),
        pagination: paginationSchema,
        appliedFilters: z.record(z.string(), z.unknown()),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCategoryProductsRoute, (async (c: any) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const params = c.req.valid("query");
  const {
    page,
    limit,
    sort,
    search,
    minPrice,
    maxPrice,
    freeDelivery,
    hasDiscount
  } = params;

  // Get category ID from slug (excluding soft-deleted categories)
  const category = await db
    .select({
      id: categories.id,
      name: categories.name,
      slug: categories.slug,
      description: categories.description,
      imageUrl: categories.imageUrl,
      metaTitle: categories.metaTitle,
      metaDescription: categories.metaDescription
    })
    .from(categories)
    .where(and(eq(categories.slug, slug), isNull(categories.deletedAt)))
    .get();

  if (!category) {
    throw new NotFoundError("Category not found");
  }

  // Dynamic attribute filtering
  const queryParams = c.req.query();
  const allAttributes = await db
    .select({ slug: productAttributes.slug })
    .from(productAttributes);
  const validAttributeSlugs = new Set(allAttributes.map((a: any) => a.slug));
  const attributeFilters: { slug: string; value: string }[] = [];

  for (const key in queryParams) {
    if (validAttributeSlugs.has(key)) {
      const value = queryParams[key];
      if (value) {
        attributeFilters.push({ slug: key, value });
      }
    }
  }

  // Build query conditions
  const conditions = [
    eq(products.isActive, true),
    isNull(products.deletedAt),
    eq(products.categoryId, category.id),
  ];

  // Apply search filter
  if (search) {
    const cond = ftsMatch("products_fts", "products", search);
    if (cond) conditions.push(cond);
  }

  // Apply price range filters
  if (minPrice !== undefined) {
    conditions.push(sql`${products.price} >= ${minPrice}`);
  }

  if (maxPrice !== undefined) {
    conditions.push(sql`${products.price} <= ${maxPrice}`);
  }

  // Apply free delivery filter
  if (freeDelivery === "true") {
    conditions.push(eq(products.freeDelivery, true));
  } else if (freeDelivery === "false") {
    conditions.push(eq(products.freeDelivery, false));
  }

  // Apply discount filter
  if (hasDiscount === "true") {
    conditions.push(sql`${products.discountPercentage} > 0`);
  } else if (hasDiscount === "false") {
    conditions.push(
      sql`${products.discountPercentage} = 0 OR ${products.discountPercentage} IS NULL`,
    );
  }

  // Determine sort order
  let orderBy;
  if (sort === "price-asc") {
    orderBy = sql`CASE
      WHEN ${products.discountPercentage} > 0
      THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100))
      ELSE ${products.price}
    END`;
  } else if (sort === "price-desc") {
    orderBy = desc(sql`CASE
      WHEN ${products.discountPercentage} > 0
      THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100))
      ELSE ${products.price}
    END`);
  } else if (sort === "name-asc") {
    orderBy = products.name;
  } else if (sort === "name-desc") {
    orderBy = desc(products.name);
  } else if (sort === "discount") {
    orderBy = desc(products.discountPercentage);
  } else {
    orderBy = desc(products.createdAt);
  }

  // Apply pagination
  const offset = (page - 1) * limit;

  // Build base query
  let query = db
    .select({
      id: products.id,
      name: products.name,
      price: products.price,
      slug: products.slug,
      discountPercentage: products.discountPercentage,
      freeDelivery: products.freeDelivery,
      categoryId: products.categoryId,
      createdAt: products.createdAt,
      updatedAt: products.updatedAt
    })
    .from(products)
    .where(and(...conditions));

  // Apply attribute filtering if needed
  if (attributeFilters.length > 0) {
    const subquery = db
      .select({ productId: productAttributeValues.productId })
      .from(productAttributeValues)
      .leftJoin(
        productAttributes,
        eq(productAttributeValues.attributeId, productAttributes.id),
      )
      .where(
        or(
          ...attributeFilters.map((filter) =>
            and(
              eq(productAttributes.slug, filter.slug),
              eq(productAttributeValues.value, filter.value),
            ),
          ),
        ),
      )
      .groupBy(productAttributeValues.productId)
      .having(sql`count(*) = ${attributeFilters.length}`)
      .as("filtered_products");

    query = query.innerJoin(subquery, eq(products.id, subquery.productId));
  }

  // Execute query
  const productsList = await query
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset)
    .all();

  // Get primary images for products
  const productIds = productsList.map((p: any) => p.id);

  // Only fetch images if we have products
  let imageMap = new Map();
  if (productIds.length > 0) {
    const images = await db
      .select({
        productId: productImages.productId,
        url: productImages.url
      })
      .from(productImages)
      .where(
        and(
          eq(productImages.isPrimary, true),
          inArray(productImages.productId, productIds),
        ),
      )
      .all();

    // Create a map of product ID to image URL
    imageMap = new Map(images.map((img: any) => [img.productId, img.url]));
  }

  // Combine products with their images and add category info
  const productsWithImages = productsList.map((product: any) => ({
    ...product,
    imageUrl: imageMap.get(product.id) || null,
    discountedPrice: product.discountPercentage
      ? Math.round(product.price * (1 - product.discountPercentage / 100))
      : product.price,
    createdAt:
      product.createdAt instanceof Date ? product.createdAt.toISOString() : null,
    updatedAt:
      product.updatedAt instanceof Date ? product.updatedAt.toISOString() : null,
    category: {
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageUrl: category.imageUrl,
      metaTitle: category.metaTitle,
      metaDescription: category.metaDescription
    }
  }));

  // Get total count for pagination - need to apply same filters
  let countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(products)
    .where(and(...conditions));

  if (attributeFilters.length > 0) {
    const countSubquery = db
      .select({ productId: productAttributeValues.productId })
      .from(productAttributeValues)
      .leftJoin(
        productAttributes,
        eq(productAttributeValues.attributeId, productAttributes.id),
      )
      .where(
        or(
          ...attributeFilters.map((filter) =>
            and(
              eq(productAttributes.slug, filter.slug),
              eq(productAttributeValues.value, filter.value),
            ),
          ),
        ),
      )
      .groupBy(productAttributeValues.productId)
      .having(sql`count(*) = ${attributeFilters.length}`)
      .as("count_filtered_products");

    countQuery = countQuery.innerJoin(
      countSubquery,
      eq(products.id, countSubquery.productId),
    );
  }

  const totalCount = await countQuery.get();

  return ok(c, {
    category,
    products: productsWithImages,
    pagination: {
      page,
      limit,
      total: totalCount?.count || 0,
      totalPages: Math.ceil((totalCount?.count || 0) / limit)
    },
    appliedFilters: {
      attributes: attributeFilters,
      search,
      minPrice,
      maxPrice,
      freeDelivery,
      hasDiscount,
      sort
    }
  });
}) as any);

// Export the category routes
export { app as categoryRoutes };
