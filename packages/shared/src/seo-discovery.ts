export interface SeoDiscoverySettings {
  sitemap: {
    enabled: boolean;
    products: boolean;
    categories: boolean;
    collections: boolean;
    pages: boolean;
  };
  feeds: {
    productCatalogEnabled: boolean;
  };
  robots: {
    advertiseSitemap: boolean;
  };
  structuredData: {
    organization: boolean;
    websiteSearch: boolean;
  };
}

export const DEFAULT_SEO_DISCOVERY_SETTINGS: SeoDiscoverySettings = {
  sitemap: {
    enabled: true,
    products: true,
    categories: true,
    collections: true,
    pages: true,
  },
  feeds: {
    productCatalogEnabled: true,
  },
  robots: {
    advertiseSitemap: true,
  },
  structuredData: {
    organization: true,
    websiteSearch: true,
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
    },
    feeds: {
      productCatalogEnabled: boolOrDefault(
        feeds.productCatalogEnabled,
        DEFAULT_SEO_DISCOVERY_SETTINGS.feeds.productCatalogEnabled,
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
