// Review facts for the product page's Product or ProductGroup JSON-LD (Wave B
// §2.4, invariant R4). They are built from the same `product.reviews` response
// the page renders, so the markup always matches what a buyer sees:
// `aggregateRating` is the summary (one decimal, best 5, worst 1), and
// `review[]` is exactly the published reviews shown on the page (at most
// five). Nothing is emitted when reviews are off or there is no published
// review. The page emits no product JSON-LD at all when it is noindex.
import type { Product } from "@/lib/api";
import {
  PRODUCT_PAGE_REVIEWS,
  formatReviewAverage,
  readProductReviews,
} from "@/components/product/reviews/review-format";

/** Fields merged into the root of the product's JSON-LD (Product or ProductGroup). */
export interface ReviewStructuredData {
  aggregateRating?: Record<string, unknown>;
  review?: Array<Record<string, unknown>>;
}

/** A calendar date for `datePublished` ("2026-09-25"); the API sends ISO timestamps. */
function isoDay(value: string): string | null {
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString().slice(0, 10) : null;
}

/**
 * AggregateRating and up to five Review items, only from published reviews
 * shown on the page and only when there is at least one. Null otherwise
 * (reviews off, no published review, a noindex product).
 */
export function reviewStructuredData(product: Pick<Product, "reviews" | "noIndex">): ReviewStructuredData | null {
  if (product.noIndex === true) return null;
  const reviews = readProductReviews(product.reviews);
  if (!reviews || reviews.summary.count < 1) return null;
  const shown = reviews.items.slice(0, PRODUCT_PAGE_REVIEWS);
  const review = shown.flatMap((item) => {
    const datePublished = isoDay(item.publishedAt);
    const author = item.authorName.trim();
    if (!datePublished || !author) return [];
    return [{
      "@type": "Review",
      author: { "@type": "Person", name: author },
      datePublished,
      ...(item.title ? { name: item.title } : {}),
      ...(item.body ? { reviewBody: item.body } : {}),
      reviewRating: {
        "@type": "Rating",
        ratingValue: item.rating,
        bestRating: 5,
        worstRating: 1,
      },
    }];
  });
  return {
    aggregateRating: {
      "@type": "AggregateRating",
      ratingValue: formatReviewAverage(reviews.summary.average),
      reviewCount: reviews.summary.count,
      bestRating: 5,
      worstRating: 1,
    },
    ...(review.length > 0 ? { review } : {}),
  };
}
