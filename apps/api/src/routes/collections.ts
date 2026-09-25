import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { collections } from "@scalius/database/schema";
import { eq, isNull, and } from "drizzle-orm";
import { NotFoundError } from "../utils/api-error";
import { successEnvelope, errorResponses, paginationSchema } from "../schemas/responses";
import { ok } from "../utils/api-response";
import { getPublicCollectionCatalog } from "@scalius/core/modules/collections";
import { resolvePublicAttributeFilters } from "@scalius/core/modules/catalog";
import { productFacetSchema } from "../schemas/catalog-facets";
import { publicCollectionConfig } from "@scalius/core/modules/collections/browser";
import { toIsoTimestamp } from "../utils/timestamps";
import {
  normalizePublicListingSearchParam,
  readRepeatedPublicQueryValues,
} from "../utils/public-search-query";
import { optionalProductCardFacts } from "../schemas/product-card-facts";

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

const storefrontCollectionDetailSchema = storefrontCollectionSchema.extend({
  /** The listing template id from the theme; null renders the theme's default collection listing. */
  listingTemplate: z.string().nullable(),
  description: z.string().nullable(),
  content: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
});

// Review ratings on listing cards and the "N★ & up" facet (Wave B §2.4).
const cardRatingSchema = z.object({
  average: z.number().min(1).max(5).openapi({ description: "Average of the published reviews, two decimals truncated (4.66)." }),
  count: z.number().int().min(1).openapi({ description: "Published reviews." }),
}).nullable().openapi({ description: "Published-review rating; null when the product has no published review." });

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
  cardFacts: optionalProductCardFacts,
  discountedPrice: z.number(),
  priceVaries: z.boolean(),
  availableForSale: z.boolean(),
  freeDelivery: z.boolean(),
  categoryId: z.string().nullable(),
  hasVariants: z.boolean(),
  rating: cardRatingSchema,
});

const ratingFacetSchema = z.array(z.object({
  min: z.number().int().min(1).max(4).openapi({ description: "Whole stars: products averaging at least this (`minRating`)." }),
  count: z.number().int().min(0).openapi({ description: "Products matching the other selections and this threshold." }),
})).max(4).openapi({
  description: "\"N★ & up\" rating facet, highest first: empty when no product in scope has a published review, otherwise 4, 3, 2 (plus a selected `minRating`), counts may be 0.",
});
const minRatingQuerySchema = z.coerce.number().int().min(1).max(4).optional().openapi({
  description: "Only products whose published-review average is at least this many whole stars (1-4).",
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
    "rating",
  ]).optional(),
  minRating: minRatingQuerySchema,
  search: z.string().optional(),
  minPrice: z.coerce.number().min(0).optional(),
  maxPrice: z.coerce.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
  inStock: z.enum(["true"]).optional(),
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
        ratingFacet: ratingFacetSchema,
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

  const { collection, categories, products, featuredProduct, pagination, priceRange, facets, ratingFacet } = result;

  return ok(c, {
    collection: {
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
    },
    categories,
    products,
    ...(featuredProduct && { featuredProduct }),
    pagination,
    priceRange,
    facets,
    ratingFacet,
  });
});

// Export the collection routes
export { app as collectionRoutes };
