import {
  normalizeSeoDiscoverySettings,
  type SeoDiscoverySettings,
} from "@scalius/shared/seo-discovery";

const SITEMAP_SECTIONS = [
  ["staticPages", "Home + search"] as const,
  ["products", "Products"] as const,
  ["categories", "Categories"] as const,
  ["collections", "Collections"] as const,
  ["pages", "Pages"] as const,
];

const PREVIEW_ENDPOINTS = [
  ["robots", "robots.txt", "/robots.txt"] as const,
  ["sitemap", "Sitemap index", "/sitemap.xml"] as const,
  ["feed", "Catalog feed XML", "/api/product-feed.xml"] as const,
];

export type SeoDiscoveryTone = "ok" | "warning" | "disabled" | "info";
export const SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS = [
  ["robots", "robots.txt", "/robots.txt"] as const,
  ["sitemap", "Sitemap index", "/sitemap.xml"] as const,
  [
    "productFeed",
    "Product feed",
    "/api/product-feed.xml?limit=5",
  ] as const,
  [
    "facebookFeed",
    "Facebook feed",
    "/api/facebook-feed.xml?limit=5",
  ] as const,
];
export type SeoDiscoveryLiveProbeKey =
  (typeof SEO_DISCOVERY_LIVE_PROBE_ENDPOINTS)[number][0];

export interface SeoDiscoveryLiveProbeCounts {
  robotsSitemapLines?: number;
  sitemapLocs?: number;
  feedItems?: number;
  imageLinks?: number;
  availabilityValues?: number;
}

export interface SeoDiscoveryLiveProbeResource {
  key: SeoDiscoveryLiveProbeKey;
  label: string;
  path: string;
  href: string | null;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  cacheControl: string | null;
  counts: SeoDiscoveryLiveProbeCounts;
  bodyTruncated?: boolean;
  error?: string;
}

export interface SeoDiscoveryLiveProbeResult {
  baseUrl: string | null;
  checkedAt: string;
  ok: boolean;
  error?: string;
  resources: SeoDiscoveryLiveProbeResource[];
}

export interface SeoDiscoveryStatusInput {
  discovery: unknown;
  robotsTxt?: string | null;
  storefrontUrl?: string | null;
}

export interface SeoDiscoveryStatus {
  sitemap: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    enabled: boolean;
    includedSections: Array<{
      key: keyof SeoDiscoverySettings["sitemap"];
      label: string;
      enabled: boolean;
    }>;
  };
  productFeed: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    enabled: boolean;
    includesUnavailableProducts: boolean;
    variantStrategy: SeoDiscoverySettings["feeds"]["variantStrategy"];
    variantStrategyLabel: string;
    feedTitle: string;
    feedDescription: string;
    imagePolicy: string;
  };
  robots: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    advertiseSitemap: boolean;
    customSitemapLines: string[];
    warning?: string;
  };
  structuredData: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    organizationEnabled: boolean;
    websiteSearchEnabled: boolean;
    productsEnabled: boolean;
    productGroupsEnabled: boolean;
    offerShippingDetailsEnabled: boolean;
    breadcrumbsEnabled: boolean;
    collectionsEnabled: boolean;
    organizationNote: string;
  };
  storefront: {
    tone: SeoDiscoveryTone;
    title: string;
    summary: string;
    mode: "absolute" | "path-only" | "unavailable";
    baseUrl: string | null;
    note: string;
    links: Array<{
      key: string;
      label: string;
      path: string;
      href: string | null;
    }>;
  };
}

function isPlaceholderSitemapValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "your-sitemap-url" ||
    normalized === "[your-sitemap-url]" ||
    (normalized.startsWith("[") && normalized.endsWith("]"))
  );
}

function findCustomSitemapLines(robotsTxt: string | null | undefined): string[] {
  if (!robotsTxt) return [];

  return robotsTxt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const match = line.match(/^sitemap:\s*(.*)$/i);
      if (!match) return false;
      return !isPlaceholderSitemapValue(match[1] ?? "");
    });
}

