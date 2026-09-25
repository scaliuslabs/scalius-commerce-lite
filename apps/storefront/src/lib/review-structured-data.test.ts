// R4 (Wave B §2.7): the product's review JSON-LD comes only from published,
// visible reviews, matches the visible summary (count and average), and is
// left out for a noindex product, at zero reviews and when reviews are off.
import { describe, expect, it } from "vitest";
import type { ProductReviews } from "@/lib/api";
import { reviewStructuredData } from "./review-structured-data";
import { formatReviewAverage, readProductReviews } from "@/components/product/reviews/review-format";

const review = (index: number, overrides: Partial<ProductReviews["items"][number]> = {}): ProductReviews["items"][number] => ({
  id: `rev_${index}`,
  rating: 5 - (index % 3),
  title: index === 0 ? "Great <fit>" : null,
  body: index === 1 ? null : `Body ${index}`,
  authorName: `Buyer ${index}`,
  variantLabel: index === 0 ? "Size: M" : null,
  verifiedPurchase: true,
  publishedAt: `2026-09-${String(20 - index).padStart(2, "0")}T10:15:00.000Z`,
  editedAt: null,
  reply: null,
  ...overrides,
});

const reviews = (count: number, items = 5): ProductReviews => ({
  summary: {
    average: 4.66,
    count,
    histogram: [
      { rating: 5, count: count - 2 },
      { rating: 4, count: 1 },
      { rating: 3, count: 1 },
      { rating: 2, count: 0 },
      { rating: 1, count: 0 },
    ],
  },
  items: Array.from({ length: items }, (_, index) => review(index)),
  nextCursor: count > items ? "cursor" : null,
});

describe("reviewStructuredData (R4)", () => {
  it("describes the summary and exactly the reviews the page shows", () => {
    const product = { reviews: reviews(128, 5), noIndex: false };
    const data = reviewStructuredData(product);
    expect(data?.aggregateRating).toEqual({
      "@type": "AggregateRating",
      ratingValue: "4.7",
      reviewCount: 128,
      bestRating: 5,
      worstRating: 1,
    });
    // The visible summary reads the same response through the same helper.
    const visible = readProductReviews(product.reviews)!;
    expect(data?.aggregateRating?.ratingValue).toBe(formatReviewAverage(visible.summary.average));
    expect(data?.aggregateRating?.reviewCount).toBe(visible.summary.count);
    expect(data?.review?.map((entry) => (entry.author as { name: string }).name)).toEqual(visible.items.map((item) => item.authorName));
    expect(data?.review?.[0]).toEqual({
      "@type": "Review",
      author: { "@type": "Person", name: "Buyer 0" },
      datePublished: "2026-09-20",
      name: "Great <fit>",
      reviewBody: "Body 0",
      reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 },
    });
    // A review without text has no reviewBody (never an empty string).
    expect(data?.review?.[1]).not.toHaveProperty("reviewBody");
  });

  it("never describes more than the five reviews rendered on the page", () => {
    const data = reviewStructuredData({ reviews: reviews(40, 8), noIndex: false });
    expect(data?.review).toHaveLength(5);
  });

  it("is left out for a noindex product, at zero reviews and when reviews are off", () => {
    expect(reviewStructuredData({ reviews: reviews(128), noIndex: true })).toBeNull();
    expect(reviewStructuredData({ reviews: { ...reviews(0, 0), summary: { average: 0, count: 0, histogram: [] } }, noIndex: false })).toBeNull();
    expect(reviewStructuredData({ reviews: null, noIndex: false })).toBeNull();
    expect(reviewStructuredData({ noIndex: false })).toBeNull();
  });

  it("drops malformed reviews instead of guessing (no author, no date, rating out of range)", () => {
    const product = {
      noIndex: false,
      reviews: {
        ...reviews(3, 0),
        items: [
          review(0, { authorName: "" }),
          review(1, { publishedAt: "not a date" }),
          review(2, { rating: 9 }),
          review(3),
        ],
      },
    };
    expect(reviewStructuredData(product)?.review?.map((entry) => (entry.author as { name: string }).name)).toEqual(["Buyer 3"]);
  });

  it("keeps the aggregate when no review on the page can be described", () => {
    const data = reviewStructuredData({ reviews: { ...reviews(2, 0), summary: { average: 5, count: 2, histogram: [{ rating: 5, count: 2 }] } }, noIndex: false });
    expect(data).toEqual({
      aggregateRating: { "@type": "AggregateRating", ratingValue: "5.0", reviewCount: 2, bestRating: 5, worstRating: 1 },
    });
  });
});
