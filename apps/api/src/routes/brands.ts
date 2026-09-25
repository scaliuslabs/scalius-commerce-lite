// Public brand routes: the brand list (brand wall, agents), the brand page,
// its product listing and the brand sitemap entries. Only published, live
// brands exist here; every response is cached under the store's cache
// generation (`/api/v1/brands` is a public cache route).
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import {
  BRAND_SITEMAP_LIMIT,
  PUBLIC_BRAND_PAGE_LIMIT,
  getPublicBrandBySlug,
  getPublicBrandSitemapEntries,
  listPublicBrands,
} from "@scalius/core/modules/brands";
import { brandSlugSchema } from "@scalius/shared/catalog-brand";
import { getStorefrontBrandProducts, resolvePublicAttributeFilters } from "@scalius/core/modules/catalog";
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

const app = new OpenAPIHono<{ Bindings: Env }>();

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

const sortSchema = z.enum(["newest", "price-asc", "price-desc", "name-asc", "name-desc", "discount", "rating"]);

const brandProductFilterSchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).optional().default(1).openapi({ description: "Page number" }),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20).openapi({ description: "Items per page" }),
  sort: sortSchema.optional().default("newest").openapi({ description: "Sort order. `rating`: the Bayesian review rank, unreviewed products last." }),
  minRating: minRatingQuerySchema,
  search: z.string().trim().max(100).optional().openapi({ description: "Search within the brand" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  freeDelivery: z.enum(["true", "false"]).optional().openapi({ description: "Free delivery filter" }),
  hasDiscount: z.enum(["true", "false"]).optional().openapi({ description: "Has discount filter" }),
  inStock: z.enum(["true"]).optional().openapi({ description: "Only products a buyer can buy now (exclude sold out)" }),
}).superRefine((value, ctx) => {
  if (value.minPrice !== undefined && value.maxPrice !== undefined && value.minPrice > value.maxPrice) {
    ctx.addIssue({
      code: "custom",
      path: ["maxPrice"],
      message: "Maximum price must be greater than or equal to minimum price",
    });
  }
});

const brandLogoSchema = z.object({
  mediaId: z.string(),
  url: z.string(),
  alt: z.string(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});

const brandSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  canonicalPath: z.string().nullable(),
  logo: brandLogoSchema.nullable(),
});

