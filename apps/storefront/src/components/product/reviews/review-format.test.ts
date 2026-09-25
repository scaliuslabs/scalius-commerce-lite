import { describe, expect, it } from "vitest";
import { BANGLA_CHECKOUT_LANGUAGE_DATA, ENGLISH_CHECKOUT_LANGUAGE_DATA } from "@scalius/shared/checkout-language";
import {
  formatReviewAverage,
  pickReviewCopy,
  productReviewsPageHref,
  productReviewsProxyHref,
  publicReviewMarkup,
  readProductReviews,
  readReviewListView,
  reviewCountText,
  reviewHistogram,
  reviewStarFill,
} from "./review-format";

const copy = pickReviewCopy(ENGLISH_CHECKOUT_LANGUAGE_DATA);

describe("review numbers", () => {
  it("shows the average to one decimal and fills stars to the nearest half", () => {
    expect(formatReviewAverage(4.66)).toBe("4.7");
    expect(formatReviewAverage(4)).toBe("4.0");
    expect(formatReviewAverage(7)).toBe("5.0");
    expect(reviewStarFill(4.6)).toBe("90%");
    expect(reviewStarFill(4.24)).toBe("80%");
    expect(reviewStarFill(4.25)).toBe("90%");
    expect(reviewStarFill(0)).toBe("0%");
  });

  it("counts reviews in words, never \"1 reviews\"", () => {
    expect(reviewCountText(copy, 1)).toBe("1 review");
    expect(reviewCountText(copy, 128)).toBe("128 reviews");
    expect(reviewCountText(copy, 123456)).toBe("1,23,456 reviews");
    expect(reviewCountText(pickReviewCopy(BANGLA_CHECKOUT_LANGUAGE_DATA), 12)).toBe("12টি রিভিউ");
  });

  it("gives Amazon's five bars with whole percents, 5★ first", () => {
    const rows = reviewHistogram({
      average: 4.2,
      count: 7,
      histogram: [{ rating: 1, count: 1 }, { rating: 5, count: 4 }, { rating: 4, count: 2 }],
    });
    expect(rows).toEqual([
      { rating: 5, count: 4, percent: 57 },
      { rating: 4, count: 2, percent: 29 },
      { rating: 3, count: 0, percent: 0 },
      { rating: 2, count: 0, percent: 0 },
      { rating: 1, count: 1, percent: 14 },
    ]);
  });
});

describe("readProductReviews", () => {
  it("is null when reviews are off or the payload is unreadable", () => {
    expect(readProductReviews(null)).toBeNull();
    expect(readProductReviews({ items: [] })).toBeNull();
  });

  it("keeps the zero state (count 0) with no items and no cursor", () => {
    expect(readProductReviews({ summary: { average: 0, count: 0, histogram: [] }, items: [{ id: "x" }], nextCursor: "c" }))
      .toEqual({
        summary: { average: 0, count: 0, histogram: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: 0 })) },
        items: [],
        nextCursor: null,
      });
  });
});

describe("review URLs", () => {
  it("never carry review text: only a sort, a star and the opaque cursor", () => {
    expect(productReviewsPageHref("blue-shirt")).toBe("/products/blue-shirt/reviews");
    expect(productReviewsPageHref("blue-shirt", { sort: "highest", rating: 5, after: "ab+c/d" }))
      .toBe("/products/blue-shirt/reviews?rating=5&sort=highest&after=ab%2Bc%2Fd");
    expect(productReviewsProxyHref("prod_1", { sort: "recent", rating: null, cursor: "ab+c", limit: 10 }))
      .toBe("/api/reviews/prod_1?cursor=ab%2Bc&limit=10");
  });

  it("reads a view from the query and ignores anything else", () => {
    expect(readReviewListView(new URLSearchParams("sort=lowest&rating=2&after=abc"))).toEqual({ sort: "lowest", rating: 2, cursor: "abc" });
    expect(readReviewListView(new URLSearchParams("sort=best&rating=9&after=<x>"))).toEqual({ sort: "recent", rating: null, cursor: null });
  });
});

describe("publicReviewMarkup", () => {
  const review = {
    id: "rev_1",
    rating: 4,
    title: "<b>Good</b>",
    body: "Fits well.\n\nWashes <script>alert(1)</script> fine.",
    authorName: "Rahim K.",
    variantLabel: "Size: M",
    verifiedPurchase: true as const,
    publishedAt: "2026-09-12T08:00:00.000Z",
    editedAt: "2026-09-13T08:00:00.000Z",
    reply: { body: "Thank you!", repliedAt: "2026-09-14T08:00:00.000Z" },
  };

  it("shows the verified badge, the variant, Edited and the store's reply, all escaped", () => {
    const html = publicReviewMarkup(review, { copy, language: "en", storeName: "Dhaka Store" });
    expect(html).toContain("Verified purchase");
    expect(html).toContain("Size: M");
    expect(html).toContain("Edited");
    expect(html).toContain("Response from Dhaka Store");
    expect(html).toContain("12 September 2026");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>Good</b>");
    expect(html).toContain("&lt;b&gt;Good&lt;/b&gt;");
    expect(html.match(/<p>/g)).toHaveLength(3);
  });

  it("says \"Response from the store\" without a store name, and dates in Bangla", () => {
    const html = publicReviewMarkup(review, { copy: pickReviewCopy(BANGLA_CHECKOUT_LANGUAGE_DATA), language: "bn", storeName: null });
    expect(html).toContain("দোকানের উত্তর");
    expect(html).toContain("যাচাইকৃত ক্রয়");
  });
});
