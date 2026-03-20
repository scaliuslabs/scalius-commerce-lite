// src/lib/api/footer.ts

import { getConfiguredSdkClient } from "./client";
import type { FooterData } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapData } from "./unwrap";
import { getApiV1Footer } from "@scalius/api-client/sdk";

/**
 * Fetches the configuration data for the site footer.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getFooterData(): Promise<FooterData | null> {
  return withEdgeCache(
    "global_footer_data",
    async () => {
      try {
        const { data } = await getApiV1Footer({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<FooterData>(data);
      } catch (error: unknown) {
        console.error("Error fetching footer data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
