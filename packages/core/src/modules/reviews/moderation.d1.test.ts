import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewsDocument } from "../settings/documents";
import {
  editReview,
  getAdminReviewSummary,
  listAdminReviews,
  moderateReviews,
  openReviewThread,
  saveReviewSettings,
  setReviewReply,
  submitReview,
  withdrawReview,
  type ReviewBuyer,
} from "./index";
import { createReviewStore, type ReviewStore } from "./testing/fixture";

const rahim: ReviewBuyer = { kind: "customer", customerId: "acct_rahim" };

describe("staff moderation, replies and threads", () => {
  let store: ReviewStore;

  beforeEach(() => {
    store = createReviewStore();
  });
  afterEach(() => store.close());

  async function pendingReviews(count: number) {
    await reviewsDocument.write(store.db, { moderation: "hold" });
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const product = index % 2 === 0 ? "prod_shirt" : "prod_mug";
      store.deliveredOrder(`ord_${index}`, [{ item: `item_${index}`, product }], { account: null, customer: null, name: `Buyer ${index}` });
      const result = await submitReview(store.db, { kind: "guest_receipt", orderId: `ord_${index}` }, {
        orderItemId: `item_${index}`,
        rating: 1 + (index % 5),
      });
      ids.push(result.review.id);
    }
    return ids;
  }

  it("publishes, rejects with a content reason and restores; a repeat skips what already moved", async () => {
    const [a, b, c] = await pendingReviews(3);
    await expect(moderateReviews(store.db, { ids: [a!], action: "reject" })).rejects.toMatchObject({ status: 400 });
    await expect(moderateReviews(store.db, { ids: [a!], action: "reject", reason: "low_rating" })).rejects.toMatchObject({ status: 400 });

    const published = await moderateReviews(store.db, { ids: [a!, b!, "rev_missing000000"], action: "publish" });
    expect(published).toEqual({
      updated: [{ id: a, previousStatus: "pending" }, { id: b, previousStatus: "pending" }],
      skipped: ["rev_missing000000"],
      publicChange: true,
    });
    expect((await moderateReviews(store.db, { ids: [a!], action: "publish" })).updated).toEqual([]);

    const rejected = await moderateReviews(store.db, { ids: [a!, c!], action: "reject", reason: "spam" });
    expect(rejected.updated.map((row) => row.previousStatus).sort()).toEqual(["pending", "published"]);
    expect(store.rows("SELECT id, status, moderation_reason FROM product_reviews WHERE id IN (?, ?) ORDER BY id", a!, c!)
      .every((row) => row.status === "rejected" && row.moderation_reason === "spam")).toBe(true);

    const restored = await moderateReviews(store.db, { ids: [a!], action: "restore" });
    expect(restored.updated).toEqual([{ id: a, previousStatus: "rejected" }]);
    expect(store.rows("SELECT status, moderation_reason FROM product_reviews WHERE id = ?", a!))
      .toEqual([{ status: "published", moderation_reason: null }]);
    await expect(moderateReviews(store.db, { ids: Array.from({ length: 91 }, (_, i) => `rev_${i}`), action: "publish" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("R3: the stats projection equals the published reviews through every service write", async () => {
    const ids = await pendingReviews(12);
    await moderateReviews(store.db, { ids: ids.slice(0, 9), action: "publish" });
    await moderateReviews(store.db, { ids: ids.slice(0, 3), action: "reject", reason: "off_topic" });
    await moderateReviews(store.db, { ids: [ids[1]!], action: "restore" });
    await reviewsDocument.write(store.db, { moderation: "auto" });
    // A buyer edit of a published review (rating change) and a withdrawal.
    const buyer = { kind: "guest_receipt", orderId: "ord_4" } as const;
    const version = Number(store.scalar("SELECT version FROM product_reviews WHERE id = ?", ids[4]!));
    const edited = await editReview(store.db, buyer, ids[4]!, { version, rating: 5 });
    await withdrawReview(store.db, buyer, ids[4]!, { version: edited.review.version });

    for (const product of ["prod_shirt", "prod_mug"]) {
      const expected = store.expectedStats(product);
      const stats = store.rows(`SELECT review_count, rating_sum,
          count_1 + count_2 + count_3 + count_4 + count_5 AS histogram_total,
          rating_avg_centi, rating_rank_milli
        FROM product_review_stats WHERE product_id = ?`, product)[0]!;
      expect(stats.review_count).toBe(expected.review_count);
      expect(stats.rating_sum).toBe(expected.rating_sum);
      expect(stats.histogram_total).toBe(expected.review_count);
      expect(stats.rating_avg_centi).toBe(expected.review_count === 0 ? null : Math.floor((expected.rating_sum * 100) / expected.review_count));
    }
    const summary = await getAdminReviewSummary(store.db, { productId: "prod_shirt" });
    expect(summary.product?.count).toBe(store.expectedStats("prod_shirt").review_count);
  });

  it("sets and removes the public reply with the review's version, and staff never change buyer text", async () => {
    const [id] = await pendingReviews(1);
    const before = store.rows("SELECT rating, title, body, author_display_name FROM product_reviews WHERE id = ?", id!);
    const replied = await setReviewReply(store.db, { reviewId: id!, body: "  Thanks for the honest review! ", version: 1, userId: "staff_1" });
    expect(replied.review.reply).toMatchObject({ body: "Thanks for the honest review!", authorName: "Nadia" });
    expect(replied.publicChange).toBe(false); // still pending
    await expect(setReviewReply(store.db, { reviewId: id!, body: "Again", version: 1, userId: "staff_1" })).rejects.toMatchObject({ status: 409 });
    await expect(setReviewReply(store.db, { reviewId: "rev_missing000000", body: "x", version: 1, userId: "staff_1" })).rejects.toMatchObject({ status: 404 });
    const removed = await setReviewReply(store.db, { reviewId: id!, body: null, version: replied.review.version, userId: "staff_1" });
    expect(removed.review.reply).toBeNull();
    expect(store.rows("SELECT rating, title, body, author_display_name FROM product_reviews WHERE id = ?", id!)).toEqual(before);
  });

  it("opens one review thread on the review's order, reused on repeat", async () => {
    const [id] = await pendingReviews(1);
    const first = await openReviewThread(store.db, id!);
    const again = await openReviewThread(store.db, id!);
    expect(again).toEqual(first);
    expect(store.rows("SELECT subject_type, subject_id, order_id, customer_id FROM conversations")).toEqual([
      { subject_type: "review", subject_id: id, order_id: "ord_0", customer_id: null },
    ]);
    const listed = await listAdminReviews(store.db, {});
    expect(listed.items[0]?.conversationId).toBe(first.conversationId);
  });

  it("lists the queue by status, rating, product and text, newest first with a keyset cursor", async () => {
    await pendingReviews(30);
    const firstPage = await listAdminReviews(store.db, { status: "pending" });
    expect(firstPage.items).toHaveLength(25);
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await listAdminReviews(store.db, { status: "pending", cursor: firstPage.nextCursor });
    expect(secondPage.items).toHaveLength(5);
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)).size).toBe(30);
    expect((await listAdminReviews(store.db, { rating: 5 })).items.every((item) => item.rating === 5)).toBe(true);
    expect((await listAdminReviews(store.db, { productId: "prod_mug" })).items.every((item) => item.product.id === "prod_mug")).toBe(true);
    expect((await listAdminReviews(store.db, { q: "Buyer 7" })).items.map((item) => item.authorName)).toEqual(["Buyer 7."]);
    expect((await listAdminReviews(store.db, { q: "100%" })).items).toEqual([]);
    expect(await getAdminReviewSummary(store.db)).toMatchObject({ pending: 30, published: 0, rejected: 0, product: null });
  });

  it("saves settings against the loaded revision and cleans block words", async () => {
    const saved = await saveReviewSettings(store.db, { blockWords: ["  Spam ", "spam", "ফালতু", ""] }, 0);
    expect(saved).toMatchObject({ enabled: true, moderation: "auto", requestsEnabled: true, requestDelayDays: 7, blockWords: ["spam", "ফালতু"], revision: 1 });
    await expect(saveReviewSettings(store.db, { moderation: "hold" }, 0)).rejects.toThrow();
  });
});
