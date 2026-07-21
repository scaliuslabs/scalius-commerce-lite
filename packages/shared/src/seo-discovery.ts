export type SeoFeedVariantStrategy = "products" | "variants";

export interface SeoDiscoverySettings {
  sitemap: {
    enabled: boolean;
    staticPages: boolean;
    products: boolean;
    categories: boolean;
    collections: boolean;
    pages: boolean;
    articles: boolean;
  };
  feeds: {
    productCatalogEnabled: boolean;
    includeUnavailableProducts: boolean;
    variantStrategy: SeoFeedVariantStrategy;
    title: string;
    description: string;
  };
  robots: {
    advertiseSitemap: boolean;
  };
  structuredData: {
    organization: boolean;
    websiteSearch: boolean;
    products: boolean;
    productGroups: boolean;
    offerShippingDetails: boolean;
    breadcrumbs: boolean;
    collections: boolean;
    articles: boolean;
  };
}

export const DEFAULT_SEO_DISCOVERY_SETTINGS: SeoDiscoverySettings = {
  sitemap: {
    enabled: true,
    staticPages: true,
    products: true,
    categories: true,
    collections: true,
    pages: true,
    articles: true,
  },
  feeds: {
    productCatalogEnabled: true,
    includeUnavailableProducts: true,
    variantStrategy: "variants",
    title: "",
    description: "",
  },
  robots: {
    advertiseSitemap: true,
  },
  structuredData: {
    organization: true,
    websiteSearch: true,
    products: true,
    productGroups: true,
    offerShippingDetails: true,
    breadcrumbs: true,
    collections: true,
    articles: true,
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boolOrDefault(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function stringOrDefault(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function feedVariantStrategyOrDefault(
  value: unknown,
  fallback: SeoFeedVariantStrategy,
): SeoFeedVariantStrategy {
  return value === "products" || value === "variants" ? value : fallback;
}

export function normalizeSeoDiscoverySettings(
  value: unknown,
): SeoDiscoverySettings {
  const root = asRecord(value);
  const sitemap = asRecord(root.sitemap);
  const feeds = asRecord(root.feeds);
  const robots = asRecord(root.robots);
  const structuredData = asRecord(root.structuredData);

  return {
    sitemap: {
      enabled: boolOrDefault(
        sitemap.enabled,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.enabled,
      ),
      products: boolOrDefault(
        sitemap.products,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.products,
      ),
      staticPages: boolOrDefault(
        sitemap.staticPages,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.staticPages,
      ),
      categories: boolOrDefault(
        sitemap.categories,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.categories,
      ),
      collections: boolOrDefault(
        sitemap.collections,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.collections,
      ),
      pages: boolOrDefault(
        sitemap.pages,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.pages,
      ),
      articles: boolOrDefault(
        sitemap.articles,
        DEFAULT_SEO_DISCOVERY_SETTINGS.sitemap.articles,
      ),
    },
    feeds: {
      productCatalogEnabled: boolOrDefault(
        feeds.productCatalogEnabled,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.productCatalogEnabled,
      ),
      includeUnavailableProducts: boolOrDefault(
        feeds.includeUnavailableProducts,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.includeUnavailableProducts,
      ),
      variantStrategy: feedVariantStrategyOrDefault(
        feeds.variantStrategy,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.variantStrategy,
      ),
      title: stringOrDefault(
        feeds.title,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.title,
      ),
      description: stringOrDefault(
        feeds.description,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.description,
      ),
    },
    robots: {
      advertiseSitemap: boolOrDefault(
        robots.advertiseSitemap,
        DEFAULT_SEO_DISCOVERY_SETTINGS.robots.advertiseSitemap,
      ),
    },
    structuredData: {
      organization: boolOrDefault(
        structuredData.organization,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.organization,
      ),
      websiteSearch: boolOrDefault(
        structuredData.websiteSearch,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.websiteSearch,
      ),
      products: boolOrDefault(
        structuredData.products,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.products,
      ),
      productGroups: boolOrDefault(
        structuredData.productGroups,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.productGroups,
      ),
      offerShippingDetails: boolOrDefault(
        structuredData.offerShippingDetails,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.offerShippingDetails,
      ),
      breadcrumbs: boolOrDefault(
        structuredData.breadcrumbs,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.breadcrumbs,
      ),
      collections: boolOrDefault(
        structuredData.collections,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.collections,
      ),
      articles: boolOrDefault(
        structuredData.articles,
        DEFAULT_SEO_DISCOVERY_SETTINGS.structuredData.articles,
      ),
    },
  };
}

export function mergeSeoDiscoverySettings(
  base: unknown,
  patch: unknown,
): SeoDiscoverySettings {
  const normalizedBase = normalizeSeoDiscoverySettings(base);
  const patchRoot = asRecord(patch);
  const patchSitemap = asRecord(patchRoot.sitemap);
  const patchFeeds = asRecord(patchRoot.feeds);
  const patchRobots = asRecord(patchRoot.robots);
  const patchStructuredData = asRecord(patchRoot.structuredData);

  return normalizeSeoDiscoverySettings({
    sitemap: {
      ...normalizedBase.sitemap,
      ...patchSitemap,
    },
    feeds: {
      ...normalizedBase.feeds,
      ...patchFeeds,
    },
    robots: {
      ...normalizedBase.robots,
      ...patchRobots,
    },
    structuredData: {
      ...normalizedBase.structuredData,
      ...patchStructuredData,
    },
  });
}

export function parseSeoDiscoverySettings(
  value: string | null | undefined,
): SeoDiscoverySettings {
  if (!value) return DEFAULT_SEO_DISCOVERY_SETTINGS;

  try {
    return normalizeSeoDiscoverySettings(JSON.parse(value));
  } catch {
    return DEFAULT_SEO_DISCOVERY_SETTINGS;
  }
}
