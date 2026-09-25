# Reviews Module

Verified-purchase product reviews (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §2). Owner slice: **B1** (core, API, dashboard); B2 builds the storefront on its API.

Public entries: `index.ts` (server) and `browser.ts` (statuses, moderation reasons, modes and actions, check flags, `LineReviewExtra`).

## Files

- `shared.ts`: ids, the fail-closed settings read, the buyer actor (`customer` = the order's account owner, `guest_receipt` = the receipt's own order) and `reviewableLineConditions` (reviewable type, handed over, delivered/completed, not deleted, within 365 days of the first active fulfilment).
- `lines.ts`: `listLineReviewStates` (`extras.review`), `countReviewableLinesForCustomer` (account tab), `listReviewableLines` ("To review", one line per product), `readBuyerLine`.
- `buyer.ts`: `submitReview`, `editReview`, `withdrawReview`, `listBuyerReviews`, `getBuyerReview`.
- `staff.ts`: `listAdminReviews` (keyset `(created_at, id)`), `getAdminReview`, `getAdminReviewSummary` (per-status counts, a product's stats), `moderateReviews` (≤ 90 ids, one UPDATE), `setReviewReply`, `openReviewThread`, review settings read/save.
- `requests.ts`: `sweepReviewRequests`, `reviewRequestSendCheck`, `reviewsChangedSince`.

The public reads (product page `reviews` field, `GET /products/{id}/reviews`) live in `catalog/product-reviews.ts`, which reads the same tables through its own selects: `catalog` never depends on this domain.

## Rules

- A review needs a handed-over, reviewable line of a delivered or completed order (service + the `product_reviews_line_eligible` trigger). One per line (`UNIQUE(order_item_id)`); one live (pending/published) review per product per buyer (`reviewer_key` = account owner, else order customer, else `order:<id>`). A retry on the same line returns the same review; a repeat purchase gets `409 REVIEW_EXISTS` naming the review to edit.
- Moderation is `checkReviewContent` (links, emails, BD phone numbers, repeated characters, block words) and never sees the rating. `auto` publishes clean reviews; `hold` holds all. A held review writes a staff `review_pending` outbox row in the same batch (ids only). Rejection needs a content reason; "low rating" is not one.
- Buyers edit rating, title, text and display name at most 10 times a day (`edit_count_day`/`edit_day`); every edit writes `rating`, so the stats row's `updated_at` moves even for a text-only edit. Buyers withdraw pending or published reviews. Staff never write buyer text: status, reason, reply and settings only.
- `product_review_stats` is a trigger projection: nothing here writes it (source policy).
- Cache: staff moderation, replies to published reviews and settings saves bump the generation in the route. Buyer auto-publishes do not: the 15-minute cron bumps once when `reviewsChangedSince(generationUpdatedAt)` (`>=`) is true.
- Review requests: the delivered trigger records one row per order; the sweep queues `review_request` outbox rows (dedupe `order:<id>:review_request`) once `requestDelayDays` passed, skipping orders with nothing to review and every due order while reviews or requests are off. The send-time resolver (`apps/api/src/notification-content/review-request.ts`) rechecks and links `/account/orders/<id>#reviews` or `/track-order`, never a token. Channels are the notifications document's `review_request` row.
- Review text never enters logs, URLs, queue payloads or outbox data.

## Domain edges

`reviews → settings` (the reviews document), `reviews → notifications` (outbox rows built in the review's own batch), `reviews → media` (published image keys). Orders, order items, fulfilments, products and the review thread row are read or written through the schema (no `orders`, `products` or `conversations` edge). The three targets sit in the existing cycle group, but no member of that group imports `reviews`, so the group does not grow.
