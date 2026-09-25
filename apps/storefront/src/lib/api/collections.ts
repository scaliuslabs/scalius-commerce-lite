// src/lib/api/collections.ts
import { getConfiguredSdkClient } from "./transport";
import type {
  Collection,
  CollectionWithProducts,
  CategorySummary,
  Product,
  BuyerPriceRange,
} from "./types";
import { normalizeProductFacets, type ProductListOptions } from "./products";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import {
  getApiV1Collections,
  getApiV1CollectionsById,
  getApiV1CollectionsSitemap,
} from "@scalius/api-client/sdk";

export interface SitemapCollection {
  id: string;
  canonicalPath: string | null;
  updatedAt: string | null;
}

/**
 * Collection pages for the sitemap (the API leaves out noIndex and
 * excludeFromSitemap collections before its limit), or null on failure.
 */
export async function getSitemapCollections(): Promise<SitemapCollection[] | null> {
  return withEdgeCache(
    "sitemap_collections",
    async () => {
      try {
        const { data, error } = await getApiV1CollectionsSitemap({ client: getConfiguredSdkClient() });
        if (error) {
          console.error("Error fetching sitemap collections:", error);
          return null;
        }
        return unwrapData<{ collections: SitemapCollection[] }>(data)?.collections ?? null;
      } catch (error: unknown) {
        console.error("Error fetching sitemap collections:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
import { buildCanonicalQueryString } from "@/lib/canonical-query";

export type CollectionByIdResult =
  | { state: "found"; data: CollectionWithProducts }
  | { state: "not_found" }
  | { state: "unavailable" };

function normalizeCollectionDetail(payload: unknown): CollectionWithProducts | null {
  const candidate = unwrapData<{
    collection: Collection;
    categories?: CategorySummary[];
    products?: Product[];
    featuredProduct?: Product | null;
    pagination?: CollectionWithProducts["pagination"];
    priceRange?: BuyerPriceRange;
    facets?: unknown;
  }>(payload);
  if (
    !candidate?.collection ||
    typeof candidate.collection !== "object" ||
    (candidate.categories !== undefined && !Array.isArray(candidate.categories)) ||
    (candidate.products !== undefined && !Array.isArray(candidate.products)) ||
    !candidate.pagination ||
    !Number.isInteger(candidate.pagination.page) ||
    !Number.isInteger(candidate.pagination.limit) ||
    !Number.isInteger(candidate.pagination.total) ||
    !Number.isInteger(candidate.pagination.totalPages) ||
    (candidate.facets !== undefined && !Array.isArray(candidate.facets)) ||
    (
      candidate.featuredProduct !== undefined &&
      candidate.featuredProduct !== null &&
      typeof candidate.featuredProduct !== "object"
    )
  ) {
    return null;
  }

  return {
    ...candidate.collection,
    categories: candidate.categories,
    products: candidate.products,
    featuredProduct: candidate.featuredProduct,
    pagination: candidate.pagination,
    priceRange: candidate.priceRange,
    facets: normalizeProductFacets(candidate.facets),
  } as CollectionWithProducts;
}

/**
 * Fetches a list of all active collections.
 * Coalesced per request; the API caches it by cache generation.
 * @returns A promise resolving to an array of Collection objects or null on failure.
 */
export async function getAllCollections(): Promise<Collection[] | null> {
  return withEdgeCache(
    "global_all_collections",
    async () => {
      try {
        const { data } = await getApiV1Collections({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<{ collections: Collection[] }>(data)?.collections ?? null;
      } catch (error: unknown) {
        console.error("Error fetching all collections:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a single collection by its ID, including its associated products and category details.
 * Coalesced per request; the API caches it by cache generation.
 * @param id The unique identifier of the collection.
 * @returns A promise resolving to a detailed Collection object or null if not found.
 */
export async function getCollectionById(
  id: string,
  options: ProductListOptions = {},
): Promise<CollectionWithProducts | null> {
  const result = await getCollectionByIdResult(id, options);
  return result.state === "found" ? result.data : null;
}

/**
 * Reads collection detail data while preserving authoritative not-found
 * separately from temporary upstream failures and malformed responses.
 */
export async function getCollectionByIdResult(
  id: string,
  options: ProductListOptions = {},
): Promise<CollectionByIdResult> {
  if (!id) {
    console.error("getCollectionByIdResult: id is required.");
    return { state: "unavailable" };
  }

  const queryString = buildCanonicalQueryString(options, {
    defaultParams: { page: 1, limit: 20 },
  });
  const result = await withEdgeCache<CollectionByIdResult>(
    `collection_by_id_${id}::${queryString || "default"}`,
    async () => {
      try {
        const sdkArgs = {
          client: getConfiguredSdkClient(),
          path: { id },
          query: options as Record<string, unknown>,
        };
        const { data, error, response } = await getApiV1CollectionsById(sdkArgs);
        if (response?.status === 404) {
          return { state: "not_found" };
        }
        if (
          error ||
          (response && (response.status < 200 || response.status >= 300))
        ) {
          console.error(
            `Error fetching collection by ID "${id}" (status ${response?.status ?? "unknown"}).`,
          );
          return null;
        }

        const collection = normalizeCollectionDetail(data);
        if (!collection) {
          console.error(`Invalid collection response for ID "${id}".`);
          return null;
        }

        return { state: "found", data: collection };
      } catch (error: unknown) {
        console.error(`Error fetching collection by ID "${id}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );

  return result ?? { state: "unavailable" };
}
