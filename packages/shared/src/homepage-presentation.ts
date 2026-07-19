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

export interface HomepagePresentationConfig {
  categoryRail: HomepageCategoryRailConfig;
  trustStrip: HomepageTrustStripConfig;
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

export function sanitizeHomepagePresentationConfig(
  value: unknown,
): HomepagePresentationConfig {
  const root = asRecord(value);
  const categoryRail = asRecord(root.categoryRail);
  const trustStrip = asRecord(root.trustStrip);

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
