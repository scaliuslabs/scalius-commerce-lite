import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { collections } from "@scalius/database/schema";
import { eq, isNull, and } from "drizzle-orm";
import { cacheMiddleware } from "../middleware/cache";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, errorResponses } from "../schemas/responses";
import { ok } from "../utils/api-response";
import { CACHE_TTLS } from "../utils/cache-ttls";
import { resolveCollectionProducts } from "@scalius/core/modules/collections/collections.service";
import { toIsoTimestamp } from "../utils/timestamps";

// Create an OpenAPIHono app for collection routes
const app = new OpenAPIHono<{ Bindings: Env }>();

// Apply cache middleware to all routes
app.use(
  "*",
  cacheMiddleware({
    ttl: CACHE_TTLS.STANDARD,
    keyPrefix: "api:collections:",
    varyByQuery: true,
    methods: ["GET"]
  }),
);

// Helper to safely format timestamp
const formatTimestamp = (
  timestamp: unknown,
  collectionId: string,
  fieldName: string,
): string | null => {
  const formatted = toIsoTimestamp(timestamp);
  if (timestamp !== null && timestamp !== undefined && formatted === null) {
    console.warn(
      `Invalid ${fieldName} timestamp for collection ${collectionId}`,
    );
  }
  return formatted;
};

const storefrontCollectionSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()),
  sortOrder: z.number(),
  isActive: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
}).passthrough();

const collectionProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  slug: z.string(),
  discountPercentage: z.number().nullable(),
  imageUrl: z.string().nullable(),
  discountedPrice: z.number(),
}).passthrough();

// GET /collections — list all active collections
const listCollectionsRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["Collections"],
  summary: "List all active collections",
  responses: {
    200: {
      description: "Collection list",
      content: { "application/json": { schema: successEnvelope(z.object({
        collections: z.array(storefrontCollectionSchema),
      })) } },
    },
    500: errorResponses[500],
  }
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
      updatedAt: collections.updatedAt
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
    )
  }));

  return ok(c, { collections: formattedCollections });
});

// GET /collections/:id — get collection by ID
const getCollectionByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  tags: ["Collections"],
  summary: "Get collection by ID with resolved products",
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: "Collection details with resolved products",
      content: { "application/json": { schema: successEnvelope(z.object({
        collection: storefrontCollectionSchema,
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() }).passthrough()),
        products: z.array(collectionProductSchema),
        featuredProduct: collectionProductSchema.optional(),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCollectionByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");

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

  const config = JSON.parse(collection.config);
  const resolved = await resolveCollectionProducts(db, config);

  return ok(c, {
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
      )
    },
    categories: resolved.categories,
    products: resolved.products,
    ...(resolved.featuredProduct && { featuredProduct: resolved.featuredProduct })
  });
});

// Export the collection routes
export { app as collectionRoutes };
