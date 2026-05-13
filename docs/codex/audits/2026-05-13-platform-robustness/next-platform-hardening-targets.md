# Next Platform Hardening Targets

Date: 2026-05-13
Scope: targeted robustness audit outside widgets.
Mode: source inspection only. No source files were modified for this audit.

This audit intentionally treats markdown and comments as secondary evidence. The findings below are based on implementation paths that are likely to affect production correctness, storefront freshness, checkout reliability, money math, image optimization, and admin autonomy.

## Priority Summary

| Priority | Area | Target |
| --- | --- | --- |
| P0 | Checkout/order pipeline | Prevent leaked inventory reservations and retry storms in queued order ingest. |
| P0 | Discounts | Make discount usage limits and one-per-customer enforcement atomic. |
| P1 | Cache/settings | Centralize storefront invalidation for every admin settings mutation. |
| P1 | Cache | Fix the storefront L2 cache default TTL mismatch and floating Cache API write. |
| P1 | Checkout/order pipeline | Make order creation idempotent around queue send and checkout-status persistence. |
| P1 | Money math | Make all price arithmetic currency-aware, including zero- and three-decimal currencies. |
| P1 | Image optimization | Ensure product/page image data is optimized after media policy is loaded and desktop product images use responsive candidates. |
| P2 | Auth/settings | Remove request-scoped assumptions from module globals and tighten admin token route matching. |
| P2 | Cache/security | Remove purge tokens from URLs and require headers. |

## P0 Findings

### 1. Order ingest can leak inventory reservations when a mixed pool batch partially fails

Evidence:

- `packages/core/src/modules/orders/orders.queue.ts`
  - Groups active reservation entries by pool, then calls `reserveStockBatch()` once per pool.
  - If one pool reserves successfully and a later pool fails, the failure branch marks checkouts failed and retries messages but does not release reservations already taken by earlier pools.
- `packages/core/src/modules/inventory/reserve.ts`
  - `reserveStockBatch()` mutates inventory and writes reservation movements before the order transaction finishes.

Why this matters:

An order batch can contain regular, preorder, and backorder pools. If the first pool succeeds and the second fails, stock can remain reserved for orders that are reported as failed or retried. Expiry cleanup may eventually unwind some reservations, but the customer and admin state is wrong in the meantime, and repeated retries can compound the issue.

Concrete fix:

- Track every successful reservation group inside `handleOrderIngestBatch()`.
- On any later reservation failure, release all reservations already created for the affected checkout/order before retrying or terminally failing messages.
- Prefer a small local rollback helper that calls the same inventory transition primitives used for cancellation/expiry, so audit logs and stock counters stay consistent.
- Classify reservation errors:
  - Terminal: insufficient stock, backorder not allowed, invalid variant.
  - Retryable: transient D1/KV/queue errors, CAS contention.
- Ack terminal failures after persisting checkout failure state; retry only transient failures.

Verification:

- Add a test with two messages in one queue batch where pool A reserves and pool B fails.
- Assert reserved stock returns to its previous value.
- Assert terminal stock failures do not call `msg.retry()`.
- Assert transient failures do call `msg.retry()` and do not leave extra reservations.

### 2. Discount usage limits are validated before write, not enforced atomically

Evidence:

- `packages/core/src/modules/discounts/discounts.eligibility.ts`
  - Checks `maxUses` by counting existing rows.
  - Checks `limitOnePerCustomer` by querying previous usage.
- `packages/core/src/modules/orders/orders.queue.ts`
  - Re-checks discount eligibility during queue processing, but still uses read-before-write logic.
- `packages/database/src/schema/marketing.ts`
  - `discountUsage` has non-unique indexes only. There is no atomic counter or uniqueness constraint for one-per-customer redemption.

Why this matters:

Two concurrent queue consumers can both observe usage below the cap and both insert usage rows. The same race can allow two redemptions for one customer. Re-checking inside the queue narrows the window but does not close it.

Concrete fix:

- Add a database-enforced redemption path:
  - Add a `usedCount` column to discounts, or a dedicated redemption counter table.
  - Increment with a conditional update such as `usedCount < maxUses`.
  - Insert usage in the same transaction only after the conditional update succeeds.
- Add a normalized customer key for one-per-customer limits, ideally customer ID when logged in and normalized phone/email for guest checkout.
- Add a unique index for `(discountId, customerKey)` when `limitOnePerCustomer` applies, or store all usage with the key and enforce in service before insert plus DB conflict handling.
- Return a clear terminal checkout failure if redemption cannot be reserved.

Verification:

