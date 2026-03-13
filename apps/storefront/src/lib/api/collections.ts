// src/lib/api/collections.ts
import { createApiUrl, fetchWithRetry } from "./client";
import type {
  Collection,
  CollectionWithProducts,
  CategorySummary,
  Product,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

// Define the expected structure of the API response for a single collection
interface CollectionApiResponse {
  collection: Collection;
  categories?: CategorySummary[];
  products?: Product[];
  featuredProduct?: Product | null;
}

/**
 * Fetches a list of all active collections.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @returns A promise resolving to an array of Collection objects or null on failure.
 */
export async function getAllCollections(): Promise<Collection[] | null> {
  return withEdgeCache(
    "global_all_collections",
    async () => {
      try {
        const url = createApiUrl("/collections");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: { collections: Collection[] } = await response.json();
        return data.collections;
      } catch (error) {
        console.error("Error fetching all collections:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches a single collection by its ID, including its associated products and category details.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @param id The unique identifier of the collection.
 * @returns A promise resolving to a detailed Collection object or null if not found.
 */
export async function getCollectionById(
  id: string,
): Promise<CollectionWithProducts | null> {
  if (!id) {
    console.error("getCollectionById: id is required.");
    return null;
  }

  return withEdgeCache(
    `collection_by_id_${id}`,
    async () => {
      try {
        const url = createApiUrl(`/collections/${id}`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new Error(`API error: ${response.status}`);
        }

        const responseData: CollectionApiResponse = await response.json();

        if (responseData && responseData.collection) {
          return {
            ...responseData.collection,
            categories: responseData.categories,
            products: responseData.products,
            featuredProduct: responseData.featuredProduct,
          };
        }

        return null;
      } catch (error) {
        console.error(`Error fetching collection by ID "${id}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
