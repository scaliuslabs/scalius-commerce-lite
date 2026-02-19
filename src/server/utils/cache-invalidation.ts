// src/server/utils/cache-invalidation.ts
import { deleteCacheByPattern } from "./kv-cache";
import { createResourceCachePattern } from "../middleware/cache";

/**
 * Clear cache for a specific resource type.
 */
export async function invalidateResourceCache(
  resourceType: string,
  kv?: KVNamespace,
): Promise<void> {
  try {
    await deleteCacheByPattern(createResourceCachePattern(resourceType), kv);
    console.log(`[Cache] Cleared cache for "${resourceType}"`);
  } catch (error) {
    console.error(`[Cache] Error clearing "${resourceType}" cache:`, error);
  }
}

/**
 * Clear cache for a resource and all related resources.
 */
export async function invalidateRelatedCaches(
  primaryResource: string,
  relatedResources: string[] = [],
  kv?: KVNamespace,
): Promise<void> {
  const unique = [primaryResource, ...relatedResources].filter(
    (v, i, arr) => arr.indexOf(v) === i,
  );
  for (const resource of unique) {
    await invalidateResourceCache(resource, kv);
  }
}

/**
 * Map of resource types to their related resources.
 */
export const resourceRelationships: Record<string, string[]> = {
  products: ["search", "collections"],
  categories: ["products", "navigation", "search"],
  collections: ["products"],
  hero: ["header"],
  navigation: ["header"],
  pages: ["search", "footer"],
  footer: [],
  header: [],
  search: [],
};

/**
 * Clear cache for a resource and its related resources based on predefined relationships.
 */
export async function invalidateCacheWithRelationships(
  resourceType: string,
  kv?: KVNamespace,
): Promise<void> {
  const related = resourceRelationships[resourceType] || [];
  await invalidateRelatedCaches(resourceType, related, kv);
}

/**
 * Clear the entire API cache (all keys under the project prefix).
 */
export async function invalidateEntireCache(kv?: KVNamespace): Promise<void> {
  try {
    await deleteCacheByPattern("*", kv);
    console.log("[Cache] Successfully cleared the entire project cache.");
  } catch (error) {
    console.error("[Cache] Error clearing the entire project cache:", error);
  }
}