- Add a concurrency test that fires two orders against a `maxUses: 1` discount.
- Add a guest checkout test that attempts two redemptions with the same normalized phone.
- Assert exactly one order gets the discount and the second receives a deterministic failure.

## P1 Findings

### 3. Storefront cache invalidation is inconsistent across admin settings routes

Evidence:

- `apps/api/src/utils/cache-invalidation.ts`
  - Defines mappings for settings routes and groups such as `layout` and `products`.
- `apps/api/src/routes/admin/settings/site.ts`
  - Currency save deletes `gw:currency` but does not call the shared storefront invalidation and purge helpers.
  - Header and footer saves call `invalidateSiteSettingsCache()` only.
  - Theme save deletes API layout cache keys but does not purge storefront cache versions.
  - SEO and storefront URL saves clear local settings/layout state but do not consistently purge storefront HTML/L2 cache.
- `apps/storefront/src/lib/edge-cache.ts`
  - Storefront L1/L2 cache freshness depends on versioned keys and purge behavior.

Why this matters:

Admin settings are merchant-controlled production configuration. Currency, header/footer, theme, SEO, logo, and storefront URL changes must become visible quickly and predictably. Current routes can leave stale storefront L1/L2/HTML responses even when a mapping exists elsewhere.

Concrete fix:

- Create one settings invalidation helper in the API app, for example `invalidateSettingsChange(c, groups)`.
- For each mutating settings route, call both:
  - `invalidateGroups(groups, kv)`
  - `purgeStorefrontForGroups(groups, env)`
- Use explicit groups per setting:
  - Currency: `layout`, `products`, `cart`, `checkout`
  - Header/footer/theme/logo: `layout`, `pages`, `products`
  - SEO/storefront URL: `layout`, `pages`, `products`
  - Payment/checkout settings: `layout`, `checkout`
- Remove or deprecate duplicate invalidation logic once every route uses the helper.

Verification:

- Add API route tests asserting each settings mutator calls the invalidation helper with expected groups.
- Add a browser test that changes logo/currency/theme, purges, and verifies storefront reflects the change without manual cache clearing.

### 4. Storefront L2 cache default TTL says 24 hours but is 100 days

Evidence:

- `apps/storefront/src/lib/edge-cache.ts`
  - `DEFAULT_TTL_SECONDS = 8640000`
  - Comment says `24 hours`.
  - `8640000` seconds is 100 days.

Why this matters:

If an invalidation path misses a version bump or purge, stale Cache API entries can persist for far longer than intended. This amplifies every cache invalidation bug.

Concrete fix:

- Change the default to `86_400` seconds if 24 hours is intended.
- If 100 days is intended, rename the constant and update the comment, then require stronger purge tests before accepting that policy.
- Add unit tests for default TTL and `CACHE_TTL` constants.

Verification:

- Assert generated `Cache-Control` for a default L2 write contains `max-age=86400`.
- Assert long-lived static/image paths still use their intended separate TTLs.

### 5. Storefront Cache API write is a floating promise without `waitUntil`

Evidence:

- `apps/storefront/src/lib/edge-cache.ts`
  - `storeInL2()` creates a `cache.put()` promise.
  - If `ctx.waitUntil` exists, it is passed to `waitUntil`.
  - If `ctx.waitUntil` does not exist, the promise is not awaited or explicitly caught.

Why this matters:

Cloudflare Workers best practices recommend avoiding floating promises. In non-standard execution contexts and tests, a failed cache write can become unobserved, and a successful cache write can be lost before completion.

Concrete fix:

- In the no-`waitUntil` path, either `await` the write or explicitly `void storePromise.catch(...)`.
- Prefer making the helper behavior deterministic in tests by allowing a mode that awaits L2 writes.

Verification:

- Add a unit test with no `waitUntil` and a mocked `cache.put()` rejection.
- Assert the rejection is caught/logged and does not create an unhandled rejection.

### 6. Order creation can become non-idempotent if queue send succeeds but status persistence fails

Evidence:

- `apps/api/src/routes/orders.ts`
  - Order creation sends `result.queuePayload` to `ORDER_INGEST_QUEUE`.
  - It then writes `checkout_status:${checkoutId}` to KV.
  - If KV write fails after queue send, the HTTP response can fail while the queue message is already accepted.

Why this matters:

The browser can retry after receiving an error. That retry can create another checkout/order request, while the original queue message may still complete. This is a classic duplicate-order edge case.

Concrete fix:

- Require a client-provided idempotency key for checkout submission, or derive one from a persisted checkout token.
- Persist the idempotency record before sending to the queue.
- Make queue payload processing idempotent by checkout ID and order ID.
- Write checkout status before queue send when possible, then transition status after send.
- If queue send fails after status write, mark the status failed with a retryable reason.

