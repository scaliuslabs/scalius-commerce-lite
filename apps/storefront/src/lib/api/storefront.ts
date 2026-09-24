// src/lib/api/storefront.ts
// Consolidated storefront API functions for maximum performance
// Reduces multiple API calls to single optimized requests

import { getConfiguredSdkClient } from "./transport";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { getRuntime } from "./runtime";
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
import { apiFetch } from "./transport";

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
    canonicalCdnUrl?: string;
    canonicalHostAliases?: string[];
  };
  metaCapi?: {
    browserEventsEnabled?: boolean;
  };
  business?: StorefrontBusinessInfo;
  seo?: {
    discovery?: SeoDiscoverySettings;
    returnPolicy?: StorefrontReturnPolicySettings | null;
    /** Default og:image: "" or an absolute https URL. */
    socialImage?: string;
  };
  /** Public origins of this deployment (Settings -> System -> Platform). */
  platform?: {
    storefrontUrl?: string;
    apiUrl?: string;
    dashboardUrl?: string;
    mediaUrl?: string;
  };
  /** Merchant CSP sources (Settings -> Security), comma-separated. */
  cspAllowedDomains?: string;
  /** Published policy pages linked in Settings -> Policies, in kind order. */
  policies?: Array<{
    kind: "refund" | "privacy" | "terms" | "shipping" | "contact";
    title: string;
    path: string;
  }>;
  /** Product call-to-action copy from the active checkout language. */
  storefrontCopy?: {
    languageCode: string;
    addToCartText: string;
    buyNowText: string;
    unavailableText: string;
    chooseOptionText: string;
    fromPriceText: string;
    quantityLabelText: string;
    quantityLimitText: string;
    saleOfferText: string;
    saleOfferSpendText: string;
    saleOfferGetText: string;
    saleOfferGetSpendText: string;
    freeBenefitText: string;
    percentBenefitText: string;
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

async function fetchLayoutData(): Promise<LayoutData | null> {
  try {
    const { data } = await getApiV1StorefrontLayout({
      client: getConfiguredSdkClient(),
    });
    return unwrapEnvelope<LayoutData>(data);
  } catch (error: unknown) {
    console.error("Error fetching layout data:", error);
    return null;
  }
}

/**
 * Fetches all layout data in a single consolidated request. The middleware
 * makes this read first (it also carries the platform origins and CSP
 * sources), and every later call in the same request reuses that one promise.
 *
 * @returns A promise resolving to LayoutData or null on failure.
 */
export function getLayoutData(): Promise<LayoutData | null> {
  const runtime = getRuntime();
  if (!runtime) return fetchLayoutData();
  runtime.layout ??= fetchLayoutData();
  return runtime.layout;
}

export async function resolveThemePreview(
  token: string,
): Promise<ThemePreviewData | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{48}$/.test(normalizedToken)) return null;
  try {
    const response = await apiFetch(
      "/storefront/theme-preview/resolve",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: normalizedToken }),
        cache: "no-store",
      },
      { retries: 0, timeout: 4_000, auth: false },
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
