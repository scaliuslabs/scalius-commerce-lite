// src/lib/api/header.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { HeaderData } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Fetches the configuration data for the site header.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getHeaderData(): Promise<HeaderData | null> {
  return withEdgeCache(
    "global_header_data",
    async () => {
      try {
        const url = createApiUrl("/header");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: { header: HeaderData } } =
          await response.json();

        if (json.success && json.data.header) {
          return json.data.header;
        }
        return null;
      } catch (error: unknown) {
        console.error("Error fetching header data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