Verification:

- Add a test where queue send succeeds and KV put throws.
- Assert a retried request returns the existing checkout/order status instead of creating a second order.

### 7. `reserveStockBatch()` merges entries by variant and logs them under the first order ID

Evidence:

- `packages/core/src/modules/inventory/reserve.ts`
  - Deduplicates requested stock by variant.
  - Uses `items[0]?.orderId` as the movement order ID for the merged reservation.

Why this matters:

If one queue batch contains multiple orders for the same variant, the stock mutation can be correct while movement logs and reservation identity are not. Expiry, release, audit history, and admin troubleshooting can point to the wrong order.

Concrete fix:

- Separate inventory quantity mutation from per-order reservation movement records.
- Group by `(variantId, orderId)` for reservation movements.
- Keep the stock update batched by variant, but write one movement per order/variant reservation.

Verification:

- Add a queue batch test with two orders for the same variant.
- Assert inventory quantity changes once per aggregate, but movement records preserve each order ID and quantity.

### 8. Checkout item lookup uses raw SQL array interpolation instead of Drizzle `inArray()`

Evidence:

- `packages/core/src/modules/orders/orders.storefront.ts`
  - Several queries use raw SQL interpolation for `IN` clauses with arrays.
- Other code paths use Drizzle helpers such as `inArray()`.

Why this matters:

SQLite/D1 array interpolation can compile differently than intended. If an array is bound as a single value, multi-item checkout validation can fail or silently return incomplete data.

Concrete fix:

- Replace raw `IN ${ids}` array interpolation with `inArray(column, ids)` everywhere in checkout item and location lookup queries.
- Keep explicit empty-array guards before queries.

Verification:

- Add checkout tests for:
  - Multiple variants from the same product.
  - Multiple products.
  - Multiple shipping zones/locations.

### 9. Money helpers default to two decimals and are not consistently currency-aware

Evidence:

- `packages/shared/src/price-utils.ts`
  - `roundPrice(amount, currencyCode)` supports currency precision.
  - `addPrices()`, `subtractPrice()`, `pricesEqual()`, `calculatePercentageDiscount()`, and `calculateDiscountedPrice()` do not accept currency and default to two decimals.
- `packages/core/src/modules/orders/orders.storefront.ts`
  - Checkout verification multiplies and rounds late.
- Admin currency settings support currencies with non-two-decimal precision.

Why this matters:

The platform exposes configurable currency settings. BDT and USD are two decimals, but JPY is zero decimals and BHD/KWD-style currencies use three decimals. Generic two-decimal math can overcharge, undercharge, or create payment mismatch errors.

Concrete fix:

- Extend shared money helpers to accept `currencyCode` or explicit precision.
- Pass active currency settings into checkout, discounts, shipping, payment, and invoice calculations.
- Round at deterministic boundaries:
  - Unit price after variant modifiers.
  - Line subtotal after quantity multiplication.
  - Discount amount.
  - Shipping amount.
  - Final payable total.
- Store integer minor units for new payment-facing calculations where feasible, or at least isolate conversion to a tested money module.

Verification:

- Add tests for BDT/USD two-decimal behavior, JPY zero-decimal behavior, and BHD three-decimal behavior.
- Add a checkout test where percentage discount, shipping, and payment amount all reconcile exactly.

### 10. Discount code uniqueness conflicts with soft-delete behavior

Evidence:

- `packages/database/src/schema/marketing.ts`
  - `discounts.code` has a global unique index.
- `packages/core/src/modules/discounts/discounts.service.ts`
  - Create/update checks only active, non-deleted conflicting codes.
  - Restore has conflict checks that imply soft-deleted code reuse is possible.

Why this matters:

The service behavior says a deleted discount code can be reused, but the database schema forbids it. Admins can see confusing validation or restore behavior depending on path.

Concrete fix:

- Decide the product policy:
  - If deleted codes are reusable, replace the global unique index with a partial unique index on non-deleted rows.
  - If codes are permanent, update service validation and UI copy to say deleted codes cannot be reused.
- Prefer the first option if merchant autonomy and clean admin workflows are the priority.

Verification:

- Add tests for create, soft-delete, recreate same code, and restore conflict.

### 11. Image optimization policy can be applied too late for page/product data

Evidence:

- `apps/storefront/src/lib/page-data.ts`
  - Fetches layout data and page data in parallel.
  - Calls `setRuntimeImageCdnPolicy(layoutData?.media)` after both have returned.
