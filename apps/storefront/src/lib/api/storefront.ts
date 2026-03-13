// src/lib/api/storefront.ts
// Consolidated storefront API functions for maximum performance
// Reduces multiple API calls to single optimized requests

import { createApiUrl, fetchWithRetry } from "./client";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { BUILD_ID } from "@/config/build-id";
import type {
  ApiWidget,
  CollectionWithProducts,
  HeaderData,
  FooterData,
  NavigationItem,
  AnalyticsConfig,
} from "./types";

// =============================================
// HOMEPAGE DATA TYPES
// =============================================

export interface HeroSliderImage {
  url: string;
  title?: string;
  link: string;
  id?: string;
}

export interface HeroSlider {
  id: string;
  type: "desktop" | "mobile";
  images: HeroSliderImage[];
}

export interface HomepageHero {
  desktop: HeroSlider | null;
  mobile: HeroSlider | null;
}

export interface HomepageData {
  seo: {
    siteTitle: string | null;
    homepageTitle: string | null;
    homepageMetaDescription: string | null;
  };
  hero: HomepageHero;
  widgets: ApiWidget[];
  collections: CollectionWithProducts[];
}

// =============================================
// LAYOUT DATA TYPES
// =============================================

export interface CurrencyData {
  code: string;
  symbol: string;
  usdExchangeRate: number;
}

export interface LayoutData {
  analytics: AnalyticsConfig[];
  header: HeaderData;
  navigation: NavigationItem[];
  footer: FooterData;
  currency?: CurrencyData;
  theme?: { colors: Record<string, string> };
}

// =============================================
// API FUNCTIONS
// =============================================

/**
 * Fetches all homepage data in a single consolidated request.
 * Reduces 4 + N API calls to 1.
 * Wrapped with EdgeCache ( TTL) - invalidated via purge-cache.
 *
 * IMPORTANT: Cache key includes BUILD_ID to ensure fresh data after deployments.
 *
 * @returns A promise resolving to HomepageData or null on failure.
 */
export async function getHomepageData(): Promise<HomepageData | null> {
  return withEdgeCache(
    `storefront_homepage_${BUILD_ID}`,
    async () => {
      try {
        const url = createApiUrl("/storefront/homepage");
        const response = await fetchWithRetry(url, {}, 3, 15000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: HomepageData } =
          await response.json();

        if (json.success && json.data) {
          return json.data;
        }
        return null;
      } catch (error) {
        console.error("Error fetching homepage data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

/**
 * Fetches all layout data in a single consolidated request.
 * Reduces 4 API calls to 1.
 * Used on ALL pages (not just homepage).
 * Wrapped with EdgeCache ( TTL) - invalidated via purge-cache.
 *
 * IMPORTANT: Cache key includes BUILD_ID to ensure fresh data after deployments.
 *
 * @returns A promise resolving to LayoutData or null on failure.
 */
export async function getLayoutData(): Promise<LayoutData | null> {
  return withEdgeCache(
    `storefront_layout_${BUILD_ID}`,
    async () => {
      try {
        const url = createApiUrl("/storefront/layout");
        const response = await fetchWithRetry(url, {}, 3, 15000, false);

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const json: { success: boolean; data: LayoutData } =
          await response.json();

        if (json.success && json.data) {
          return json.data;
        }
        return null;
      } catch (error) {
        console.error("Error fetching layout data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}
