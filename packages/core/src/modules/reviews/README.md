# Reviews

Verified-purchase product reviews: buyers review delivered order lines, staff moderate and reply, and a trigger-maintained projection feeds product ratings. Audience: contributors and coding agents.

## Entries

- `index.ts` is the server entry.
- `browser.ts` is the closed entry: `REVIEW_STATUSES`, `REVIEW_MODERATION_REASONS`, `REVIEW_MODERATION_MODES`, `REVIEW_MODERATION_ACTIONS`, `REVIEW_CHECK_FLAG_VALUES`, `REVIEW_MODERATION_BATCH_MAX` and `LineReviewExtra`.

| File | Owns |
|------|------|
| `shared.ts` | Ids, the fail-closed settings read, the buyer actor, `reviewableLineConditions`. |
| `lines.ts` | `listLineReviewStates` (`extras.review`), reviewable-line counts and lists ("To review", one line per product). |
| `buyer.ts` | `submitReview`, `editReview`, `withdrawReview`, `listBuyerReviews`, `getBuyerReview`, `readBuyerProductReviewState`. |
| `staff.ts` | `listAdminReviews`, `getAdminReview`, `getAdminReviewSummary`, `moderateReviews`, `setReviewReply`, `openReviewThread`, review settings read and save. |
| `requests.ts` | `sweepReviewRequests` and `reviewRequestSendCheck`. |

The public reads (the product page `reviews` field and `GET /api/v1/products/{id}/reviews`) live in `catalog/product-reviews.ts`. They read the same tables, so `catalog` never depends on this domain.

## Layer and imports

- Layer L6. Imports `settings` (the `reviews` document), `notifications` (outbox rows built in the review's own batch) and `media-references` (published image keys).
- Orders, order items, fulfilments, products and the review thread row are read or written through the schema, not through domain entries.
- Nothing imports `reviews`.

## Tables

| Table | Role and constraints |
|-------|----------------------|
| `product_reviews` | One review. Unique `order_item_id`. Unique `(product_id, reviewer_key)` while `status` is `pending` or `published`. `reviewer_key` is the account owner id, else the order's customer id, else `order:<id>`. Rating 1 to 5, title up to 120, body up to 5,000, reply up to 2,000 characters. `rejected` needs a `moderation_reason`. `edit_count_day` is at most 10. `version` is the CAS token. |
| `product_review_stats` | One row per reviewed product: counts per star, `rating_avg_centi`, `rating_rank_milli` (Bayesian rank), `last_published_at`. A trigger projection of published reviews. No code writes it (source policy). |
| `order_review_requests` | One row per delivered order, recorded by a trigger on `orders.status`. `status` is `scheduled`, `queued` or `skipped`. |

Triggers (migration 0095): `product_reviews_line_eligible` refuses a line that was not handed over on a delivered or completed order. `product_reviews_stats_*` maintain the stats row.

## Rules

- A reviewable line is a reviewable fulfilment type, handed over, on a live order with status `delivered` or `completed`, and within 365 days of its first active fulfilment.
- The buyer is the verified account that owns the order, or a guest holding the order's receipt proof.
- A retry on the same line returns the same review. A repeat purchase of the same product gets `409 REVIEW_EXISTS` naming the review to edit.
- Moderation uses `checkReviewContent` (links, emails, Bangladesh phone numbers, repeated characters, merchant block words). It never sees the rating. Mode `auto` publishes clean reviews. Mode `hold` holds all.
- A held review writes a staff `review_pending` outbox row in the same batch (ids only). Rejection needs a content reason. "Low rating" is not one.
- Buyers edit rating, title, text and display name at most 10 times a day. Buyers withdraw pending or published reviews. Staff never write buyer text: they set status, reason, reply and settings only.
- `moderateReviews` takes at most 90 ids and runs one UPDATE. Repeats are idempotent.
- Review text never enters logs, URLs, queue payloads or outbox data.
- Review requests: the delivered trigger records one row per order. `sweepReviewRequests` runs in the scheduled maintenance (`apps/api/src/scheduled-maintenance.ts`). When `requestDelayDays` has passed, it queues a `review_request` outbox row (dedupe `order:<id>:review_request`). It skips orders with nothing to review, and every due order while reviews or requests are off.
- The send-time resolver `apps/api/src/notification-content/review-request.ts` rechecks and links `/account/orders/<id>#reviews` or `/track-order`, never a token. Channels come from the `review_request` row of the notifications document.

## Settings and DVC

- The `reviews` document (`enabled`, `moderation`, `requestsEnabled`, `requestDelayDays` 1 to 60, `blockWords`) is declared in `settings`. An unreadable document hides reviews and refuses writes.
- Ratings reach buyers only through `catalog`, which must use the reviews-enabled guards: `reviewStatsJoin` (`catalog/shared.ts`) and `reviewsEnabledSql` (`settings`). Card ratings, the rating facet and the `rating` sort depend on them.
- Triggers on `product_reviews` and `product_review_stats` advance the product, rating-facet and rating-order dependencies in the same transaction. There is no scheduled review cache refresh.

## Routes

Permissions are in `packages/core/src/auth/rbac/route-permissions/reviews.ts`.

| Method and path | Permission |
|-----------------|------------|
| `GET /api/v1/admin/reviews`, `GET /summary`, `GET /settings`, `GET /{id}` | `reviews.view` |
| `PUT /api/v1/admin/reviews/settings`, `POST /moderate`, `PUT /{id}/reply` | `reviews.moderate` |
| `POST /api/v1/admin/reviews/{id}/conversation` | `reviews.moderate` and `conversations.reply` |
| `GET /api/v1/products/{id}/reviews` | none (public) |
| `GET, POST /api/v1/customer-auth/reviews`, `GET /reviews/products/{productId}`, `PATCH /reviews/{id}` | customer session |
| `GET, POST /api/v1/orders/receipt/{id}/reviews`, `PATCH /{reviewId}` | receipt proof |

`GET /api/v1/admin/reviews` pages by keyset on `(created_at, id)`, 25 rows a page.

## Where to look

- Dashboard: `apps/admin-v2/src/components/admin/reviews/`.
- Tests: `submit.d1.test.ts`, `moderation.d1.test.ts`, `requests.d1.test.ts`; `testing/fixture.ts` is the shared fixture.
