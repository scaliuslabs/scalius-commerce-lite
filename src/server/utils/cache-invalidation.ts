// src/server/utils/cache-invalidation.ts
import { deleteCacheByPattern } from "./redis";
import { createResourceCachePattern } from "../middleware/cache";

/**
 * Clear cache for a specific resource type
 *
 * @param resourceType Resource type (e.g., 'products', 'categories')
 */
export async function invalidateResourceCache(
  resourceType: string,
): Promise<void> {
  try {
    await deleteCacheByPattern(createResourceCachePattern(resourceType));
    console.log(`Cache cleared for ${resourceType}`);
  } catch (error) {
    console.error(`Error clearing ${resourceType} cache:`, error);
  }
}

/**
 * Clear related caches when a resource is modified
 * This will clear caches for resources that depend on the modified resource
 *
 * @param primaryResource The primary resource being modified
 * @param relatedResources Additional resources to invalidate (e.g., when a category changes, products may need refreshing)
 */
export async function invalidateRelatedCaches(
  primaryResource: string,
  relatedResources: string[] = [],
): Promise<void> {
  const uniqueResources = [primaryResource, ...relatedResources].filter(
    (value, index, self) => self.indexOf(value) === index,
  );

  for (const resource of uniqueResources) {
    await invalidateResourceCache(resource);
  }
}

/**
 * Map of resource types to their related resources
 * When a resource is modified, these related resources should also have their caches cleared
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
 * Clear cache for a resource and its related resources based on predefined relationships
 *
 * @param resourceType Resource type being modified
 */
export async function invalidateCacheWithRelationships(
  resourceType: string,
): Promise<void> {
  const relatedResources = resourceRelationships[resourceType] || [];
  await invalidateRelatedCaches(resourceType, relatedResources);
}

/**
 * Clears the ENTIRE Hono API cache for the current project.
 * It does this by deleting all keys that match the project's cache prefix.
 */
export async function invalidateEntireCache(): Promise<void> {
  try {
    // The '*' pattern will match all keys under the current project prefix
    await deleteCacheByPattern("*");
    console.log(
      `[Cache Invalidator] Successfully cleared the entire project cache.`,
    );
  } catch (error) {
    console.error(
      `[Cache Invalidator] Error clearing the entire project cache:`,
      error,
    );
  }
}
