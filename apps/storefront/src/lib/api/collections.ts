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
  }>(payload);
  if (
    !candidate?.collection ||
    typeof candidate.collection !== "object" ||
    (candidate.categories !== undefined && !Array.isArray(candidate.categories)) ||
    (candidate.products !== undefined && !Array.isArray(candidate.products)) ||
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
  } as CollectionWithProducts;
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
  const result = await getCollectionByIdResult(id);
  return result.state === "found" ? result.data : null;
}

/**
 * Reads collection detail data while preserving authoritative not-found
 * separately from temporary upstream failures and malformed responses.
 */
export async function getCollectionByIdResult(
  id: string,
): Promise<CollectionByIdResult> {
  if (!id) {
    console.error("getCollectionByIdResult: id is required.");
    return { state: "unavailable" };
  }

  const result = await withEdgeCache<CollectionByIdResult>(
    `collection_by_id_${id}`,
    async () => {
      try {
        const { data, error, response } = await getApiV1CollectionsById({
          client: getConfiguredSdkClient(),
          path: { id },
        });
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
    { ttlSeconds: CACHE_TTL.LONG },
  );

  return result ?? { state: "unavailable" };
}
