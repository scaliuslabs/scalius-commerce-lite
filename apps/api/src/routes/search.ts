import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { search } from "@scalius/core/modules/catalog";
import { getClientIp } from "@scalius/shared/rate-limit";

import { ok } from "../utils/api-response";
import { RateLimitError } from "../utils/api-error";
import { isWithinRateLimit } from "../utils/rate-limit";
import { successEnvelope, errorResponses } from "../schemas/responses";
import {
  normalizePublicFtsSearchQuery,
} from "../utils/public-search-query";
import { marketPresenceQueryField } from "../schemas/markets";
import { publicMarketPricing } from "../utils/public-market";
import { deps } from "@scalius/core/cache-deps";
import { resolveAppProvider } from "@scalius/core/integrations/provider-port";
import { marketPriceContextOf } from "@scalius/core/modules/price-lists";
import { isQualifiedProviderId } from "@scalius/shared/plugins/providers/kinds";
import { BACKUP_MARKET_ID } from "@scalius/database/schema";
import { requestAppProviders } from "../plugins/providers/app-providers";
// Create an OpenAPIHono app for search routes
const app = new OpenAPIHono<{ Bindings: Env }>();

type SearchResults = Awaited<ReturnType<typeof search>>;

/**
 * Keep predictive responses useful and bounded across resource groups. Each
 * matching group gets one result first, then products fill the remaining
 * space before secondary resources. Admin search keeps its existing per-group
 * behavior because it calls the core service directly.
 */
function limitPublicSearchResults(
  results: SearchResults,
  limit: number,
): Omit<SearchResults, "correctedQuery"> {
  const products: SearchResults["products"] = [];
  const categories: SearchResults["categories"] = [];
  const pages: SearchResults["pages"] = [];
  let remaining = limit;

  const addFirst = <T>(source: readonly T[], target: T[]): void => {
    if (remaining === 0 || source.length === 0) return;
    target.push(source[0]!);
    remaining -= 1;
  };
  const fill = <T>(source: readonly T[], target: T[]): void => {
    if (remaining === 0 || source.length < 2) return;
    const additional = source.slice(1, remaining + 1);
    target.push(...additional);
    remaining -= additional.length;
  };

  addFirst(results.products, products);
  addFirst(results.categories, categories);
  addFirst(results.pages, pages);
  fill(results.products, products);
  fill(results.categories, categories);
  fill(results.pages, pages);

  return { products, categories, pages };
}

