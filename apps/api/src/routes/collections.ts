import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { collections, products, categories } from "@scalius/database/schema";
import { eq, isNull, and, inArray, desc, sql } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";

// Create an OpenAPIHono app for collection routes
const app = new OpenAPIHono<{ Bindings: Env }>();

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

// GET /collections — list all active collections
const listCollectionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Collections"],
  summary: "List all active collections",
  responses: {
    200: {
      description: "Collection list",
      content: { "application/json": { schema: z.object({ collections: z.array(z.any()) }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

app.openapi(listCollectionsRoute, async (c) => {
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

  return c.json({ collections: formattedCollections }, 200);
});

// GET /collections/:id — get collection by ID
const getCollectionByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Collections"],
  summary: "Get collection by ID with resolved products",
  request: {
    params: z.object({
      id: z.string().openapi({ description: "Collection ID" }),
    }),
  },
  responses: {
    200: {
      description: "Collection details with resolved products",
      content: { "application/json": { schema: z.object({ collection: z.any(), categories: z.array(z.any()), products: z.array(z.any()) }).passthrough() } },
    },
    404: {
      description: "Collection not found",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
    500: {
      description: "Server error",
      content: { "application/json": { schema: z.object({ error: z.string() }) } },
    },
  },
});

app.openapi(getCollectionByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

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
    throw new NotFoundError("Collection not found");
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
  if (hasSpecificProducts) {
    // CASE 1: Specific products selected - IGNORE categoryIds completely
    const batchQueries: Parameters<typeof db.batch>[0] = [
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
    const batchQueries: Parameters<typeof db.batch>[0] = [
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
    categories: resolvedCategories,
    products: resolvedProducts,
    ...(featuredProduct && { featuredProduct }),
  }, 200);
});

// Export the collection routes
export { app as collectionRoutes };
