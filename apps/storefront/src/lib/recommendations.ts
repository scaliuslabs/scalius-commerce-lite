import type { ProductRecommendationReason, ProductRecommendations } from "@/lib/api/types";
import { browserApiUrl } from "@/lib/api/browser-url";

/**
 * One honest title per kind of recommendation list: "Customers also bought"
 * only when the API says the list is mostly real co-purchase data.
 */
export function recommendationTitle(reason: ProductRecommendationReason): string {
  switch (reason) {
    case "also_bought":
      return "Customers also bought";
    case "popular":
      return "Popular right now";
    case "new_arrivals":
      return "New arrivals";
    default:
      return "You might also like";
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
