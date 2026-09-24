// src/lib/api/storefront.ts
// Consolidated storefront API functions for maximum performance
// Reduces multiple API calls to single optimized requests

import { getConfiguredSdkClient } from "./transport";
import { withEdgeCache, CACHE_TTL } from "@/lib/api/transport";
import { applyPlatformOrigins, getRuntime } from "./runtime";
import { unwrapEnvelope } from "./unwrap";
import { BUILD_ID } from "@/config/build-id";
import type {
  CollectionWithProducts,
  Product,
  HeaderData,
  FooterData,
  NavigationItem,
  AnalyticsConfig,
  Category,
} from "./types";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { HeroSlide } from "@scalius/shared/hero-slider";
import {
  HOME_MEDIA_PARAM,
  HOME_PRODUCT_LIST_PARAM,
  homeSectionRequestParams,
  type HomeSectionRequests,
} from "@scalius/shared/storefront-theme";
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

/** One banner: `title` is the image's alt text; `heading`/`buttonLabel` are optional overlay copy. */
export type HeroSliderImage = HeroSlide;

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
  /** What the theme's homepage sections show (lib/homepage-sections.ts reads it by key). */
  sections: HomepageSectionData;
}

/** A product list a section reads: one per source key (`storefrontProductSourceKey`). */
export interface HomepageProductList {
  key: string;
  /** Card products (the homepage card projection, not full listing products). */
  products: Array<Pick<
    Product,
    | "id" | "name" | "slug" | "price" | "discountType" | "discountPercentage" | "discountAmount"
    | "discountedPrice" | "priceVaries" | "availableForSale" | "freeDelivery" | "categoryId"
    | "hasVariants" | "imageUrl" | "imageAlt"
  > & { imageMediaId: string | null; secondaryImageUrl: string | null }>;
  category: { id: string; name: string; slug: string; canonicalPath: string | null } | null;
  collection: { id: string; title: string } | null;
}

/** A section image (banner, lookbook or editorial photo, hero side banner). */
export interface HomepageMediaAsset {
  id: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
}

export interface HomepageSectionData {
  lists: HomepageProductList[];
  media: HomepageMediaAsset[];
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
  /**
   * The published theme document (v4). Untrusted until
   * `readStorefrontTheme` (lib/storefront-theme-context) validates it.
   */
  theme?: unknown;
  /** The store's shape for the theme fit rules; validated by `readStoreShape`. */
  storeShape?: unknown;
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
  /** The draft theme document; validated like the published one. */
  theme: unknown;
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
 * The section data of a theme preview's draft: the homepage read with the
 * draft's own product lists and images named in the query (a second read,
 * made only under a dashboard preview; the published page is one batch).
 */
export async function getHomepageSectionData(requests: HomeSectionRequests): Promise<HomepageSectionData | null> {
  const params = homeSectionRequestParams(requests);
  const values = (name: string) => params.filter(([key]) => key === name).map(([, value]) => value);
  return withEdgeCache(
    `storefront_homepage_sections_${BUILD_ID}_${new URLSearchParams(params).toString()}`,
    async () => {
      try {
        const { data } = await getApiV1StorefrontHomepage({
          client: getConfiguredSdkClient(),
          query: { [HOME_PRODUCT_LIST_PARAM]: values(HOME_PRODUCT_LIST_PARAM), [HOME_MEDIA_PARAM]: values(HOME_MEDIA_PARAM) },
        });
        return unwrapEnvelope<HomepageData>(data)?.sections ?? null;
      } catch (error: unknown) {
        console.error("Error fetching homepage section data:", error);
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
 * The request's one layout read. It also carries the platform origins and
 * CSP sources, which are applied to the request runtime as soon as it
 * resolves; every later call in the same request reuses that one promise.
 * Pages start it together with their own reads so they travel in one batch.
 *
 * @returns A promise resolving to LayoutData or null on failure.
 */
export function getLayoutData(): Promise<LayoutData | null> {
  const runtime = getRuntime();
  if (!runtime) return fetchLayoutData();
  runtime.layout ??= fetchLayoutData().then((layout) => {
    applyPlatformOrigins(layout);
    return layout;
  });
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
