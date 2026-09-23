// src/lib/api/header.ts

import { getConfiguredSdkClient } from "./transport";
import type { HeaderData } from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapData } from "./unwrap";
import { getApiV1Header } from "@scalius/api-client/sdk";

/**
 * Fetches the configuration data for the site header.
 * Coalesced per request; the API caches it by cache generation.
 */
export async function getHeaderData(): Promise<HeaderData | null> {
  return withEdgeCache(
    "global_header_data",
    async () => {
      try {
        const { data } = await getApiV1Header({
          client: getConfiguredSdkClient(),
        });
        const d = unwrapData<{ header: HeaderData }>(data);
        return d?.header ?? null;
      } catch (error: unknown) {
        console.error("Error fetching header data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
