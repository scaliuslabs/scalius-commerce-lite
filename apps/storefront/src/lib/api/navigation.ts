// src/lib/api/navigation.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { NavigationItem } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Fetches navigation data for specified areas of the site.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 * @param type The type of navigation to fetch ('header', 'footer', or 'mobile_menu').
 * @returns A promise resolving to an array of navigation items, or null on failure.
 */
export async function getNavigationData(
  type: "header" | "footer" | "mobile_menu" = "header",
): Promise<NavigationItem[] | null> {
  return withEdgeCache(
    `global_navigation_${type}`,
    async () => {
      try {
        const url = createApiUrl(`/navigation?type=${type}&format=nested`);
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const data: {
          navigation: Record<string, NavigationItem[]>;
          success: boolean;
        } = await response.json();

        if (data.success && data.navigation) {
          return data.navigation[type] || [];
        }
        return null;
      } catch (error) {
        console.error(
          `Error fetching navigation data for type "${type}":`,
          error,
        );
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