- `packages/shared/src/image-optimizer.ts`
  - Uses runtime CDN policy to decide whether and how to produce Cloudflare image resizing URLs.
- Product and page rendering paths rely on serialized/optimized media URLs.

Why this matters:

If page or product data is serialized or optimized before the media policy is loaded, the generated HTML can contain raw CDN images or fallback URL policy. The user has already observed raw CDN product page images, so this ordering deserves a direct fix and browser verification.

Concrete fix:

- Load the minimal layout/media policy first, set the image CDN policy, then fetch page/product data that may serialize image URLs.
- Better long-term: remove global runtime image policy from data serialization and pass an explicit image optimization context into functions that generate URLs.
- Add an assertion utility for storefront pages that scans rendered images and flags raw CDN raster URLs when an optimized `/cdn-cgi/image/` URL is expected.

Verification:

- Browser-test product detail pages, homepage sections, landing pages, and collection pages.
- Assert product gallery, banners, logos, and collection images use optimized URLs where eligible.
- Assert SVGs and unsupported formats are not incorrectly routed through image resizing.

### 12. Desktop product gallery lacks responsive `srcset`

Evidence:

- `apps/storefront/src/components/product/ProductGallery.astro`
  - Mobile image markup includes `srcset` and `sizes`.
- `apps/storefront/src/components/product/ProductImageZoom.tsx`
  - Desktop zoom image renders a single `src`, with no `srcset` or `sizes`.

Why this matters:

Desktop product media is usually the product page LCP. A single 600px URL may be blurry on high-DPI screens or too large/small depending on layout. It also weakens the storefront image optimization story.

Concrete fix:

- Pass `srcSet` and `sizes` into the React zoom component.
- Render the base desktop image with responsive candidates and reserve dimensions/aspect ratio to avoid layout shift.
- Keep the high-resolution zoom source separate from the visible LCP image.

Verification:

- Browser-test product pages at mobile, tablet, and desktop widths.
- Inspect rendered `img` attributes and network requests.
- Confirm no raw CDN URL is used for eligible raster product images.

## P2 Findings

### 13. Module-level KV binding can hold request-scoped state

Evidence:

- `apps/api/src/utils/kv-cache.ts`
  - Stores a mutable module-level KV binding.
  - `setKvBinding()` updates the global value.

Why this matters:

Cloudflare isolates can be reused across requests. Module-level state is fine for immutable caches, but request/environment-scoped bindings should be passed explicitly where possible. This matters more as the platform grows into preview environments, multi-tenant routing, or per-store settings.

Concrete fix:

- Pass KV explicitly into helpers that need it.
- Keep a module-level fallback only for local development or legacy call sites during a short transition.
- Add a lint rule or code review note to avoid adding new mutable request-scoped globals.

Verification:

- Add tests that call cache helpers with two mocked KV namespaces and assert no cross-call bleed.

### 14. Purge cache accepts tokens in URLs

Evidence:

- `apps/storefront/src/pages/api/purge-cache.ts`
  - GET purge path accepts `?token=...`.
  - POST purge path also accepts token from URL/body in addition to headers.

Why this matters:

URL tokens can leak through browser history, logs, analytics, proxies, referrers, and screenshots. Purge access is operationally sensitive because it controls storefront cache freshness.

Concrete fix:

- Require `Authorization: Bearer <token>` or `X-Purge-Token`.
- Remove query/body token support.
- Return a clear 401 for missing or misplaced tokens.

Verification:

- Add tests for header success and query/body rejection.
- Confirm admin/API purge callers send the token by header.

### 15. Better Auth instance cache key ignores several auth-affecting environment values

Evidence:

- `packages/core/src/auth/auth.ts`
  - Caches Better Auth instance by `BETTER_AUTH_SECRET`.
  - The constructed auth config also depends on URL/origin settings.

Why this matters:

If `BETTER_AUTH_URL`, public API base URL, storefront URL, or trusted origins change in a warm Worker isolate, the cached instance can continue using stale origin settings. That is especially risky for domain changes and preview/staging environments.

Concrete fix:

- Include all auth-affecting env vars in the cache signature.
- Or avoid caching the auth instance globally unless benchmarking proves it is necessary.
- Keep immutable parsed config per env signature, not per secret only.

Verification:

- Add a unit test that creates auth with two different base URLs in the same process and asserts trusted origins/base URL change.

### 16. Scanner admin token authorization uses substring route matching

Evidence:

- `apps/api/src/middleware/admin-auth.ts`
  - Scanner token bypass checks `pathname.includes("/inventory/")`.

Why this matters:

