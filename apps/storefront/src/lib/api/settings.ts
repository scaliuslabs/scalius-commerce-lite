// src/lib/api/settings.ts

import { createApiUrl, fetchWithRetry } from "./client";
import type {
  SeoSettings,
  AnalyticsConfig,
  CheckoutLanguageData,
} from "./types";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";

/**
 * Defines the structure for the hero slider data, containing separate
 * configurations for desktop and mobile, along with resolved images.
 */
export interface HeroSliderData {
  desktop: {
    id: string;
    type: "desktop";
    images: { url: string; title?: string; link: string; id?: string }[];
  } | null;
  mobile: {
    id: string;
    type: "mobile";
    images: { url: string; title?: string; link: string; id?: string }[];
  } | null;
  images: { url: string; title?: string; link: string; id?: string }[];
  isMobile: boolean;
}

/**
 * Fetches the global SEO settings for the site.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getSeoSettings(): Promise<SeoSettings | null> {
  return withEdgeCache(
    "global_seo_settings",
    async () => {
      try {
        const url = createApiUrl("/seo");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: SeoSettings } = await response.json();
        return json.success ? json.data : null;
      } catch (error: unknown) {
        console.error("Error fetching SEO settings:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches all active analytics configurations.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getAnalyticsConfigurations(): Promise<
  AnalyticsConfig[] | null
> {
  return withEdgeCache(
    "global_analytics_config",
    async () => {
      try {
        const url = createApiUrl("/analytics/configurations");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: { analytics: AnalyticsConfig[] } } = await response.json();
        return json.data.analytics;
      } catch (error: unknown) {
        console.error("Error fetching analytics configurations:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches the active language configuration for the checkout page.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getActiveCheckoutLanguage(): Promise<CheckoutLanguageData | null> {
  return withEdgeCache(
    "global_checkout_language",
    async () => {
      try {
        const url = createApiUrl("/checkout-languages/active");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: { language: CheckoutLanguageData } } = await response.json();
        return json.data.language;
      } catch (error: unknown) {
        console.error("Error fetching active checkout language:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches hero sliders for the homepage.
 * Wrapped with EdgeCache (TTL) - invalidated via purge-cache.
 */
export async function getHeroSliders(): Promise<HeroSliderData | null> {
  return withEdgeCache(
    "homepage_hero_sliders",
    async () => {
      try {
        const url = createApiUrl("/hero/sliders");
        const response = await fetchWithRetry(url, {}, 3, 8000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: HeroSliderData } = await response.json();
        return json.data as HeroSliderData;
      } catch (error: unknown) {
        console.error("Error fetching hero sliders:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
