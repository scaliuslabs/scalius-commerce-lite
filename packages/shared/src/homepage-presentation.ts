export const MAX_HOMEPAGE_CATEGORY_IDS = 12;
export const MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH = 80;

export interface HomepageCategoryRailConfig {
  enabled: boolean;
  title: string;
  categoryIds: string[];
}

export interface HomepageTrustStripConfig {
  enabled: boolean;
}

/**
 * `catalog` is the usual homepage; `landing` opens the store on one
 * product's landing page (the BD F-commerce shape, SYNTHESIS §8.13). A
 * landing homepage whose product is not buyable renders the catalog homepage.
 */
export const HOMEPAGE_MODES = ["catalog", "landing"] as const;
export type HomepageMode = (typeof HOMEPAGE_MODES)[number];
export const MAX_HOMEPAGE_LANDING_PRODUCT_ID_LENGTH = 180;

export interface HomepagePresentationConfig {
  categoryRail: HomepageCategoryRailConfig;
  trustStrip: HomepageTrustStripConfig;
  homeMode: HomepageMode;
  /** The product a landing homepage shows; kept while the mode is `catalog`. */
  landingProductId: string | null;
}

export const DEFAULT_HOMEPAGE_PRESENTATION: HomepagePresentationConfig = {
  categoryRail: {
    enabled: false,
    title: "Shop by category",
    categoryIds: [],
  },
  trustStrip: {
    enabled: false,
  },
  homeMode: "catalog",
  landingProductId: null,
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanTitle(value: unknown): string {
  if (typeof value !== "string") {
    return DEFAULT_HOMEPAGE_PRESENTATION.categoryRail.title;
  }

  const title = value.trim().replace(/\s+/g, " ");
  return (title || DEFAULT_HOMEPAGE_PRESENTATION.categoryRail.title)
    .slice(0, MAX_HOMEPAGE_CATEGORY_RAIL_TITLE_LENGTH);
}

function cleanCategoryIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const categoryIds: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const id = candidate.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    categoryIds.push(id);
    if (categoryIds.length === MAX_HOMEPAGE_CATEGORY_IDS) break;
  }
  return categoryIds;
}

function cleanLandingProductId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  return id && id.length <= MAX_HOMEPAGE_LANDING_PRODUCT_ID_LENGTH ? id : null;
}

export function sanitizeHomepagePresentationConfig(
  value: unknown,
): HomepagePresentationConfig {
  const root = asRecord(value);
  const categoryRail = asRecord(root.categoryRail);
  const trustStrip = asRecord(root.trustStrip);
  const landingProductId = cleanLandingProductId(root.landingProductId);
  // Landing mode needs its product; without one the homepage is the catalog.
  const homeMode: HomepageMode = root.homeMode === "landing" && landingProductId ? "landing" : "catalog";

  return {
    categoryRail: {
      enabled: typeof categoryRail.enabled === "boolean"
        ? categoryRail.enabled
        : DEFAULT_HOMEPAGE_PRESENTATION.categoryRail.enabled,
      title: cleanTitle(categoryRail.title),
      categoryIds: cleanCategoryIds(categoryRail.categoryIds),
    },
    trustStrip: {
      enabled: typeof trustStrip.enabled === "boolean"
        ? trustStrip.enabled
        : DEFAULT_HOMEPAGE_PRESENTATION.trustStrip.enabled,
    },
    homeMode,
    landingProductId,
  };
}

export function parseHomepagePresentationConfig(
  value: string | null | undefined,
): HomepagePresentationConfig {
  if (!value) return sanitizeHomepagePresentationConfig(null);
  try {
    return sanitizeHomepagePresentationConfig(JSON.parse(value));
  } catch {
    return sanitizeHomepagePresentationConfig(null);
  }
}