Substring matching is brittle. A future unrelated admin route containing `/inventory/` could unintentionally accept scanner token auth.

Concrete fix:

- Normalize the request path.
- Require an explicit prefix such as `/api/v1/admin/inventory`.
- Restrict methods and exact scanner endpoints where possible.

Verification:

- Add middleware tests for allowed scanner endpoints and denied lookalike paths.

### 17. Admin account verification posture is hard-coded

Evidence:

- `packages/core/src/auth/auth.ts`
  - Email verification is disabled in config.

Why this matters:

For production admin/merchant accounts, verification and 2FA policy should be configurable from admin security settings. Hard-coded auth posture conflicts with the platform goal that operational policy should be admin-configurable.

Concrete fix:

- Add security settings for admin email verification and role-based 2FA enforcement.
- Cache these settings carefully, with explicit invalidation on settings update.
- Make defaults strict in production and easier in local development.

Verification:

- Add tests for local/dev defaults, production defaults, and explicit admin settings overrides.

### 18. Rate limiting can silently disappear when KV is missing

Evidence:

- `apps/api/src/routes/orders.ts`
  - Checkout rate limiting depends on `c.env.CACHE`.

Why this matters:

Checkout is a high-abuse surface. If a binding is missing or misconfigured in production, the route should fail closed or use a clearly bounded fallback rather than silently running without a limiter.

Concrete fix:

- Add a production assertion that required rate-limit KV binding exists.
- In local/dev, use a small in-memory fallback with clear logging.
- Add deployment/config validation to catch missing bindings before deploy.

Verification:

- Add route tests for missing KV in production and local modes.
- Add a deployment smoke check that verifies required bindings.

## Structural Cleanup Targets

### Duplicate cache invalidation modules

Evidence:

- `apps/api/src/utils/cache-invalidation.ts`
- `packages/core/src/utils/cache-invalidation.ts`

Risk:

The two modules can drift. Cache invalidation is already a high-risk area, so duplicate policy maps make the platform harder to reason about.

Concrete fix:

- Keep one canonical invalidation policy module.
- If API routes need app-specific behavior such as storefront purge token dispatch, keep the policy data shared and app-specific IO in the API app.
- Add tests that enumerate every mutating route and expected cache groups.

### Inventory expiry timestamp consistency

Evidence:

- `packages/core/src/modules/inventory/expiry.ts`
  - Comments refer to unix seconds.
- `packages/core/src/modules/inventory/reserve.ts`
  - Movement records are written with `new Date()`.

Risk:

If schema mode, Drizzle conversion, and raw comparisons are not aligned, old reservations may not expire correctly.

Concrete fix:

- Verify the actual column type in `packages/database/src/schema/inventory.ts`.
- Use one timestamp representation in all movement queries.
- Add an integration test that inserts old and fresh reservation movements through the real Drizzle client and asserts only old movements expire.

## Recommended Fix Order

1. Fix order ingest reservation rollback and terminal-vs-retryable failure classification.
2. Make discount usage enforcement atomic.
3. Fix settings invalidation and purge coverage, then reduce storefront L2 default TTL.
4. Make checkout submission idempotent around queue send/status persistence.
5. Replace raw checkout `IN` SQL with `inArray()`.
6. Make shared money helpers currency-aware and wire them through checkout/discount/payment totals.
7. Fix image optimization ordering and desktop product gallery responsive candidates.
8. Tighten purge token handling, auth cache keying, scanner token route matching, and production rate-limit binding checks.
9. Remove duplicate cache invalidation policy and add route-to-cache-group coverage tests.

## Browser And Programmatic Verification Plan

After implementing the above in separate commits, verify each area before moving on:

- Storefront cache/settings:
  - Change currency, logo/header/footer/theme/SEO from admin.
  - Confirm storefront updates after purge without manual browser cache clearing.
  - Inspect rendered HTML and response headers.
- Checkout/order:
  - Submit single-item and multi-item checkout.
  - Submit with mixed inventory pools.
  - Force insufficient stock and ensure terminal failure does not retry forever.
  - Force queue/KV transient failures in tests.
- Discounts:
  - Race two checkouts against a one-use code.
  - Test one-per-customer with normalized phone/email.
- Image optimization:
  - Visit product, homepage, collection, and landing pages.
  - Inspect `img` `src`, `srcset`, and network URLs.
  - Confirm eligible CDN raster images use Cloudflare image resizing.
- Auth/settings:
  - Test auth config under two base URLs in one process.
  - Verify scanner token cannot access non-scanner admin routes.
  - Verify production checkout route fails closed when rate-limit KV is missing.

## References

- Cloudflare Workers best practices: https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
