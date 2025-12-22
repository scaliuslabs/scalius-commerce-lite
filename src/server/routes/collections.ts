import { Hono } from "hono";
import { collections, products, categories } from "@/db/schema";
import { eq, isNull, and, inArray, desc, sql } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";

// Create a Hono app for collection routes
const app = new Hono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: 3600,
    keyPrefix: "api:collections:",
    varyByQuery: true,
    methods: ["GET"],
  }),
);

// Helper function to convert Unix timestamp to Date
const unixToDate = (timestamp: number | null): Date | null => {
  if (!timestamp) return null;
  return new Date(timestamp * 1000);
};

// Helper to safely format timestamp
const formatTimestamp = (
  timestamp: unknown,
  collectionId: string,
  fieldName: string,
): string | null => {
  try {
    const date = unixToDate(timestamp as number);
    if (date instanceof Date && !isNaN(date.getTime())) {
      return date.toISOString();
    }
  } catch {
    console.warn(
      `Invalid ${fieldName} timestamp for collection ${collectionId}`,
    );
  }
  return null;
};

// Get all active collections (public)
app.get("/", async (c) => {
  try {
    const db = c.get("db");
    const activeCollections = await db
      .select({
        id: collections.id,
        name: collections.name,
        type: collections.type,
        config: collections.config,
        sortOrder: collections.sortOrder,
        isActive: collections.isActive,
        createdAt: collections.createdAt,
        updatedAt: collections.updatedAt,
      })
      .from(collections)
      .where(and(eq(collections.isActive, true), isNull(collections.deletedAt)))
      .orderBy(collections.sortOrder);

    const formattedCollections = activeCollections.map((collection) => ({
      ...collection,
      config: JSON.parse(collection.config),
      createdAt: formatTimestamp(
        collection.createdAt,
        collection.id,
        "createdAt",
      ),
      updatedAt: formatTimestamp(
        collection.updatedAt,
        collection.id,
        "updatedAt",
      ),
    }));

    return c.json({ collections: formattedCollections });
  } catch (error) {
    console.error("Error fetching collections:", error);
    return c.json({ error: "Failed to fetch collections" }, 500);
  }
});