// Schema for search query validation
const searchQuerySchema = z.object({
  presence: marketPresenceQueryField,
  q: z.string().max(120).optional().default("").openapi({ description: "Search query" }),
  categoryId: z.string().optional().openapi({ description: "Category ID filter" }),
  minPrice: z.coerce.number().min(0).optional().openapi({ description: "Minimum effective buyer-SKU price" }),
  maxPrice: z.coerce.number().min(0).optional().openapi({ description: "Maximum effective buyer-SKU price" }),
  limit: z.coerce.number().int().min(1).max(50).optional().default(10).openapi({ description: "Max results" }),
  searchPages: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true")
    .openapi({ description: "Include pages in search results" }),
  searchCategories: z
    .enum(["true", "false"])
    .optional()
    .default("true")
    .transform((val) => val === "true")
    .openapi({ description: "Include categories in search results" }),
  provider: z.string().max(160).optional().openapi({
    description: "The store's search app (`layout.appServices.search`): it ranks the product hits; built-in search answers when it is not ready, slow or failing.",
  }),
  locale: z.string().regex(/^[a-z]{2}$/).optional().openapi({ description: "The page's language, for the search app." }),
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

// GET /search — perform a search across products, categories, and pages
const searchRoute = createRoute({
  method: "get",
  path: "/",
  operationId: "storefront.search.predict",
  tags: ["Search"],
  summary: "Search across products, categories, and pages",
  request: {
    query: searchQuerySchema
  },
  responses: {
    200: {
      description: "Search results",
      content: { "application/json": { schema: successEnvelope(z.object({
        products: z.array(z.object({
          id: z.string(),
          name: z.string(),
          slug: z.string(),
          price: z.number(),
          discountedPrice: z.number(),
          priceVaries: z.boolean(),
          availableForSale: z.boolean(),
          quickAddEligible: z.boolean(),
          hasVariants: z.boolean(),
          imageUrl: z.string().url().nullable(),
          imageMediaId: z.string().nullable(),
          imageAlt: z.string().nullable(),
          categoryId: z.string().nullable(),
          categoryName: z.string().nullable(),
        })),
        pages: z.array(z.object({ id: z.string(), title: z.string(), slug: z.string() })),
        categories: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
        query: z.string(),
        correctedQuery: z.string().nullable().openapi({
          description: "Set when `q` matched nothing and these results are for the closest catalog words instead (typo or Bangla correction).",
        }),
      })) } },
    },
    400: errorResponses[400],
    429: errorResponses[429],
    500: errorResponses[500],
  }
});

app.openapi(searchRoute, async (c) => {
  const params = c.req.valid("query");
  const {
    q,
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories,
    provider,
    locale,
  } = params;
  const query = normalizePublicFtsSearchQuery(q);

  // If no query, return empty results
  if (!query) {
    return ok(c, {
      products: [],
      pages: [],
      categories: [],
      query: "",
      correctedQuery: null,
    });
  }

  // Cloudflare's native limiter keeps abuse protection on-machine without
  // adding a network round trip to high-cardinality predictive queries.
  if (!(await isWithinRateLimit(c.env, "RL_STANDARD", "search", getClientIp(c.req.raw)))) {
    throw new RateLimitError("Too many requests. Please try again later.");
  }

  // Set up timeout for search (5 seconds)
  const db = c.get("db");
  // The page's market prices the hits (its presence is part of the cache key).
  const pricing = publicMarketPricing(c);
  // A search app ranks the products (a live call no key validates); any
  // failure keeps built-in search.
  if (provider) deps.uncacheable("search-app");
  const productIds = provider ? await appRankedProductIds(c, provider, { query, locale: locale ?? "en", pricing, limit }) : null;
  const searchPromise = search(db, query, {
    categoryId,
    minPrice,
    maxPrice,
    limit,
    searchPages,
    searchCategories,
    correctTypos: productIds === null,
    ...(productIds ? { productIds } : {}),
    pricing,
  });

  // Set timeout for the search operation
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("Search timed out")), 5000);
  });

  let results: Awaited<typeof searchPromise>;
  try {
    results = await Promise.race([searchPromise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }

  const limitedResults = limitPublicSearchResults(results, limit);

  // The full search page uses the dedicated product-list endpoint; this route
  // stays compact for predictive search clients.
  return ok(c, {
    products: limitedResults.products,
    pages: limitedResults.pages,
    categories: limitedResults.categories,
    query,
    correctedQuery: results.correctedQuery,
  });
});

/** How long predictive search waits for a search app before it answers by itself. */
const SEARCH_APP_WAIT_MS = 1_500;

/**
 * The product ids a search app ranked for the words, or null to use built-in
 * search (no such ready app, a timeout, a failure). Unknown or hidden ids are
 * dropped by the catalog read, which also prices them.
 */
async function appRankedProductIds(
  c: Parameters<typeof requestAppProviders>[0],
  providerId: string,
  input: { query: string; locale: string; pricing: ReturnType<typeof publicMarketPricing>; limit: number },
): Promise<string[] | null> {
  if (!isQualifiedProviderId(providerId)) return null;
  const choice = await resolveAppProvider(requestAppProviders(c), "search", providerId).catch(() => null);
  if (!choice?.provider) return null;
  const marketId = (await marketPriceContextOf(input.pricing).catch(() => null))?.marketId ?? BACKUP_MARKET_ID;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_APP_WAIT_MS);
  try {
    const answer = await choice.provider.search(
      { query: input.query.slice(0, 120), locale: input.locale, marketId, limit: Math.min(input.limit, 50) },
      { signal: controller.signal },
    );
    return answer.productIds;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Export the search routes
export { app as searchRoutes };
