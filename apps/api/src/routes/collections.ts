import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { collections } from "@scalius/database/schema";
import { eq, isNull, and } from "drizzle-orm";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, errorResponses, paginationSchema } from "../schemas/responses";
import { ok } from "../utils/api-response";
import { getPublicCollectionCatalog, getPublicCollectionSitemapEntries } from "@scalius/core/modules/collections";
import { deps } from "@scalius/core/cache-deps";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/catalog";
import { productFacetSchema } from "../schemas/catalog-facets";
import { publicCollectionConfig } from "@scalius/core/modules/collections/browser";
import { toIsoTimestamp } from "../utils/timestamps";
import {
  normalizePublicListingSearchParam,
  readRepeatedPublicQueryValues,
} from "../utils/public-search-query";

// Create an OpenAPIHono app for collection routes
const app = new OpenAPIHono<{ Bindings: Env }>();

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
  presentation: z.enum(["grid", "carousel"]),
  config: z.object({
    maxProducts: z.number().int().min(1).max(24),
    title: z.string(),
    subtitle: z.string(),
  }),
  sortOrder: z.number(),
  isActive: z.boolean(),
  canonicalPath: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

// No updatedAt or version: internal row facts, never shown to buyers.
const storefrontCollectionDetailSchema = storefrontCollectionSchema.omit({ updatedAt: true }).extend({
  /** The listing template id from the theme; null renders the theme's default collection listing. */
  listingTemplate: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
});

const collectionProductSchema = z.object({
  id: z.string(),
  name: z.string(),
  price: z.number(),
  slug: z.string(),
  discountType: z.string().nullable(),
  discountPercentage: z.number().nullable(),
  discountAmount: z.number().nullable(),
  imageUrl: z.string().nullable(),
  imageMediaId: z.string().nullable(),
  imageAlt: z.string().nullable(),
  secondaryImageUrl: z.string().nullable(),
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
  availableForSale: z.boolean(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  hasVariants: z.boolean(),
});


const collectionCatalogQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  sort: z.enum([
    "newest",
    "price-asc",
    "price-desc",
    "name-asc",
    "name-desc",
    "discount",
  ]).optional(),
  search: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
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

// GET /collections — list all active collections
const listCollectionsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.collections.list",
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
  // Every active collection row.
  deps.anyCollection();
  const activeCollections = await db
    .select({
      id: collections.id,
      name: collections.name,
      presentation: collections.presentation,
      config: collections.config,
      sortOrder: collections.sortOrder,
      isActive: collections.isActive,
      canonicalPath: collections.canonicalPath,
      noIndex: collections.noIndex,
      excludeFromSitemap: collections.excludeFromSitemap,
      createdAt: collections.createdAt,
      updatedAt: collections.updatedAt
    })
    .from(collections)
    .where(and(eq(collections.isActive, true), isNull(collections.deletedAt)))
    .orderBy(collections.sortOrder);

  const formattedCollections = activeCollections.map((collection) => ({
    ...collection,
    config: publicCollectionConfig(collection.config),
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
// GET /collections/sitemap — collection pages for XML discovery (registered before /{id})
const collectionSitemapRoute = createRoute({
  method: "get",
  path: "/sitemap",
  operationId: "storefront.collections.sitemap",
  tags: ["Collections"],
  summary: "List collection pages for the XML sitemap",
  description: "Active collections without noIndex or a sitemap exclusion, filtered before the limit, with each page's last change.",
  responses: {
    200: {
      description: "Collection sitemap entries",
      content: { "application/json": { schema: successEnvelope(z.object({
        collections: z.array(z.object({
          id: z.string(),
          canonicalPath: z.string().nullable(),
          updatedAt: z.string().nullable(),
        })),
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(collectionSitemapRoute, async (c) => {
  return ok(c, { collections: await getPublicCollectionSitemapEntries(c.get("db")) });
});

const getCollectionByIdRoute = createRoute({
  method: "get",
  path: "/{id}",
  operationId: "storefront.collections.get",
  tags: ["Collections"],
  summary: "Get collection by ID with resolved products",
  request: {
    params: z.object({
      id: z.string(),
    }),
    query: collectionCatalogQuerySchema,
  },
  responses: {
    200: {
      description: "Collection details with resolved products",
      content: { "application/json": { schema: successEnvelope(z.object({
        collection: storefrontCollectionDetailSchema,
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
        products: z.array(collectionProductSchema),
        featuredProduct: collectionProductSchema.optional(),
        pagination: paginationSchema,
        priceRange: z.object({ min: z.number().min(0), max: z.number().min(0) }),
        facets: z.array(productFacetSchema),
      })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  }
});

app.openapi(getCollectionByIdRoute, async (c) => {
  const db = c.get("db");
  const { id } = c.req.valid("param");
  const params = c.req.valid("query");
  const attributeFilters = await resolvePublicAttributeFilters(
    db,
    readRepeatedPublicQueryValues(c.req.url),
    Object.keys(params),
  );
  const result = await getPublicCollectionCatalog(db, id, {
    ...params,
    search: normalizePublicListingSearchParam(params.search),
    attributeFilters,
  });

  if (!result) {
    throw new NotFoundError("Collection not found");
  }

  const { collection, categories, products, featuredProduct, pagination, priceRange, facets } = result;
  const { version: _version, updatedAt: _updatedAt, deletedAt: _deletedAt, ...publicCollection } = collection;

  return ok(c, {
    collection: {
      ...publicCollection,
      config: publicCollectionConfig(collection.config),
      createdAt: formatTimestamp(
        collection.createdAt,
        collection.id,
        "createdAt",
      ),
    },
    categories,
    products,
    ...(featuredProduct && { featuredProduct }),
    pagination,
    priceRange,
    facets,
  });
});

// Export the collection routes
export { app as collectionRoutes };