// Get collection by ID (public)
// Implements the product selection logic:
// 1. If productIds is NOT EMPTY → return ONLY these specific products (ignore categoryIds)
// 2. If productIds is EMPTY and categoryIds is NOT EMPTY → return products from categories
// 3. If both are empty → return empty products array
// 4. Apply maxProducts limit (default: 8, max: 24)
app.get("/:id", async (c) => {
  try {
    const db = c.get("db");
    const id = c.req.param("id");

    // First, fetch the collection (sequential - needed to parse config)
    const collection = await db
      .select()
      .from(collections)
      .where(
        and(
          eq(collections.id, id),
          eq(collections.isActive, true),
          isNull(collections.deletedAt),
        ),
      )
      .get();

    if (!collection) {
      return c.json({ error: "Collection not found" }, 404);
    }

    // Parse the config
    const config = JSON.parse(collection.config);

    // Normalize config values
    const productIds: string[] = Array.isArray(config.productIds)
      ? config.productIds
      : [];
    const categoryIds: string[] = Array.isArray(config.categoryIds)
      ? config.categoryIds
      : [];

    // Apply maxProducts limit (default: 8, max: 24)
    const maxProducts = Math.min(Math.max(config.maxProducts || 8, 1), 24);

    // Initialize response data
    let resolvedProducts: any[] = [];
    let resolvedCategories: any[] = [];
    let featuredProduct: any = null;

    // PRODUCT SELECTION LOGIC
    // Priority: productIds > categoryIds
    const hasSpecificProducts = productIds.length > 0;
    const hasCategories = categoryIds.length > 0;
    const hasFeaturedProduct = !!config.featuredProductId;

    // --- BATCH QUERY EXECUTION ---
    // Use db.batch() to send all queries in a single HTTP request to Turso
    // This eliminates per-query TLS handshake overhead on cold starts

    if (hasSpecificProducts) {
      // CASE 1: Specific products selected - IGNORE categoryIds completely
      // Batch: products query + optional featured product query
      const batchQueries: Parameters<typeof db.batch>[0] = [
        // 0. Fetch specific products with inline primary image
        db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            discountPercentage: products.discountPercentage,
            slug: products.slug,
            imageUrl: sql<string | null>`(
              SELECT "product_images"."url"
              FROM "product_images"
              WHERE "product_images"."product_id" = "products"."id"
                AND "product_images"."is_primary" = 1
              ORDER BY "product_images"."sort_order" ASC
              LIMIT 1
            )`.as("imageUrl"),
          })
          .from(products)
          .where(
            and(
              inArray(products.id, productIds),
              isNull(products.deletedAt),
              eq(products.isActive, true),
            ),
          )
          .limit(maxProducts),

        // 1. Fetch featured product (will return empty if no featuredProductId)
        db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            discountPercentage: products.discountPercentage,
            slug: products.slug,
            imageUrl: sql<string | null>`(
              SELECT "product_images"."url"
              FROM "product_images"
              WHERE "product_images"."product_id" = "products"."id"
                AND "product_images"."is_primary" = 1
              ORDER BY "product_images"."sort_order" ASC
              LIMIT 1
            )`.as("imageUrl"),
          })
          .from(products)
          .where(
            hasFeaturedProduct
              ? and(
                  eq(products.id, config.featuredProductId),
                  isNull(products.deletedAt),
                  eq(products.isActive, true),
                )
              : sql`1 = 0`,
          ),
      ];

      const batchResults = await db.batch(batchQueries);

      // Extract results
      const productsData = batchResults[0] as {
        id: string;
        name: string;
        price: number;
        discountPercentage: number | null;
        slug: string;
        imageUrl: string | null;
      }[];

      const featuredData = (batchResults[1] as typeof productsData)[0];

      resolvedProducts = productsData.map((product) => ({
        ...product,
        imageUrl: product.imageUrl ?? null,
        discountedPrice: product.discountPercentage
          ? Math.round(product.price * (1 - product.discountPercentage / 100))
          : product.price,
      }));

      // Categories array is EMPTY when using specific products
      resolvedCategories = [];

      if (featuredData) {
        featuredProduct = {
          ...featuredData,
          imageUrl: featuredData.imageUrl ?? null,
          discountedPrice: featuredData.discountPercentage
            ? Math.round(
                featuredData.price *
                  (1 - featuredData.discountPercentage / 100),
              )
            : featuredData.price,
        };
      }
    } else if (hasCategories) {
      // CASE 2: Category-based collection
      // Batch: categories query + products query + optional featured product query
      const batchQueries: Parameters<typeof db.batch>[0] = [
        // 0. Fetch category details for "View All" links
        db
          .select({
            id: categories.id,
            name: categories.name,
            slug: categories.slug,
          })
          .from(categories)
          .where(
            and(
              inArray(categories.id, categoryIds),
              isNull(categories.deletedAt),
            ),
          ),

        // 1. Fetch products from categories with inline primary image
        db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            discountPercentage: products.discountPercentage,
            slug: products.slug,
            imageUrl: sql<string | null>`(
              SELECT "product_images"."url"
              FROM "product_images"
              WHERE "product_images"."product_id" = "products"."id"
                AND "product_images"."is_primary" = 1
              ORDER BY "product_images"."sort_order" ASC
              LIMIT 1
            )`.as("imageUrl"),
          })
          .from(products)
          .where(
            and(
              inArray(products.categoryId, categoryIds),
              isNull(products.deletedAt),
              eq(products.isActive, true),
            ),
          )
          .orderBy(desc(products.createdAt))
          .limit(maxProducts),

        // 2. Fetch featured product (will return empty if no featuredProductId)
        db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            discountPercentage: products.discountPercentage,
            slug: products.slug,
            imageUrl: sql<string | null>`(
              SELECT "product_images"."url"
              FROM "product_images"
              WHERE "product_images"."product_id" = "products"."id"
                AND "product_images"."is_primary" = 1
              ORDER BY "product_images"."sort_order" ASC
              LIMIT 1
            )`.as("imageUrl"),
          })
          .from(products)
          .where(
            hasFeaturedProduct
              ? and(
                  eq(products.id, config.featuredProductId),
                  isNull(products.deletedAt),
                  eq(products.isActive, true),
                )
              : sql`1 = 0`,
          ),
      ];

      const batchResults = await db.batch(batchQueries);

      // Extract results with proper typing
      const categoriesData = batchResults[0] as {
        id: string;
        name: string;
        slug: string;
      }[];

      const productsData = batchResults[1] as {
        id: string;
        name: string;
        price: number;
        discountPercentage: number | null;
        slug: string;
        imageUrl: string | null;
      }[];

      const featuredData = (batchResults[2] as typeof productsData)[0];

      resolvedCategories = categoriesData;
      resolvedProducts = productsData.map((product) => ({
        ...product,
        imageUrl: product.imageUrl ?? null,
        discountedPrice: product.discountPercentage
          ? Math.round(product.price * (1 - product.discountPercentage / 100))
          : product.price,
      }));

      if (featuredData) {
        featuredProduct = {
          ...featuredData,
          imageUrl: featuredData.imageUrl ?? null,
          discountedPrice: featuredData.discountPercentage
            ? Math.round(
                featuredData.price *
                  (1 - featuredData.discountPercentage / 100),
              )
            : featuredData.price,
        };
      }
    } else if (hasFeaturedProduct) {
      // CASE 3: Only featured product (no productIds or categoryIds)
      const featuredData = await db
        .select({
          id: products.id,
          name: products.name,
          price: products.price,
          discountPercentage: products.discountPercentage,
          slug: products.slug,
          imageUrl: sql<string | null>`(
            SELECT "product_images"."url"
            FROM "product_images"
            WHERE "product_images"."product_id" = "products"."id"
              AND "product_images"."is_primary" = 1
            ORDER BY "product_images"."sort_order" ASC
            LIMIT 1
          )`.as("imageUrl"),
        })
        .from(products)
        .where(
          and(
            eq(products.id, config.featuredProductId),
            isNull(products.deletedAt),
            eq(products.isActive, true),
          ),
        )
        .get();

      if (featuredData) {
        featuredProduct = {
          ...featuredData,
          imageUrl: featuredData.imageUrl ?? null,
          discountedPrice: featuredData.discountPercentage
            ? Math.round(
                featuredData.price *
                  (1 - featuredData.discountPercentage / 100),
              )
            : featuredData.price,
        };
      }
    }
    // CASE 4: Both empty - resolvedProducts and resolvedCategories stay empty

    // Format the response
    return c.json({
      collection: {
        ...collection,
        config,
        createdAt: formatTimestamp(
          collection.createdAt,
          collection.id,
          "createdAt",
        ),
        updatedAt: formatTimestamp(
          collection.updatedAt,
          collection.id,
          "updatedAt",
        ),
      },
      // Categories only populated if productIds is empty
      categories: resolvedCategories,
      // Products already filtered and limited by backend
      products: resolvedProducts,
      // Featured product (only for collection1 style)
      ...(featuredProduct && { featuredProduct }),
    });
  } catch (error) {
    console.error("Error fetching collection:", error);
    return c.json({ error: "Failed to fetch collection" }, 500);
  }
});

// Export the collection routes
export { app as collectionRoutes };
