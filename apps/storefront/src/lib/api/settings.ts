// src/lib/api/settings.ts

import { getConfiguredSdkClient } from "./transport";
import type {
  SeoSettings,
  CheckoutLanguageData,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { unwrapEnvelope, unwrapData } from "./unwrap";
import {
  getApiV1Seo,
  getApiV1CheckoutLanguagesActive,
} from "@scalius/api-client/sdk";
import { normalizeSeoDiscoverySettings } from "@scalius/shared/seo-discovery";

/**
 * Fetches the global SEO settings for the site.
 * Coalesced per request; the API caches it by cache generation.
 */
export async function getSeoSettings(): Promise<SeoSettings | null> {
  return withEdgeCache(
    "global_seo_settings",
    async () => {
      try {
        const { data } = await getApiV1Seo({
          client: getConfiguredSdkClient(),
        });
        const settings = unwrapEnvelope<SeoSettings>(data);
        if (!settings) return null;
        return {
          ...settings,
          discovery: normalizeSeoDiscoverySettings(settings.discovery),
        };
      } catch (error: unknown) {
        console.error("Error fetching SEO settings:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches the active language configuration for the checkout page.
 * Coalesced per request; the API caches it by cache generation.
 */
export async function getActiveCheckoutLanguage(): Promise<CheckoutLanguageData | null> {
  return withEdgeCache(
    "global_checkout_language",
    async () => {
      try {
        const { data } = await getApiV1CheckoutLanguagesActive({
          client: getConfiguredSdkClient(),
        });
        return unwrapData<{ language: CheckoutLanguageData }>(data)?.language ?? null;
      } catch (error: unknown) {
        console.error("Error fetching active checkout language:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
