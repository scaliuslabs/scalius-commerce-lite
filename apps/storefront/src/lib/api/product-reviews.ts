// One page of a product's published reviews (GET /products/{id}/reviews):
// the "Show more" proxy (/api/reviews/<productId>) and the review page
// (/products/<slug>/reviews) read it. The public API caches it under the
// store's cache generation like every /products read. Review text is never
// logged; failures log the status only.
import { getApiV1ProductsByIdReviews } from "@scalius/api-client/sdk";
import { getConfiguredSdkClient, withEdgeCache, CACHE_TTL } from "./transport";
import { unwrapData } from "./unwrap";
import type { ProductReviews } from "./types";
import {
  REVIEW_PAGE_SIZE,
  readProductReviews,
  type ReviewListView,
} from "@/components/product/reviews/review-format";

export type ProductReviewsPageResult =
  | { state: "found"; data: ProductReviews }
  /** The product is not public, or the store's reviews are off. */
  | { state: "not_found" }
  | { state: "unavailable" };

const PRODUCT_ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function getProductReviewsPage(
  productId: string,
  view: ReviewListView & { cursor?: string | null; limit?: number },
): Promise<ProductReviewsPageResult> {
  if (!PRODUCT_ID.test(productId)) return { state: "not_found" };
  const limit = Math.min(Math.max(Math.trunc(view.limit ?? REVIEW_PAGE_SIZE), 1), 20);
  const query = {
    ...(view.sort !== "recent" ? { sort: view.sort } : {}),
    ...(view.rating ? { rating: view.rating } : {}),
    ...(view.cursor ? { cursor: view.cursor } : {}),
    limit,
  };
  const key = `product_reviews_${productId}_${view.sort}_${view.rating ?? "all"}_${view.cursor ?? "first"}_${limit}`;
  const result = await withEdgeCache<ProductReviewsPageResult>(
    key,
    async () => {
      try {
        const { data, error, response } = await getApiV1ProductsByIdReviews({
          client: getConfiguredSdkClient(),
          path: { id: productId },
          query,
        });
        if (response?.status === 404) return { state: "not_found" };
        if (error || (response && (response.status < 200 || response.status >= 300))) {
          console.error(`Error fetching reviews for product "${productId}" (status ${response?.status ?? "unknown"}).`);
          return null;
        }
        const reviews = readProductReviews(unwrapData<unknown>(data));
        return reviews ? { state: "found", data: reviews } : null;
      } catch (error: unknown) {
        console.error(`Error fetching reviews for product "${productId}":`, error instanceof Error ? error.name : "unknown");
        return null;
      }
    },
    { ttlSeconds: CACHE_TTL.AVAILABILITY },
  );
  return result ?? { state: "unavailable" };
}
