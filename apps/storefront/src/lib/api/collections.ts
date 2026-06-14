// src/lib/api/collections.ts
import { getConfiguredSdkClient } from "./client";
import type {
  Collection,
  CollectionWithProducts,
  CategorySummary,
  Product,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import {
  getApiV1Collections,
  getApiV1CollectionsById,
} from "@scalius/api-client/sdk";

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
        const { data, error } = await getApiV1CollectionsById({
          client: getConfiguredSdkClient(),
          path: { id },
        });
        if (error) return null;

        const d = unwrapData<{ collection: Collection; categories?: CategorySummary[]; products?: Product[]; featuredProduct?: Product | null }>(data);
        if (d?.collection) {
          return {
            ...d.collection,
            categories: d.categories as CategorySummary[] | undefined,
            products: d.products as Product[] | undefined,
            featuredProduct: d.featuredProduct as Product | null | undefined,
          } as CollectionWithProducts;
        }

        return null;
      } catch (error: unknown) {
        console.error(`Error fetching collection by ID "${id}":`, error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
