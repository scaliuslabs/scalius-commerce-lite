// The public review reads (Wave B §2.4, §7.1): the product page's `reviews`
// field and the keyset list, only from published reviews, with the summary
// from the stats projection, and the product page's warranty field.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewsDocument } from "../settings/documents";
import { moderateReviews, submitReview } from "../reviews";
import { createReviewStore, type ReviewStore } from "../reviews/testing/fixture";
import { getPublicProductReviews, getStorefrontProductBySlug } from "./index";

describe("public product reviews", () => {
  let store: ReviewStore;

  beforeEach(() => {
    store = createReviewStore();
  });
  afterEach(() => store.close());

  /** `count` published reviews of the shirt with the given ratings, oldest first, one second apart. */
  async function publishedShirtReviews(ratings: number[]) {
    const ids: string[] = [];
    for (const [index, rating] of ratings.entries()) {
      store.deliveredOrder(`ord_${index}`, [{ item: `item_${index}`, product: "prod_shirt" }], { account: null, customer: null, name: `Buyer ${index}` });
      const { review } = await submitReview(store.db, { kind: "guest_receipt", orderId: `ord_${index}` }, {
        orderItemId: `item_${index}`,
        rating,
        title: `Review ${index}`,
      });
      store.sqlite.prepare("UPDATE product_reviews SET published_at = ? WHERE id = ?").run(1_790_000_000 + index, review.id);
      ids.push(review.id);
    }
    return ids;
  }

  it("puts the summary and the five most recent published reviews on the product page", async () => {
    await publishedShirtReviews([5, 4, 3, 5, 1, 2, 5]);
    const page = await getStorefrontProductBySlug(store.db, "linen-shirt");
    const reviews = page!.product.reviews!;
    expect(reviews.summary).toEqual({
      average: 3.57,
      count: 7,
      histogram: [
        { rating: 5, count: 3 },
        { rating: 4, count: 1 },
        { rating: 3, count: 1 },
        { rating: 2, count: 1 },
        { rating: 1, count: 1 },
      ],
    });
    expect(reviews.items.map((item) => item.title)).toEqual(["Review 6", "Review 5", "Review 4", "Review 3", "Review 2"]);
    expect(reviews.items[0]).toMatchObject({ verifiedPurchase: true, variantLabel: "Size M", reply: null, editedAt: null });
    expect(reviews.items[0]).not.toHaveProperty("orderId");
    expect(reviews.nextCursor).not.toBeNull();

    const next = await getPublicProductReviews(store.db, "prod_shirt", { cursor: reviews.nextCursor });
    expect(next?.items.map((item) => item.title)).toEqual(["Review 1", "Review 0"]);
    expect(next?.nextCursor).toBeNull();
  });

  it("pages highest and lowest first, and filters by stars, without repeats", async () => {
    await publishedShirtReviews([5, 4, 3, 5, 1, 2, 5, 4]);
    const collect = async (sort: "highest" | "lowest", rating?: number) => {
      const seen: Array<{ title: string | null; rating: number }> = [];
      let cursor: string | null = null;
      do {
        const page = await getPublicProductReviews(store.db, "prod_shirt", { sort, rating, cursor, limit: 3 });
        seen.push(...page!.items.map((item) => ({ title: item.title, rating: item.rating })));
        cursor = page!.nextCursor;
      } while (cursor);
      return seen;
    };
    const highest = await collect("highest");
    expect(highest.map((row) => row.rating)).toEqual([5, 5, 5, 4, 4, 3, 2, 1]);
    expect(highest.slice(0, 3).map((row) => row.title)).toEqual(["Review 6", "Review 3", "Review 0"]);
    expect((await collect("lowest")).map((row) => row.rating)).toEqual([1, 2, 3, 4, 4, 5, 5, 5]);
    expect((await collect("highest", 4)).map((row) => row.title)).toEqual(["Review 7", "Review 1"]);
  });

  it("shows only published reviews, the zero state at no reviews, and nothing while reviews are off", async () => {
    const empty = await getStorefrontProductBySlug(store.db, "clay-mug");
    expect(empty!.product.reviews).toEqual({
      summary: { average: 0, count: 0, histogram: [5, 4, 3, 2, 1].map((rating) => ({ rating, count: 0 })) },
      items: [],
      nextCursor: null,
    });
    const [first] = await publishedShirtReviews([4]);
    await moderateReviews(store.db, { ids: [first!], action: "reject", reason: "spam" });
    const rejected = await getPublicProductReviews(store.db, "prod_shirt");
    expect(rejected).toMatchObject({ summary: { count: 0 }, items: [] });

    await reviewsDocument.write(store.db, { enabled: false });
    expect((await getStorefrontProductBySlug(store.db, "linen-shirt"))!.product.reviews).toBeNull();
    expect(await getPublicProductReviews(store.db, "prod_shirt")).toBeNull();
  });

  it("puts the product's live warranty policy on the product page", async () => {
    expect((await getStorefrontProductBySlug(store.db, "linen-shirt"))!.product.warranty).toBeNull();
    store.sqlite.exec(`
      INSERT INTO warranty_policies (id, name, provider, duration_value, duration_unit, replacement_days, terms, current_revision_id)
        VALUES ('wrp_brand0000001', '1-year brand warranty', 'brand', 1, 'years', 7, 'Keep the box.', 'wrr_brand0000001');
      UPDATE products SET warranty_policy_id = 'wrp_brand0000001' WHERE id = 'prod_shirt';
    `);
    expect((await getStorefrontProductBySlug(store.db, "linen-shirt"))!.product.warranty).toEqual({
      name: "1-year brand warranty",
      provider: "brand",
      duration: { value: 1, unit: "years" },
      replacementDays: 7,
      terms: "Keep the box.",
    });
    store.sqlite.exec("UPDATE warranty_policies SET archived_at = unixepoch() WHERE id = 'wrp_brand0000001'");
    expect((await getStorefrontProductBySlug(store.db, "linen-shirt"))!.product.warranty).toBeNull();
  });
});
