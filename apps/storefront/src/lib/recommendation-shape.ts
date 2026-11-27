import type { ProductRecommendations } from "@/lib/api/types";

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
