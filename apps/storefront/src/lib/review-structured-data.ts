// Owned by B2 (reviews storefront): review facts for the product page's Product/ProductGroup JSON-LD; nothing until B2 ships it.
import type { Product } from "@/lib/api";

/** Fields merged into the root of the product's JSON-LD (Product or ProductGroup). */
export interface ReviewStructuredData {
  aggregateRating?: Record<string, unknown>;
  review?: Array<Record<string, unknown>>;
}

/**
 * AggregateRating and up to five Review items, only from published reviews
 * shown on the page and only when there is at least one. The page already
 * emits no product JSON-LD when it is noindex.
 */
export function reviewStructuredData(_product: Product): ReviewStructuredData | null {
  return null;
}
