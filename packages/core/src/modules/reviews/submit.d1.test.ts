import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewsDocument } from "../settings/documents";
import {
  countReviewableLinesForCustomer,
  editReview,
  listBuyerReviews,
  listLineReviewStates,
  listReviewableLines,
  submitReview,
  withdrawReview,
  type ReviewBuyer,
} from "./index";
import { createReviewStore, type ReviewStore } from "./testing/fixture";

const rahim: ReviewBuyer = { kind: "customer", customerId: "acct_rahim" };
const karim: ReviewBuyer = { kind: "customer", customerId: "acct_karim" };

describe("buyer reviews: only delivered lines (R1), uniqueness (R2), access (R7), rating-blind moderation (R5)", () => {
  let store: ReviewStore;

  beforeEach(() => {
    store = createReviewStore();
  });
  afterEach(() => store.close());

  it("refuses lines that are not handed over on a delivered order, and gift-card lines", async () => {
    store.order("ord_1", [{ item: "item_shirt", product: "prod_shirt" }, { item: "item_card", product: "prod_card", type: "gift_card" }]);
    await expect(submitReview(store.db, rahim, { orderItemId: "item_shirt", rating: 5 }))
      .rejects.toMatchObject({ status: 409, code: "REVIEW_NOT_ELIGIBLE" });
    store.fulfil("ord_1", "item_shirt");
    await expect(submitReview(store.db, rahim, { orderItemId: "item_shirt", rating: 5 }))
      .rejects.toMatchObject({ code: "REVIEW_NOT_ELIGIBLE" }); // handed over, order not delivered yet
    store.fulfil("ord_1", "item_card");
    store.deliver("ord_1");
    await expect(submitReview(store.db, rahim, { orderItemId: "item_card", rating: 5 }))
      .rejects.toMatchObject({ code: "REVIEW_NOT_ELIGIBLE" });
    const result = await submitReview(store.db, rahim, { orderItemId: "item_shirt", rating: 4, title: "Good fit" });
    expect(result).toMatchObject({ created: true, published: true, review: { rating: 4, status: "published", displayName: "Abdur R.", variantLabel: "Size M" } });
    expect(store.scalar("SELECT count(*) FROM product_reviews")).toBe(1);
  });

  it("keeps a line outside the 365-day window from its first handover", async () => {
    store.order("ord_old", [{ item: "item_old", product: "prod_mug" }]);
    store.fulfil("ord_old", "item_old", 1, Math.floor(Date.now() / 1000) - 400 * 86_400);
    store.deliver("ord_old");
    await expect(submitReview(store.db, rahim, { orderItemId: "item_old", rating: 5 }))
      .rejects.toMatchObject({ code: "REVIEW_NOT_ELIGIBLE" });
    expect(await listReviewableLines(store.db, rahim)).toEqual([]);
  });

  it("gives other buyers a 404 and lets the receipt holder review the guest order", async () => {
    store.deliveredOrder("ord_guest", [{ item: "item_guest", product: "prod_mug" }], { account: null, customer: "cus_guest", name: "Guest Buyer" });
    await expect(submitReview(store.db, karim, { orderItemId: "item_guest", rating: 5 })).rejects.toMatchObject({ status: 404 });
    await expect(submitReview(store.db, { kind: "guest_receipt", orderId: "ord_other" }, { orderItemId: "item_guest", rating: 5 }))
      .rejects.toMatchObject({ status: 404 });
    const guest = await submitReview(store.db, { kind: "guest_receipt", orderId: "ord_guest" }, { orderItemId: "item_guest", rating: 3 });
    expect(guest.review).toMatchObject({ displayName: "Guest B.", status: "published" });
    expect(store.rows("SELECT author_type, reviewer_key, customer_id FROM product_reviews")).toEqual([
      { author_type: "guest_receipt", reviewer_key: "cus_guest", customer_id: null },
    ]);
    // The order is claimed later: the account sees the review, no review write needed.
    store.sqlite.exec("UPDATE orders SET account_owner_customer_id = 'acct_karim' WHERE id = 'ord_guest'");
    expect((await listBuyerReviews(store.db, karim)).map((review) => review.id)).toEqual([guest.review.id]);
  });

  it("makes a retry on the same line idempotent and turns a repeat purchase into an edit", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    store.deliveredOrder("ord_2", [{ item: "item_2", product: "prod_shirt" }]);
    const first = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5 });
    const retry = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 2 });
    expect(retry).toMatchObject({ created: false, review: { id: first.review.id, rating: 5 } });
    await expect(submitReview(store.db, rahim, { orderItemId: "item_2", rating: 4 }))
      .rejects.toMatchObject({ status: 409, code: "REVIEW_EXISTS", details: { reviewId: first.review.id } });

    const states = await listLineReviewStates(store.db, { orderId: "ord_2", orderItemIds: ["item_2"], audience: "buyer" });
    expect(states.get("item_2")).toEqual({ eligible: false, review: { id: first.review.id, rating: 5, status: "published" } });

    await withdrawReview(store.db, rahim, first.review.id, { version: first.review.version });
    expect(await countReviewableLinesForCustomer(store.db, "acct_rahim")).toBe(1);
    const second = await submitReview(store.db, rahim, { orderItemId: "item_2", rating: 4 });
    expect(second.created).toBe(true);
    // The withdrawn line keeps its one review.
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 4 }))
      .rejects.toMatchObject({ code: "REVIEW_EXISTS" });
  });

  it("holds reviews with contact details or links for moderation whatever the rating, and alerts staff", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }, { item: "item_2", product: "prod_mug" }]);
    const low = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 1, body: "Call me on 01712345678" });
    const high = await submitReview(store.db, rahim, { orderItemId: "item_2", rating: 5, body: "Call me on 01712345678" });
    expect([low.review.status, high.review.status]).toEqual(["pending", "pending"]);
    expect(store.rows("SELECT check_flags FROM product_reviews ORDER BY rating")).toEqual([
      { check_flags: "[\"phone\"]" },
      { check_flags: "[\"phone\"]" },
    ]);
    const alerts = store.rows("SELECT audience, notification_type, subject_id, payload FROM notification_outbox ORDER BY created_at");
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert).toMatchObject({ audience: "staff", notification_type: "review_pending", subject_id: "ord_1" });
      // Ids only: the review text never reaches the outbox (R6).
      expect(String(alert.payload)).not.toContain("0171");
    }
  });

  it("holds every review in hold mode and publishes clean ones in auto mode", async () => {
    await reviewsDocument.write(store.db, { moderation: "hold" });
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    const held = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5, body: "Lovely" });
    expect(held).toMatchObject({ published: false, review: { status: "pending" } });
    expect(store.scalar("SELECT review_count FROM product_review_stats WHERE product_id = 'prod_shirt'")).toBe(0);
  });

  it("refuses writes while reviews are off and hides the buyer's lines", async () => {
    await reviewsDocument.write(store.db, { enabled: false });
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5 })).rejects.toMatchObject({ status: 403 });
    expect(await listReviewableLines(store.db, rahim)).toEqual([]);
    expect((await listLineReviewStates(store.db, { orderId: "ord_1", orderItemIds: ["item_1"], audience: "buyer" })).size).toBe(0);
    expect(await countReviewableLinesForCustomer(store.db, "acct_rahim")).toBe(0);
  });

  it("validates rating and text before any write", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 0 })).rejects.toMatchObject({ status: 400 });
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 4.5 })).rejects.toMatchObject({ status: 400 });
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5, title: "x".repeat(121) }))
      .rejects.toMatchObject({ status: 400, details: { field: "title" } });
    await expect(submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5, title: "Two\nlines" }))
      .rejects.toMatchObject({ status: 400 });
    expect(store.scalar("SELECT count(*) FROM product_reviews")).toBe(0);
  });

  it("edits keep a clean review published, send a flagged edit to moderation, and cap edits at 10 a day", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    const { review } = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5, title: "Great" });
    const edited = await editReview(store.db, rahim, review.id, { version: review.version, rating: 3, body: "Faded after a wash" });
    expect(edited.review).toMatchObject({ status: "published", rating: 3, title: "Great", body: "Faded after a wash" });
    expect(edited.review.editedAt).not.toBeNull();
    expect(store.rows("SELECT review_count, rating_sum FROM product_review_stats WHERE product_id = 'prod_shirt'"))
      .toEqual([{ review_count: 1, rating_sum: 3 }]);

    await expect(editReview(store.db, rahim, review.id, { version: review.version, rating: 4 })).rejects.toMatchObject({ status: 409 });
    await expect(editReview(store.db, karim, review.id, { version: edited.review.version, rating: 4 })).rejects.toMatchObject({ status: 404 });

    const flagged = await editReview(store.db, rahim, review.id, { version: edited.review.version, body: "see www.example.com" });
    expect(flagged.review.status).toBe("pending");
    expect(store.scalar("SELECT review_count FROM product_review_stats WHERE product_id = 'prod_shirt'")).toBe(0);

    let version = flagged.review.version;
    for (let edit = 3; edit <= 10; edit += 1) {
      version = (await editReview(store.db, rahim, review.id, { version, title: `Edit ${edit}` })).review.version;
    }
    await expect(editReview(store.db, rahim, review.id, { version, title: "Eleventh" })).rejects.toMatchObject({ status: 429 });
    // Clearing the display name restores the default.
    expect(store.scalar("SELECT author_display_name FROM product_reviews")).toBe("Abdur R.");
  });

  it("lets the buyer withdraw a pending or published review, and never a withdrawn one", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    const { review } = await submitReview(store.db, rahim, { orderItemId: "item_1", rating: 5 });
    const withdrawn = await withdrawReview(store.db, rahim, review.id, { version: review.version });
    expect(withdrawn.status).toBe("withdrawn");
    await expect(withdrawReview(store.db, rahim, review.id, { version: withdrawn.version })).rejects.toMatchObject({ status: 409 });
    expect(store.scalar("SELECT review_count FROM product_review_stats WHERE product_id = 'prod_shirt'")).toBe(0);
    expect(await listBuyerReviews(store.db, rahim)).toEqual([]);
  });
});
