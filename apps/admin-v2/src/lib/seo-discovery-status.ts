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
  ["feed", "Product feed", "/api/facebook-feed.xml"] as const,
];

export type SeoDiscoveryTone = "ok" | "warning" | "disabled" | "info";

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

function parseAbsoluteHttpUrl(value: string | null | undefined): URL | null {
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

function buildPreviewHref(baseUrl: URL, path: string): string {
  const normalizedBase = baseUrl.href.endsWith("/")
    ? baseUrl.href.slice(0, -1)
    : baseUrl.href;
  return `${normalizedBase}${path}`;
}

export function buildSeoDiscoveryStatus({
  discovery,
  robotsTxt,
  storefrontUrl,
}: SeoDiscoveryStatusInput): SeoDiscoveryStatus {
  const normalized = normalizeSeoDiscoverySettings(discovery);
  const customSitemapLines = findCustomSitemapLines(robotsTxt);
  const absoluteStorefrontUrl = parseAbsoluteHttpUrl(storefrontUrl);
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
        ? "Catalog XML can be used by product feed tools."
        : "Catalog XML is not advertised for feed tools.",
      enabled: normalized.feeds.productCatalogEnabled,
      imagePolicy:
        "Active products without an absolute http(s) primary image are skipped.",
    },
    robots: {
      tone: customSitemapLines.length > 0 ? "warning" : "info",
      title: normalized.robots.advertiseSitemap
        ? "robots.txt advertises sitemap"
        : "robots.txt sitemap ad off",
      summary: normalized.robots.advertiseSitemap
        ? "Runtime fills placeholder Sitemap lines when the storefront base URL is available."
        : "Runtime removes placeholder Sitemap lines but keeps custom Sitemap lines.",
      advertiseSitemap: normalized.robots.advertiseSitemap,
      customSitemapLines,
      warning:
        customSitemapLines.length > 0
          ? "Custom Sitemap lines are preserved; confirm they point to the right storefront."
          : undefined,
    },
    structuredData: {
      tone:
        normalized.structuredData.organization ||
        normalized.structuredData.websiteSearch
          ? "ok"
          : "disabled",
      title:
        normalized.structuredData.organization ||
        normalized.structuredData.websiteSearch
          ? "Global JSON-LD on"
          : "Global JSON-LD off",
      summary: [
        normalized.structuredData.organization
          ? "Organization"
          : "Organization off",
        normalized.structuredData.websiteSearch
          ? "site search"
          : "site search off",
      ].join("; "),
      organizationEnabled: normalized.structuredData.organization,
      websiteSearchEnabled: normalized.structuredData.websiteSearch,
      organizationNote:
        "Organization schema is emitted only when a logo is available.",
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
          ? buildPreviewHref(absoluteStorefrontUrl, path)
          : null,
      })),
    },
  };
}
