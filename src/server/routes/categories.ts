import { Hono } from "hono";
import { z } from "zod";
import { db } from "@/db";
import {
  categories,
  products,
  productImages,
  productAttributes,
  productAttributeValues,
} from "@/db/schema";
import { eq, isNull, sql, and, desc, like, inArray, or } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for category routes
const app = new Hono();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 0,
    keyPrefix: "api:categories:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

// Schema for category product filtering
const categoryProductFilterSchema = z.object({
  page: z.coerce.number().optional().default(1),
  limit: z.coerce.number().optional().default(20),
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
    .default("newest"),
  search: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
});

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// Get all categories (public)
app.get("/", async (c) => {
  try {
    const categoriesList = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        imageUrl: categories.imageUrl,
        createdAt: categories.createdAt,
        metaTitle: categories.metaTitle,
        metaDescription: categories.metaDescription,
      })
      .from(categories)
      .where(isNull(categories.deletedAt))
      .orderBy(categories.name)
      .all();

    // Format dates
    const formattedCategories = categoriesList.map((category) => ({
      ...category,
      createdAt:
        unixToDate(category.createdAt as unknown as number)?.toISOString() ||
        null,
    }));

    return c.json({ categories: formattedCategories });
  } catch (error) {
    console.error("Error fetching categories:", error);
    return c.json({ error: "Failed to fetch categories" }, 500);
  }
});

// Get category by slug (public)
app.get("/:slug", async (c) => {
  try {
    const slug = c.req.param("slug");

    const category = await db
      .select({
        id: categories.id,
        name: categories.name,
        slug: categories.slug,
        description: categories.description,
        imageUrl: categories.imageUrl,
        metaTitle: categories.metaTitle,
        metaDescription: categories.metaDescription,
        createdAt: sql<number>`CAST(${categories.createdAt} AS INTEGER)`,
      })
      .from(categories)
      .where(and(eq(categories.slug, slug), isNull(categories.deletedAt)))
      .get();

    if (!category) {
      return c.json({ error: "Category not found" }, 404);
    }

    // Format the response
    return c.json({
      category: {
        ...category,
        createdAt: unixToDate(category.createdAt)?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error fetching category:", error);
    return c.json({ error: "Failed to fetch category" }, 500);
  }
});

// Get products in a category with filtering support (public)
app.get("/:slug/products", async (c) => {
  try {
    const slug = c.req.param("slug");
    const params = categoryProductFilterSchema.parse(c.req.query());
    const {
      page,
      limit,
      sort,
      search,
      minPrice,
      maxPrice,
      freeDelivery,
      hasDiscount,
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
        metaDescription: categories.metaDescription,
      })
      .from(categories)
      .where(and(eq(categories.slug, slug), isNull(categories.deletedAt)))
      .get();

    if (!category) {
      return c.json({ error: "Category not found" }, 404);
    }

    // Dynamic attribute filtering
    const queryParams = c.req.query();
    const allAttributes = await db
      .select({ slug: productAttributes.slug })
      .from(productAttributes);
    const validAttributeSlugs = new Set(allAttributes.map((a) => a.slug));
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
      conditions.push(like(products.name, `%${search}%`));
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
      // Sort by discounted price (calculated price after discount)
      orderBy = sql`CASE 
        WHEN ${products.discountPercentage} > 0 
        THEN ROUND(${products.price} * (1 - ${products.discountPercentage} / 100))
        ELSE ${products.price}
      END`;
    } else if (sort === "price-desc") {
      // Sort by discounted price (calculated price after discount) descending
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
      // Default to newest
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
        updatedAt: products.updatedAt,
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
    const productIds = productsList.map((p) => p.id);

    // Only fetch images if we have products
    let imageMap = new Map();
    if (productIds.length > 0) {
      const images = await db
        .select({
          productId: productImages.productId,
          url: productImages.url,
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
      imageMap = new Map(images.map((img) => [img.productId, img.url]));
    }

    // Combine products with their images and add category info
    const productsWithImages = productsList.map((product) => ({
      ...product,
      imageUrl: imageMap.get(product.id) || null,
      discountedPrice: product.discountPercentage
        ? Math.round(product.price * (1 - product.discountPercentage / 100))
        : product.price,
      createdAt:
        unixToDate(product.createdAt as unknown as number)?.toISOString() ||
        null,
      updatedAt:
        unixToDate(product.updatedAt as unknown as number)?.toISOString() ||
        null,
      category: {
        id: category.id,
        name: category.name,
        slug: category.slug,
        description: category.description,
        imageUrl: category.imageUrl,
        metaTitle: category.metaTitle,
        metaDescription: category.metaDescription,
      },
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

    return c.json({
      category,
      products: productsWithImages,
      pagination: {
        page,
        limit,
        total: totalCount?.count || 0,
        totalPages: Math.ceil((totalCount?.count || 0) / limit),
      },
      appliedFilters: {
        attributes: attributeFilters,
        search,
        minPrice,
        maxPrice,
        freeDelivery,
        hasDiscount,
        sort,
      },
    });
  } catch (error) {
    console.error("Error fetching category products:", error);
    return c.json({ error: "Failed to fetch category products" }, 500);
  }
});

// Export the category routes
export { app as categoryRoutes };
