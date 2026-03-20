// src/lib/api/navigation.ts

import { getConfiguredSdkClient } from "./client";
import type { NavigationItem } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { getApiV1Navigation } from "@scalius/api-client/sdk";

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
        const { data } = await getApiV1Navigation({
          client: getConfiguredSdkClient(),
          query: { type, format: "nested" } as any,
        });
        const d = (data as any)?.data;
        if (d?.navigation) {
          return (d.navigation[type] as NavigationItem[]) || [];
        }
        return null;
      } catch (error: unknown) {
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
