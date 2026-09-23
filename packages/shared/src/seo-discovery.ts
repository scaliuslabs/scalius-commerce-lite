export type SeoFeedVariantStrategy = "products" | "variants";

export interface SeoDiscoverySettings {
  feeds: {
    productCatalogEnabled: boolean;
    includeUnavailableProducts: boolean;
    variantStrategy: SeoFeedVariantStrategy;
    title: string;
    description: string;
  };
}

export const DEFAULT_SEO_DISCOVERY_SETTINGS: SeoDiscoverySettings = {
  feeds: {
    productCatalogEnabled: true,
    includeUnavailableProducts: true,
    variantStrategy: "variants",
    title: "",
    description: "",
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
  const feeds = asRecord(asRecord(value).feeds);
  const defaults = DEFAULT_SEO_DISCOVERY_SETTINGS.feeds;

  return {
    feeds: {
      productCatalogEnabled: boolOrDefault(
        feeds.productCatalogEnabled,
        defaults.productCatalogEnabled,
      ),
      includeUnavailableProducts: boolOrDefault(
        feeds.includeUnavailableProducts,
        defaults.includeUnavailableProducts,
      ),
      variantStrategy: feedVariantStrategyOrDefault(
        feeds.variantStrategy,
        defaults.variantStrategy,
      ),
      title: stringOrDefault(feeds.title, defaults.title),
      description: stringOrDefault(feeds.description, defaults.description),
    },
  };
}

export function mergeSeoDiscoverySettings(
  base: unknown,
  patch: unknown,
): SeoDiscoverySettings {
  return normalizeSeoDiscoverySettings({
    feeds: {
      ...normalizeSeoDiscoverySettings(base).feeds,
      ...asRecord(asRecord(patch).feeds),
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
