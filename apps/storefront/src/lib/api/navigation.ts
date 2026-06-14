// src/lib/api/navigation.ts

import { getConfiguredSdkClient } from "./client";
import type { NavigationItem } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import { getApiV1Navigation } from "@scalius/api-client/sdk";
import type { GetApiV1NavigationData } from "@scalius/api-client/types";

type StorefrontNavigationQuery = {
  type: "header" | "footer" | "mobile_menu";
  format: "nested";
};

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
        const query: StorefrontNavigationQuery = { type, format: "nested" };
        const { data } = await getApiV1Navigation({
          client: getConfiguredSdkClient(),
          query: query as unknown as GetApiV1NavigationData["query"],
        });
        const d = unwrapData<{ navigation: Record<string, NavigationItem[]> }>(data);
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
