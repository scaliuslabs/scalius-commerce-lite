// src/lib/api/storefront.ts
// Consolidated storefront API functions for maximum performance
// Reduces multiple API calls to single optimized requests

import { getConfiguredSdkClient } from "./client";
import { withEdgeCache, CACHE_TTL } from "@/lib/edge-cache";
import { unwrapEnvelope } from "./unwrap";
import { BUILD_ID } from "@/config/build-id";
import type {
  CollectionWithProducts,
  HeaderData,
  FooterData,
  NavigationItem,
  AnalyticsConfig,
  Category,
} from "./types";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { StorefrontThemeSettings } from "@scalius/shared/storefront-theme";
import type { HeroSlideFocalPoint } from "@scalius/shared/hero-slider";
import type {
  StorefrontBusinessInfo,
  StorefrontReturnPolicySettings,
} from "@/lib/commerce-structured-data";
import {
  getApiV1StorefrontHomepage,
  getApiV1StorefrontLayout,
} from "@scalius/api-client/sdk";
import { createApiUrl, fetchWithRetry } from "./client";

// =============================================
// HOMEPAGE DATA TYPES
// =============================================

export interface HeroSliderImage {
  url: string;
  title?: string;
  link: string;
  id?: string;
  focalPoint: HeroSlideFocalPoint;
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
  collections: CollectionWithProducts[];
  presentation: {
    categoryRail: {
      enabled: boolean;
      title: string;
      categories: Array<Pick<
        Category,
        "id" | "name" | "slug" | "description" | "imageUrl" | "canonicalPath"
      >>;
    };
    trustStrip: {
      enabled: boolean;
      items: Array<{
        kind: "delivery" | "returns";
        title: string;
        detail: string;
        href?: string;
      }>;
    };
  };
}

// =============================================
// LAYOUT DATA TYPES
// =============================================

export interface CurrencyData {
  code: string;
  symbol: string;
  usdExchangeRate: number;
  decimalPlaces?: number;
}

export interface LayoutData {
  analytics: AnalyticsConfig[];
  header: HeaderData;
  navigation: NavigationItem[];
  footer: FooterData;
  currency?: CurrencyData;
  theme?: StorefrontThemeSettings;
  media?: {
    enabled?: boolean;
    canonicalCdnUrl?: string;
    allowedImageHosts?: string[];
    canonicalHostAliases?: string[];
  };
  metaCapi?: {
    browserEventsEnabled?: boolean;
  };
  business?: StorefrontBusinessInfo;
  seo?: {
    discovery?: SeoDiscoverySettings;
    returnPolicy?: StorefrontReturnPolicySettings | null;
  };
}

export interface ThemePreviewData {
  theme: StorefrontThemeSettings;
  draftRevision: number;
  basePublishedRevision: number;
  expiresAt: string | number;
}

// =============================================
// API FUNCTIONS
// =============================================

/**
 * Fetches all homepage data in a single consolidated request.
 * Reduces 4 + N API calls to 1.
 * Uses the bounded availability TTL because homepage collections expose products.
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
        const { data } = await getApiV1StorefrontHomepage({
          client: getConfiguredSdkClient(),
        });
        return unwrapEnvelope<HomepageData>(data);
      } catch (error: unknown) {
        console.error("Error fetching homepage data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
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
        const { data } = await getApiV1StorefrontLayout({
          client: getConfiguredSdkClient(),
        });
        return unwrapEnvelope<LayoutData>(data);
      } catch (error: unknown) {
        console.error("Error fetching layout data:", error);
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.LONG },
  );
}

export async function resolveThemePreview(
  token: string,
): Promise<ThemePreviewData | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{40,80}$/.test(normalizedToken)) return null;
  try {
    const response = await fetchWithRetry(
      createApiUrl("/storefront/theme-preview/resolve"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: normalizedToken }),
        cache: "no-store",
      },
      0,
      4_000,
      false,
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const payload = await response.json() as unknown;
    return unwrapEnvelope<ThemePreviewData>(payload);
  } catch {
    return null;
  }
}