const brandDetailSchema = brandSummarySchema.extend({
  description: z.string().nullable(),
  metaTitle: z.string().nullable(),
  metaDescription: z.string().nullable(),
  noIndex: z.boolean(),
  excludeFromSitemap: z.boolean(),
  listingTemplate: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const brandProductSchema = z.object({
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
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  rating: cardRatingSchema,
});


const appliedFiltersSchema = z.object({
  attributes: z.array(appliedFacetFilterSchema),
  sort: sortSchema,
  minRating: z.number().int().min(1).max(4).optional(),
  search: z.string().optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  freeDelivery: z.enum(["true", "false"]).optional(),
  hasDiscount: z.enum(["true", "false"]).optional(),
  inStock: z.enum(["true"]).optional(),
});

const slugParams = z.object({ slug: brandSlugSchema });

// GET /brands — published brands in merchant order
const listBrandsRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.brands.list",
  tags: ["Brands"],
  summary: "List published brands",
  request: {
    query: z.object({
      page: z.coerce.number().int().min(1).max(10_000).optional().default(1),
      limit: z.coerce.number().int().min(1).max(PUBLIC_BRAND_PAGE_LIMIT).optional().default(24),
    }),
  },
  responses: {
    200: {
      description: "Published brands, sort order then name",
      content: { "application/json": { schema: successEnvelope(z.object({
        brands: z.array(brandSummarySchema).max(PUBLIC_BRAND_PAGE_LIMIT),
        pagination: paginationSchema,
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(listBrandsRoute, async (c) => {
  return ok(c, await listPublicBrands(c.get("db"), c.req.valid("query")));
});

// GET /brands/sitemap — brand pages for XML discovery (registered before /{slug})
const brandSitemapRoute = createRoute({
  method: "get",
  path: "/sitemap",
  operationId: "storefront.brands.sitemap",
  tags: ["Brands"],
  summary: "List brand pages for the sitemap",
  description: "Published brands without noIndex or excludeFromSitemap, filtered before the limit.",
  responses: {
    200: {
      description: "Brand sitemap entries",
      content: { "application/json": { schema: successEnvelope(z.object({
        brands: z.array(z.object({
          slug: z.string(),
          canonicalPath: z.string().nullable(),
          updatedAt: z.string().nullable(),
        })).max(BRAND_SITEMAP_LIMIT),
      })) } },
    },
    500: errorResponses[500],
  },
});

app.openapi(brandSitemapRoute, async (c) => {
  return ok(c, { brands: await getPublicBrandSitemapEntries(c.get("db")) });
});

// GET /brands/{slug}
const getBrandRoute = createRoute({
  method: "get",
  path: "/{slug}",
  operationId: "storefront.brands.get",
  tags: ["Brands"],
  summary: "Get a published brand by slug",
  request: { params: slugParams },
  responses: {
    200: {
      description: "Brand",
      content: { "application/json": { schema: successEnvelope(z.object({ brand: brandDetailSchema })) } },
    },
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getBrandRoute, async (c) => {
  const brand = await getPublicBrandBySlug(c.get("db"), c.req.valid("param").slug);
  if (!brand) throw new NotFoundError("Brand not found");
  return ok(c, { brand });
});

// GET /brands/{slug}/products — the brand page listing
const getBrandProductsRoute = createRoute({
  method: "get",
  path: "/{slug}/products",
  operationId: "storefront.brands.list_products",
  tags: ["Brands"],
  summary: "Get a brand's products with filtering",
  request: { params: slugParams, query: brandProductFilterSchema },
  responses: {
    200: {
      description: "Brand products with pagination and filters",
      content: { "application/json": { schema: successEnvelope(z.object({
        brand: brandDetailSchema,
        products: z.array(brandProductSchema),
        pagination: paginationSchema,
        priceRange: z.object({ min: z.number().min(0), max: z.number().min(0) }),
        facets: z.array(productFacetSchema),
        ratingFacet: ratingFacetSchema,
        appliedFilters: appliedFiltersSchema,
      })) } },
    },
    400: errorResponses[400],
    404: errorResponses[404],
    500: errorResponses[500],
  },
});

app.openapi(getBrandProductsRoute, async (c) => {
  const db = c.get("db");
  const { slug } = c.req.valid("param");
  const params = c.req.valid("query");
  const [brand, attributeFilters] = await Promise.all([
    getPublicBrandBySlug(db, slug),
    // The brand page is its own brand filter: no `brand` key.
    resolvePublicAttributeFilters(db, readRepeatedPublicQueryValues(c.req.url), Object.keys(params), { brand: false }),
  ]);
  if (!brand) throw new NotFoundError("Brand not found");

  const result = await getStorefrontBrandProducts(db, brand, {
    ...params,
    search: normalizePublicListingSearchParam(params.search),
    attributeFilters,
  });
  const appliedFilters: z.infer<typeof appliedFiltersSchema> = { attributes: appliedFacetFilters(attributeFilters), sort: params.sort };
  const normalizedSearch = normalizePublicFtsSearchQuery(params.search);
  if (normalizedSearch) appliedFilters.search = normalizedSearch;
  if (params.minRating !== undefined) appliedFilters.minRating = params.minRating;
  if (params.minPrice !== undefined) appliedFilters.minPrice = params.minPrice;
  if (params.maxPrice !== undefined) appliedFilters.maxPrice = params.maxPrice;
  if (params.freeDelivery !== undefined) appliedFilters.freeDelivery = params.freeDelivery;
  if (params.hasDiscount !== undefined) appliedFilters.hasDiscount = params.hasDiscount;
  if (params.inStock !== undefined) appliedFilters.inStock = params.inStock;

  return ok(c, {
    brand,
    products: result.products,
    pagination: result.pagination,
    priceRange: result.priceRange,
    facets: result.facets,
    ratingFacet: result.ratingFacet,
    appliedFilters,
  });
});

export { app as brandRoutes };
