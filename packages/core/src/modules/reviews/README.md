# Reviews Module

Verified-purchase product reviews (design: `audit/rewrite-2026-09-23/WAVE-B-DESIGN.md` §2). Owner slice: **B1** (core, API, dashboard); B2 builds the storefront on its API. B0 landed the stubs below; they do no I/O and return empty, zero or false, so nothing is buyer-visible until B1.

Public entries: `index.ts` (server) and `browser.ts` (statuses, moderation reasons and modes, `LineReviewExtra`).

## Will own

Submit, edit and withdraw (account owner or receipt proof), the public keyset list and summary, bulk moderation, merchant replies and the review thread, the admin list, the review-request sweep and send-time recheck, the per-line extras reader and the coalesced cache-bump check.

## Seams already mounted (B0)

- Stubs: `listLineReviewStates`, `countReviewableLinesForCustomer` (`extras.ts`); `sweepReviewRequests`, `reviewsChangedSince` (`requests.ts`).
- Routers: `apps/api/src/routes/admin/reviews.ts`, `routes/customer-auth/reviews.ts`, `routes/storefront-orders/reviews.ts`, `routes/product-reviews.ts`.
- Permissions `REVIEWS_VIEW` / `REVIEWS_MODERATE` in `packages/core/src/auth/rbac/route-permissions/reviews.ts`; operations in `apps/api/src/openapi/operation-registry/{dashboard,storefront}-reviews.ts`.

## Planned edges

`reviews → orders` (line eligibility), `conversations` (review thread), `notifications` (`review_pending` staff row), `settings` (the `reviews` document), `products` (product identity). No domain in the existing cycle group may import `reviews`; `catalog` reads the stats table through its own selects.

## Invariants (design §2.7)

- Reviews only for fulfilled, reviewable lines of delivered/completed orders (DB trigger + service). One per line; one live review per product per buyer.
- `product_review_stats` is a trigger projection; no code writes it.
- Moderation never receives the rating. Rejection needs a content reason.
- Review text never enters logs, queue payloads or analytics. Staff never author or edit buyer text.
- Staff moderation bumps the cache generation at once; buyer auto-publishes are coalesced by the 15-minute cron through `reviewsChangedSince`.
