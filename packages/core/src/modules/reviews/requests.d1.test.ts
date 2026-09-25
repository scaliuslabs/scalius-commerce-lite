import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewsDocument } from "../settings/documents";
import {
  moderateReviews,
  reviewRequestSendCheck,
  reviewsChangedSince,
  submitReview,
  sweepReviewRequests,
} from "./index";
import { createReviewStore, type ReviewStore } from "./testing/fixture";

const DAY = 86_400;

describe("review requests (R8) and the coalesced cache bump", () => {
  let store: ReviewStore;

  beforeEach(() => {
    store = createReviewStore();
  });
  afterEach(() => store.close());

  const now = () => Math.floor(Date.now() / 1000);

  it("records one request per delivered order and queues it once the delay has passed", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    // Leaving and re-entering delivered records nothing new.
    store.sqlite.exec("UPDATE orders SET status = 'completed' WHERE id = 'ord_1'; UPDATE orders SET status = 'delivered' WHERE id = 'ord_1';");
    expect(store.rows("SELECT order_id, status FROM order_review_requests")).toEqual([{ order_id: "ord_1", status: "scheduled" }]);

    expect(await sweepReviewRequests(store.db, { now: now() + 6 * DAY })).toEqual({ queued: 0, skipped: 0 });
    expect(await sweepReviewRequests(store.db, { now: now() + 7 * DAY + 60 })).toEqual({ queued: 1, skipped: 0 });
    const outbox = store.rows("SELECT id, audience, notification_type, subject_type, subject_id, dedupe_key, payload FROM notification_outbox");
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      audience: "customer",
      notification_type: "review_request",
      subject_type: "order",
      subject_id: "ord_1",
      dedupe_key: "order:ord_1:review_request",
    });
    expect(store.rows("SELECT status, outbox_id FROM order_review_requests")).toEqual([{ status: "queued", outbox_id: outbox[0]!.id }]);
    expect(await sweepReviewRequests(store.db, { now: now() + 30 * DAY })).toEqual({ queued: 0, skipped: 0 });
  });

  it("skips orders with nothing to review, and every due order while requests are off", async () => {
    store.deliveredOrder("ord_card", [{ item: "item_card", product: "prod_card", type: "gift_card" }]);
    store.deliveredOrder("ord_ok", [{ item: "item_ok", product: "prod_mug" }]);
    await reviewsDocument.write(store.db, { requestsEnabled: false });
    store.deliveredOrder("ord_off", [{ item: "item_off", product: "prod_shirt" }]);
    expect(await sweepReviewRequests(store.db, { now: now() + 8 * DAY })).toEqual({ queued: 0, skipped: 3 });
    expect(store.scalar("SELECT count(*) FROM notification_outbox")).toBe(0);
  });

  it("rechecks at send time: nothing to send once every line is reviewed", async () => {
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }, { item: "item_2", product: "prod_mug" }]);
    expect(await reviewRequestSendCheck(store.db, "ord_1")).toEqual({ productNames: ["Linen Shirt", "Clay Mug"], accountOwned: true });
    await submitReview(store.db, { kind: "customer", customerId: "acct_rahim" }, { orderItemId: "item_1", rating: 5 });
    expect(await reviewRequestSendCheck(store.db, "ord_1")).toEqual({ productNames: ["Clay Mug"], accountOwned: true });
    await submitReview(store.db, { kind: "customer", customerId: "acct_rahim" }, { orderItemId: "item_2", rating: 4 });
    expect(await reviewRequestSendCheck(store.db, "ord_1")).toBeNull();

    store.deliveredOrder("ord_guest", [{ item: "item_g", product: "prod_shirt" }], { account: null, customer: "cus_guest" });
    expect(await reviewRequestSendCheck(store.db, "ord_guest")).toEqual({ productNames: ["Linen Shirt"], accountOwned: false });
    store.sqlite.exec("UPDATE orders SET status = 'returned' WHERE id = 'ord_guest'");
    expect(await reviewRequestSendCheck(store.db, "ord_guest")).toBeNull();
    await reviewsDocument.write(store.db, { enabled: false });
    expect(await reviewRequestSendCheck(store.db, "ord_1")).toBeNull();
  });

  it("reports published-review changes at or after a time (>=), including text-only edits", async () => {
    await reviewsDocument.write(store.db, { moderation: "hold" });
    store.deliveredOrder("ord_1", [{ item: "item_1", product: "prod_shirt" }]);
    const start = now();
    const { review } = await submitReview(store.db, { kind: "customer", customerId: "acct_rahim" }, { orderItemId: "item_1", rating: 5 });
    // A pending review only creates the empty stats row; backdate it to prove the check.
    store.sqlite.exec("UPDATE product_review_stats SET updated_at = updated_at - 3600");
    expect(await reviewsChangedSince(store.db, start)).toBe(false);
    await moderateReviews(store.db, { ids: [review.id], action: "publish" });
    const updatedAt = Number(store.scalar("SELECT updated_at FROM product_review_stats"));
    expect(await reviewsChangedSince(store.db, updatedAt)).toBe(true);
    expect(await reviewsChangedSince(store.db, updatedAt + 1)).toBe(false);
  });
});
