import type { ProductRecommendationReason, ProductRecommendations } from "@/lib/api/types";
import { browserApiUrl } from "@/lib/api/browser-url";
import { pageLanguage } from "@/lib/store-time-zone";

const TITLES = {
  en: { also_bought: "Customers also bought", popular: "Popular right now", new_arrivals: "New arrivals", similar: "You might also like" },
  bn: { also_bought: "ক্রেতারা এগুলোও কিনেছেন", popular: "এখন জনপ্রিয়", new_arrivals: "নতুন এসেছে", similar: "আপনার পছন্দ হতে পারে" },
} as const;

/**
 * One honest title per kind of recommendation list: "Customers also bought"
 * only when the API says the list is mostly real co-purchase data. In the
 * page's language (Bangla on a Bangla page).
 */
export function recommendationTitle(reason: ProductRecommendationReason, language: string = pageLanguage()): string {
  const titles = language.toLowerCase().startsWith("bn") ? TITLES.bn : TITLES.en;
  switch (reason) {
    case "also_bought":
      return titles.also_bought;
    case "popular":
      return titles.popular;
    case "new_arrivals":
      return titles.new_arrivals;
    default:
      return titles.similar;
  }
}

/** Most source ids a storefront surface sends (the API uses at most 20). */
export const RECOMMENDATION_SOURCE_ID_LIMIT = 10;

/**
 * Sorted, de-duplicated source ids, so every surface showing the same items
 * (cart drawer, order confirmation) shares one API cache entry.
 */
export function recommendationSourceIds(productIds: readonly string[]): string[] {
  return Array.from(new Set(productIds.map((id) => id.trim()).filter(Boolean)))
    .sort()
    .slice(0, RECOMMENDATION_SOURCE_ID_LIMIT);
}

const REASONS = new Set<string>(["also_bought", "similar", "popular", "new_arrivals"]);

export function isProductRecommendations(value: unknown): value is ProductRecommendations {
  const candidate = value as Partial<ProductRecommendations> | null;
  return Boolean(
    candidate &&
      typeof candidate === "object" &&
      typeof candidate.reason === "string" &&
      REASONS.has(candidate.reason) &&
      Array.isArray(candidate.products),
  );
}

/** Query string for the public recommendations endpoint (product ids are not personal data). */
export function recommendationQuery(productIds: readonly string[], limit: number): string {
  const params = new URLSearchParams();
  const sourceIds = recommendationSourceIds(productIds);
  if (sourceIds.length > 0) params.set("productIds", sourceIds.join(","));
  params.set("limit", String(limit));
  return params.toString();
}

/**
 * Browser read for the cart drawer. A plain cookie-less GET, so the API's
 * public cache serves it; failures just leave the row out.
 */
export async function fetchRecommendationsFromBrowser(
  productIds: readonly string[],
  limit: number,
  signal?: AbortSignal,
): Promise<ProductRecommendations | null> {
  try {
    const response = await fetch(
      browserApiUrl(`/products/recommendations?${recommendationQuery(productIds, limit)}`),
      { headers: { Accept: "application/json" }, signal },
    );
    if (!response.ok) return null;
    const json = (await response.json().catch(() => null)) as { data?: unknown } | null;
    return isProductRecommendations(json?.data) ? json.data : null;
  } catch {
    return null;
  }
}