export function parseSeoDiscoveryStorefrontUrl(
  value: string | null | undefined,
): URL | null {
  if (!value) return null;

  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function buildSeoDiscoveryHref(baseUrl: URL, path: string): string {
  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl.href.slice(0, -1)
    : baseUrl.href;
  return `${normalizedBase}${path}`;
}

function getFeedVariantStrategyLabel(
  strategy: SeoDiscoverySettings["feeds"]["variantStrategy"],
): string {
  return strategy === "variants" ? "SKU / variant rows" : "Product rows";
}

function countXmlStartTags(xml: string, tagName: string): number {
  const pattern = new RegExp(
    `<\\s*(?!/)(?:[A-Za-z_][\\w.-]*:)?${tagName}\\b`,
    "gi",
  );
  return Array.from(xml.matchAll(pattern)).length;
}

function countRobotsSitemapLines(robotsTxt: string): number {
  return robotsTxt
    .split(/\r?\n/)
    .filter((line) => /^sitemap\s*:/i.test(line.trim())).length;
}

export function summarizeSeoDiscoveryProbeBody(
  key: SeoDiscoveryLiveProbeKey,
  body: string,
): SeoDiscoveryLiveProbeCounts {
  if (key === "robots") {
    return { robotsSitemapLines: countRobotsSitemapLines(body) };
  }

  if (key === "sitemap") {
    return { sitemapLocs: countXmlStartTags(body, "loc") };
  }

  return {
    feedItems: countXmlStartTags(body, "item"),
    imageLinks: countXmlStartTags(body, "image_link"),
    availabilityValues: countXmlStartTags(body, "availability"),
  };
}

export function buildSeoDiscoveryStatus({
  discovery,
  robotsTxt,
  storefrontUrl,
}: SeoDiscoveryStatusInput): SeoDiscoveryStatus {
  const normalized = normalizeSeoDiscoverySettings(discovery);
  const customSitemapLines = findCustomSitemapLines(robotsTxt);
  const absoluteStorefrontUrl = parseSeoDiscoveryStorefrontUrl(storefrontUrl);
  const trimmedStorefrontUrl = storefrontUrl?.trim() ?? "";
  const includedSections = SITEMAP_SECTIONS.map(([key, label]) => ({
    key,
    label,
    enabled: normalized.sitemap[key],
  }));
  const enabledSectionLabels = includedSections
    .filter((section) => section.enabled)
    .map((section) => section.label.toLowerCase());

  const storefrontMode = absoluteStorefrontUrl
    ? "absolute"
    : trimmedStorefrontUrl
      ? "path-only"
      : "unavailable";
  const feedVariantStrategyLabel = getFeedVariantStrategyLabel(
    normalized.feeds.variantStrategy,
  );

  return {
    sitemap: {
      tone: normalized.sitemap.enabled ? "ok" : "disabled",
      title: normalized.sitemap.enabled
        ? "Sitemap index on"
        : "Sitemap index off",
      summary: normalized.sitemap.enabled
        ? enabledSectionLabels.length > 0
          ? `Includes ${enabledSectionLabels.join(", ")}.`
          : "Index is enabled, but every section is turned off."
        : "Search engines will not receive the generated sitemap index.",
      enabled: normalized.sitemap.enabled,
      includedSections,
    },
    productFeed: {
      tone: normalized.feeds.productCatalogEnabled ? "ok" : "disabled",
      title: normalized.feeds.productCatalogEnabled
        ? "Product feed on"
        : "Product feed off",
      summary: normalized.feeds.productCatalogEnabled
        ? `${feedVariantStrategyLabel}; ${
            normalized.feeds.includeUnavailableProducts
              ? "sold-out catalog items are marked out of stock."
              : "only items currently available for sale are included."
          }`
        : "Catalog XML is not advertised for feed tools.",
      enabled: normalized.feeds.productCatalogEnabled,
      includesUnavailableProducts: normalized.feeds.includeUnavailableProducts,
      variantStrategy: normalized.feeds.variantStrategy,
      variantStrategyLabel: feedVariantStrategyLabel,
      feedTitle: normalized.feeds.title || "Product Catalog",
      feedDescription:
        normalized.feeds.description ||
        "Complete product catalog for feed tools.",
      imagePolicy:
        "Catalog items without an absolute http(s) primary image are skipped; rich-text descriptions are flattened to plain catalog text.",
    },
    robots: {
      tone: customSitemapLines.length > 0 ? "warning" : "info",
      title: normalized.robots.advertiseSitemap
        ? "robots.txt advertises canonical sitemap"
        : "robots.txt sitemap ad off",
      summary: normalized.robots.advertiseSitemap
        ? "Runtime strips saved Sitemap directives and advertises only the canonical current sitemap when the Store URL is absolute; otherwise it emits none."
        : "Runtime strips all Sitemap directives and advertises no sitemap.",
      advertiseSitemap: normalized.robots.advertiseSitemap,
      customSitemapLines,
      warning:
        customSitemapLines.length > 0
          ? "Saved custom Sitemap lines are ignored; runtime strips or replaces them with the canonical current sitemap."
          : undefined,
    },
    structuredData: {
      tone:
        normalized.structuredData.organization ||
        normalized.structuredData.websiteSearch ||
        normalized.structuredData.products ||
        normalized.structuredData.productGroups ||
        normalized.structuredData.offerShippingDetails ||
        normalized.structuredData.breadcrumbs ||
        normalized.structuredData.collections
          ? "ok"
          : "disabled",
      title:
        normalized.structuredData.organization ||
        normalized.structuredData.websiteSearch ||
        normalized.structuredData.products ||
        normalized.structuredData.productGroups ||
        normalized.structuredData.offerShippingDetails ||
        normalized.structuredData.breadcrumbs ||
        normalized.structuredData.collections
          ? "Structured data on"
          : "Structured data off",
      summary: [
        normalized.structuredData.organization
          ? "Organization"
          : "Organization off",
        normalized.structuredData.websiteSearch
          ? "site search"
          : "site search off",
        normalized.structuredData.products ? "products" : "products off",
        normalized.structuredData.productGroups
          ? "ProductGroup variants"
          : "ProductGroup variants off",
        normalized.structuredData.offerShippingDetails
          ? "shipping offers"
          : "shipping offers off",
        normalized.structuredData.breadcrumbs
          ? "breadcrumbs"
          : "breadcrumbs off",
        normalized.structuredData.collections
          ? "collections"
          : "collections off",
      ].join("; "),
      organizationEnabled: normalized.structuredData.organization,
      websiteSearchEnabled: normalized.structuredData.websiteSearch,
      productsEnabled: normalized.structuredData.products,
      productGroupsEnabled: normalized.structuredData.productGroups,
      offerShippingDetailsEnabled:
        normalized.structuredData.offerShippingDetails,
      breadcrumbsEnabled: normalized.structuredData.breadcrumbs,
      collectionsEnabled: normalized.structuredData.collections,
      organizationNote:
        "OnlineStore schema needs a logo; ProductGroup schema describes optioned products, and shipping schema uses active shipping methods.",
    },
    storefront: {
      tone: absoluteStorefrontUrl
        ? "ok"
        : storefrontMode === "path-only"
          ? "warning"
          : "info",
      title: absoluteStorefrontUrl
        ? "Dashboard Store URL preview"
        : storefrontMode === "path-only"
          ? "Path-only preview"
          : "Store URL unavailable",
      summary: absoluteStorefrontUrl
        ? "Preview links use the dashboard Store URL setting."
        : storefrontMode === "path-only"
          ? "Store URL is not an absolute http(s) URL, so links stay as paths."
          : "Store URL could not be loaded, so links stay unavailable.",
      mode: storefrontMode,
      baseUrl: absoluteStorefrontUrl?.href ?? null,
      note: "This is a dashboard preview, not a live probe of the storefront Worker env.",
      links: PREVIEW_ENDPOINTS.map(([key, label, path]) => ({
        key,
        label,
        path,
        href: absoluteStorefrontUrl
          ? buildSeoDiscoveryHref(absoluteStorefrontUrl, path)
          : null,
      })),
    },
  };
}
