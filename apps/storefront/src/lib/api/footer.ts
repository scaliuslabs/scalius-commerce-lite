// src/lib/api/footer.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type { FooterData } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Fetches the configuration data for the site footer.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getFooterData(): Promise<FooterData | null> {
  return withEdgeCache(
    "global_footer_data",
    async () => {
      try {
        const url = createApiUrl("/footer");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { footer: FooterData; success: boolean } =
          await response.json();

        if (json.success && json.footer) {
          return json.footer;
        }
        return null;
      } catch (error) {
        console.error("Error fetching footer data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
