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
  FooterMenu,
  NavigationItem,
  AnalyticsConfig,
} from "./types";
import type { SeoDiscoverySettings } from "@scalius/shared/seo-discovery";
import type { MarketMatrix } from "@scalius/shared/markets";
import type { HomepageAppSurface } from "@/lib/app-surfaces";
import type { ProductPageCopy } from "@scalius/shared/checkout-language";
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

export interface HomepageData {
  seo: {
    homepageTitle: string | null;
    homepageMetaDescription: string | null;
  };
  /** What the published theme's homepage sections show (lib/homepage-sections.ts reads it by key). */
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
    | "hasVariants" | "imageUrl" | "imageAlt" | "cardFacts"
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

/** A brand-wall brand: published, live, with a public product. */
export interface HomepageBrand {
  id: string;
  name: string;
  slug: string;
  canonicalPath: string | null;
  logo: { mediaId: string; url: string; alt: string; width: number | null; height: number | null } | null;
}

/** A deal countdown's promotion: running, ending at `endsAt`. */
export interface HomepagePromotionEnd {
  id: string;
  endsAt: string;
}

/** A category-tiles category: a published category a section names. */
export interface HomepageCategory {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  imageUrl: string | null;
  canonicalPath: string | null;
}

/** The product a product homepage opens on, while it is public. */
export interface HomepageProduct {
  id: string;
  slug: string;
}

/** One field of a object entry as a section shows it: the stored canonical text of a custom-field type. */
export interface HomepageObjectField {
  key: string;
  name: string;
  /** A custom-field type id (`single_line_text`, `money`, `list.media_reference`...). */
  type: string;
  /** The custom-field HTTP contract: text, dates, URLs, colours and media ids as strings; integers as numbers; money as `{ amountMinor, currency }`; booleans; lists as arrays. */
  value: string | number | boolean | { amountMinor: number; currency: string } | unknown[] | null;
}

/** A Objects section's content type with its published entries (only types with storefront access are sent). */
export interface HomepageObject {
  id: string;
  name: string;
  entries: Array<{ handle: string; title: string; fields: HomepageObjectField[] }>;
}

/**
 * Everything the theme's homepage sections name (`homeSectionRequests`):
 * the published theme's in the homepage read, a draft's behind a preview
 * token. Categories and collections come in the order the sections name
 * them; ones that are not public (or, for collections, have no products)
 * are left out.
 */
export interface HomepageSectionData {
  bindingObjects?: import("@scalius/shared/storefront-theme/bindings").BindingObjects;
  lists: HomepageProductList[];
  media: HomepageMediaAsset[];
  brands: HomepageBrand[];
  promotions: HomepagePromotionEnd[];
  categories: HomepageCategory[];
  collections: CollectionWithProducts[];
  homeProduct: HomepageProduct | null;
  /**
   * The app sections that drew something (component data), by
   * section id; read through `readHomepageAppSurfaces` (lib/app-surfaces).
   * An app section missing here renders nothing. Absent from an older API.
   */
  apps?: HomepageAppSurface[];
  /**
   * The Objects sections' content types and entries, by definition id.
   * A type that is private, unknown or without entries is missing, and its
   * section renders nothing. Absent from an older API.
   */
  objects?: HomepageObject[];
}

// =============================================
// LAYOUT DATA TYPES
// =============================================

export interface CurrencyData {
  code: string;
  symbol: string;
  /** ISO 4217 decimal places (0 for JPY, 3 for KWD). */
  decimalPlaces: number;
  /** The store's price increment in minor units (a BDT store's default: 100, whole taka). */
  priceIncrementMinor?: number;
  /** The shop currency, when the page's market sells in its own currency (MARKETS-DESIGN step 6). */
  shopCode?: string;
}

export interface CategoryNavigationNode {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  canonicalPath: string | null;
  imageUrl: string | null;
}

export interface CategoryNavigationTree {
  nodes: CategoryNavigationNode[];
  /** More categories exist than these (the /categories index lists them). */
  truncated: boolean;
}

export interface LayoutData {
  analytics: AnalyticsConfig[];
  navigation: NavigationItem[];
  /**
   * The reachable category tree, flat with parentId, top levels first, cut to
   * the header's link budget (absent from an older API: renders as none).
   */
  categoryTree?: CategoryNavigationTree | null;
  /** The footer menus (Online store -> Navigation), in order. */
  footerMenus?: FooterMenu[];
  currency?: CurrencyData;
  /**
   * Buyer services active apps provide: the search app predictive search
   * passes to /search, the address autocomplete app at checkout, and the
   * sign-in apps. Absent from an older API: none.
   */
  appServices?: {
    search: string | null;
    address: { id: string; countries: "any" | string[] } | null;
    signIn: Array<{ id: string; name: string }>;
  };
  /**
   * Every active market with its countries and subfolder presences (backup
   * first): hreflang, the market selector and the presence a page renders.
   * Absent from an older API: the store has its root presence only.
   */
  markets?: MarketMatrix;
  /**
   * The published theme document (v7). Untrusted until
   * `readStorefrontTheme` (lib/storefront-theme-context) validates it.
   */
  theme?: unknown;
  /**
   * The published theme's brand images (logo, footer logo, favicon)
   * resolved (`StorefrontBrandAssets`). Untrusted until
   * `readStorefrontBrandAssets` (lib/storefront-theme-context) validates it.
   */
  brand?: unknown;
  /** The store's shape for the theme fit rules; validated by `readStoreShape`. */
  storeShape?: unknown;
  media?: {
    canonicalCdnUrl?: string;
    canonicalHostAliases?: string[];
  };
  metaCapi?: {
    browserEventsEnabled?: boolean;
  };
  /** Tracking consent and server events (audit spec S4). */
  tracking?: {
    consentOtherRegions?: "opt_in" | "notice" | "link_only";
    serverEvents?: boolean;
    tiktokBrowserEvents?: boolean;
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
    /** The plan profile serves photos from the store's own origin (`/media/...`). */
    sameOriginMedia?: boolean;
  };
  /** Merchant CSP sources (Settings -> Security), comma-separated. */
  cspAllowedDomains?: string;
  /** The store's IANA time zone (Settings -> Store details): buyer-facing dates use it. */
  timeZone?: string;
  /** Published policy pages linked in Settings -> Policies, in kind order. */
  policies?: Array<{
    kind: "refund" | "privacy" | "terms" | "shipping" | "contact";
    title: string;
    path: string;
  }>;
  /** Product-page copy from the active checkout language (buttons, offers, buyer inputs, fulfilment facts). */
  storefrontCopy?: ProductPageCopy;
  /**
   * Scripts of active apps whose hosts a Super Admin approved. Untrusted
   * until `appScriptsForPage` (lib/app-scripts) checks it; absent from an
   * older API.
   */
  appScripts?: unknown;
  /**
   * Active apps with storefront components. Untrusted until
   * `readStorefrontExtensions` checks it; absent from an older API.
   */
  appExtensions?: unknown;
}

export interface ThemePreviewData {
  /**
   * The saved draft as it is now (the API resolves it on every read, so a
   * refreshed preview shows the latest Save); validated like the published one.
   */
  theme: unknown;
  draftRevision: number;
  basePublishedRevision: number;
  expiresAt: string | number;
  /** The draft's brand images resolved (`StorefrontBrandAssets`); validated like the layout's. */
  brand?: unknown;
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

/** What a preview reads section data for: a landing page, the editor's unsaved sections, a market. */
export interface ThemePreviewSectionsRead {
  pageSlug?: string;
  /** A page template's sections (the draft's), instead of the homepage's. */
  template?: string;
  /** The theme editor's unsaved sections of the page (the preview-only render route). */
  sections?: unknown[];
  /** The previewed market presence (`en-in`); none: the root. */
  presence?: string | null;
  /** Public page owner used only by connected product settings. */
  resource?: string;
}

/**
 * The section data of a theme preview's page: the API reads what the
 * current saved draft's sections name (or the editor's unsaved ones),
 * behind the preview token (private, never cached). Only rendered under a
 * live dashboard preview cookie; the published homepage comes from its one
 * batch part.
 */
export async function getThemePreviewHomepageSections(
  token: string,
  read: ThemePreviewSectionsRead = {},
): Promise<HomepageSectionData | null> {
  const normalizedToken = token.trim();
  if (!/^tpv_[A-Za-z0-9_-]{48}$/.test(normalizedToken)) return null;
  try {
    const response = await apiFetch(
      "/storefront/theme-preview/homepage",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: normalizedToken,
          ...(read.pageSlug ? { pageSlug: read.pageSlug } : {}),
          ...(read.template ? { template: read.template } : {}),
          ...(read.sections ? { sections: read.sections } : {}),
          ...(read.presence ? { presence: read.presence } : {}),
          ...(read.resource ? { resource: read.resource } : {}),
        }),
        cache: "no-store",
      },
      { retries: 0, timeout: 4_000, auth: false },
    );
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    return unwrapEnvelope<HomepageSectionData>(await response.json() as unknown);
  } catch {
    return null;
  }
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
