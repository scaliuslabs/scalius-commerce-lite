# API Backend Layer Audit

**Date:** 2026-03-21
**Scope:** `apps/api/src/` -- every route, middleware, handler, config, type definition, utility (86 source files)
**Cross-referenced with:** `packages/core`, `packages/database`, `packages/shared`

---

## Overall Score: 7.2 / 10

The API layer is a well-structured Hono + OpenAPI application with strong architectural foundations. The Zod-validated OpenAPI routes, standardized response envelope, queue-based async processing, and group-based cache invalidation are all production-quality patterns. The primary gaps are (a) pervasive `as any` casts that undermine the type safety the OpenAPI setup was built to provide, (b) several routes that break the thin HTTP layer pattern with inline query logic, and (c) a small set of files (shipping, checkout-languages, delivery-locations) that were written independently and never refactored to match the core-delegation pattern the rest of the codebase follows.

---

## Dimension Ratings

### 1. Maintainability -- 7/10

**Strengths:**
- Consistent file structure across all 86 source files. Every route file follows the same pattern: imports, `createRoute()`, `app.openapi()`, export.
- Centralized schemas in `schemas/responses.ts` (envelope/pagination/error) and `schemas/entities.ts` give a single source of truth.
- Settings sub-routes are cleanly split into 9 focused files under `routes/admin/settings/`.
- Core service delegation means most route handlers are 5-15 lines -- they validate, call core, respond.
- Cache invalidation is group-based (`cache-invalidation.ts`) with named groups, making it easy to reason about what gets cleared when.

**Issues:**
- **Shipping methods settings** (`routes/admin/settings/shipping.ts`, 436 lines) contains full CRUD with inline Drizzle queries -- duplicates what a `@scalius/core/modules/shipping` service should provide. This is the most significant thin-layer violation in admin routes.
- **Checkout languages** (`routes/checkout-languages.ts`, 452 lines) is another fat route file with full CRUD, inline queries, and pagination logic that should be delegated to a core service.
- **Delivery locations admin** (`routes/admin/settings/delivery-locations.ts`, 393 lines) has some inline query logic alongside core delegation, creating an inconsistent pattern within the same file.
- **Hero sliders admin** (`routes/admin/settings/hero-sliders.ts`) has full inline CRUD -- no core service layer.
- Variable naming for bulk operations is inconsistent: some routes use `ids` (widgets, pages, collections), some use `collectionIds`/`pageIds`/`discountIds` for the same concept.
- `unixToDate` helper is duplicated across files (seen in `routes/orders.ts` and admin order routes).

### 2. Robustness -- 7/10

**Strengths:**
- Global error handler in `app.ts` catches all unhandled errors and formats them as structured JSON.
- JWT token blacklist check (`isTokenBlacklisted` in `utils/jwt.ts`) fails closed -- if KV is unavailable, it treats the token as blacklisted. This is the correct security stance.
- Webhook handlers (Stripe, SSLCommerz, Polar, Pathao, Steadfast) all implement KV-based idempotency dedup keys before processing.
- Webhook signature verification uses timing-safe comparison (`timingSafeEqual`).
- Payment routes validate order status before processing (already paid, cancelled, returned).
- Search routes have a 5-second timeout via `Promise.race()`.
- Rate limiting on abandoned checkout saves (10/minute per IP).
- Credential masking is consistent -- all routes that return API keys/secrets use `MASKED_VALUE` pattern, and update routes handle the "masked value sent back" case by preserving existing credentials.

**Issues:**
- **`JSON.parse()` without try-catch in storefront routes.** `routes/hero.ts` lines 109, 119, 203 call `JSON.parse(slider.images)` without try-catch. If images column is corrupted, the route crashes. Same pattern in `routes/header.ts` (line 82), `routes/footer.ts` (line 90), and several hero slider admin routes.
- **Missing pagination bounds.** Several admin list routes accept `limit` via query but do not clamp it to a maximum. For example, `routes/admin/collections.ts` uses `z.coerce.number().default(20)` without `.max()`. A client could request `limit=10000` and overload D1.
- **Admin search reindex is a no-op.** `routes/admin/search.ts` line 97 returns `{ message: "Reindex initiated" }` but does nothing. This is misleading -- it should either implement the feature or return 501 Not Implemented.
- **Try-catch-rethrow anti-pattern.** Multiple files wrap handlers in try/catch that only rethrow: `routes/admin/fraud-checker.ts` (lines 34-48, 73-89, 115-139, 157-166, 184-193), `routes/admin/settings/system.ts`, `routes/admin/settings/payments.ts`. These add noise without value since the global error handler already catches everything.
- **Partytown proxy allows regex injection.** `routes/partytown-proxy.ts` line 100 constructs a regex from allowed domain strings using `domain.replace(/\*/g, ".*")`. If a domain entry contains regex metacharacters, this could lead to unexpected matching. Should use `escapeRegex()` on the non-wildcard parts.
- **SSLCommerz redirect handlers duplicate code.** `routes/payment/sslcommerz-routes.ts` has identical GET/POST handler pairs for success, fail, and cancel (lines 193-257) -- 6 handlers that should be 3 using method-agnostic registration.

### 3. Code Quality -- 7/10

**Strengths:**
- OpenAPI route definitions are comprehensive -- every route has tags, summary, request/response schemas.
- Response envelope contract is enforced through the `ok()`, `created()`, `noContent()` helpers -- no route manually constructs `{ success: true, data: ... }`.
- Zod schemas are used for all request validation (params, query, body), eliminating manual validation code.
- Utility modules are well-factored: `kv-cache.ts`, `cache-invalidation.ts`, `cache-ttls.ts`, `jwt.ts`, `encryption-key.ts`.
- Error classes are properly imported from `@scalius/core/errors` with appropriate HTTP status codes.

**Issues:**
- **Pervasive `as any` casts on route handlers.** This is the single most widespread code quality issue. The following files cast handlers to `any`: `routes/admin/discounts.ts` (3 handlers), `routes/admin/analytics.ts` (2 handlers), `routes/admin/shipments.ts` (1 handler), `routes/admin/openrouter.ts` (3 handlers), `routes/admin/settings/shipping.ts` (3 handlers), `routes/admin/settings/delivery-providers.ts` (2 handlers), `routes/admin/settings/delivery-locations.ts` (1 handler), `routes/admin/settings/meta-conversions-admin.ts` (3 handlers), `routes/admin/settings/hero-sliders.ts` (1 handler -- implicit), `routes/attributes.ts` (3 handlers), `routes/products.ts` (mentioned in summary). This undermines the type safety that OpenAPI + Zod was specifically chosen to provide. Root cause is likely type mismatch between `OpenAPIHono` generic parameter and handler context types.
- **Missing `<{ Bindings: Env }>` generic.** Many admin route files instantiate `new OpenAPIHono()` without the `Bindings: Env` generic parameter (collections, pages, discounts, analytics, attributes, search, fraud-checker, ai-context, ai-prompts, openrouter, all settings sub-files except notification-channels). This is what forces the `as any` casts -- the context type doesn't include `c.env`.
- **Inconsistent error responses on delete.** `routes/admin/settings/delivery-providers.ts` line 389 deletes without checking existence first -- silently succeeds if ID doesn't exist. Contrast with `routes/admin/shipments.ts` which properly checks existence before deleting.
- **Unused imports.** `routes/admin/collections.ts` imports `ApiError` but never uses it. `routes/admin/pages.ts` imports `ApiError`. `routes/admin/discounts.ts` imports `discounts`, `eq`, `sql` -- the `discounts` import is used in `toggleStatusRoute` but that handler does inline DB work that should be in the core service.

### 4. Scalability -- 8/10

**Strengths:**
- Queue-based order processing (`ORDER_INGEST_QUEUE`, `PAYMENT_EVENTS_QUEUE`, `ORDER_NOTIFICATIONS_QUEUE`, `AUTH_OTP_QUEUE`) decouples heavy processing from request handling. The 202 Accepted + checkout token polling pattern is textbook.
- KV-based caching with configurable TTLs means hot paths (products, categories, navigation, header/footer) serve from cache without hitting D1.
- Group-based cache invalidation (`cache-invalidation.ts`) allows targeted purging instead of full cache clears.
- In-memory cache fallback (`InMemoryCache` in `kv-cache.ts` with maxSize 5000) handles KV unavailability gracefully.
- `waitUntil()` is used appropriately for non-blocking operations like Meta CAPI event delivery.
- Collection form options endpoint uses `Promise.all()` for parallel queries. AI context batch endpoint batches all URL lookups into a single `Promise.all()`.

**Issues:**
- **N+1 potential in storefront categories route.** As noted in earlier audit sessions, `routes/categories.ts` has inline query logic that can generate multiple queries per request when filtering by attributes.
- **No query result size limits on some admin endpoints.** `routes/admin/settings/delivery-locations.ts` defaults to `limit=100` which is reasonable, but `routes/admin/collections.ts` form-options endpoint has `limit(500)` hardcoded -- fine for now but will need pagination when catalog grows.
- **OpenRouter model listing** (`routes/admin/openrouter.ts` line 35) fetches the full OpenRouter model catalog on every request with no caching. This could be slow and should have KV caching.
- **AI context batch endpoint** (`routes/admin/ai-context.ts`) fetches all product data, images, variants, attributes, and categories in one request without pagination or size limits. For large catalogs, this could exceed D1 response size limits.

### 5. Performance -- 7/10

**Strengths:**
- Cache middleware (`middleware/cache.ts`) correctly implements: KV read on GET, Cache-Control headers, auth-aware key variation, skip on POST/PUT/DELETE.
- Cache TTLs are centralized and sensible: STANDARD=1h for layout/nav, SHORT=5m for volatile data, CHECKOUT_CONFIG=1m.
- Admin order list endpoint (`routes/admin/orders.ts`) was patched to fix an N+1 query issue (mentioned in recent commits).
- Shipping methods and locations endpoints use `LIMIT`/`OFFSET` pagination.
- `Promise.all()` is used throughout for parallel independent queries.

**Issues:**
- **SEO route has TTL=0.** `routes/seo.ts` line 14 sets `ttl: 0`, meaning cache middleware is applied but never actually caches. SEO settings rarely change -- this should use STANDARD TTL.
- **Storefront pages route uses hardcoded TTL.** `routes/pages.ts` line 18 uses `ttl: 3600` instead of `CACHE_TTLS.STANDARD`. Same in `routes/attributes.ts` and `routes/hero.ts`. This bypasses the centralized TTL system.
- **Duplicate query in admin search.** `routes/admin/search.ts` duplicates the exact same search logic as `routes/search.ts` (including the 5-second timeout pattern). Should share the implementation.
- **Payment settings fetch is not parallelized optimally.** `routes/admin/settings/payments.ts` line 88-91 calls `getActivePaymentMethods`, then sequentially calls `getStripeSettings`, `getSSLCommerzSettings`, `getPolarSettings`. These 3 gateway checks are independent and should be in a single `Promise.all()`.
- **Shipping methods admin list** has a second COUNT query that duplicates the WHERE clause. D1 doesn't support `SQL_CALC_FOUND_ROWS`, so this is unavoidable, but it should be documented as a known cost.

### 6. Feature Readiness -- 7/10

**Strengths:**
- **Multi-gateway payments** are fully wired: Stripe, SSLCommerz, Polar, COD -- each with session creation, webhook handling, and admin settings management. Deposit/balance partial payment patterns are implemented.
- **Multi-provider delivery** is architecture-ready: Pathao and Steadfast are implemented with a provider factory pattern. Adding new providers requires implementing the provider interface + registering in the factory.
- **RBAC is comprehensive.** `routes/admin/rbac.ts` handles roles CRUD, user role assignment, per-user permission overrides. `middleware/admin-auth.ts` enforces permissions per-route.
- **Widget history/versioning** is fully implemented with create, list, restore, and delete operations.
- **Checkout language customization** allows per-language field labels, placeholders, and field visibility toggles.
- **Queue-based notifications** support email (Resend) and push (FCM) per order status, with admin-configurable channels.
- **AI content generation** via OpenRouter is integrated with staged generation support for multi-section content.
- **Fraud checking** is pluggable with provider-based architecture.
- **Meta Conversions API** is fully wired with server-side event sending, admin settings, and log management.

**Issues:**
- **Admin search reindex is a stub** -- returns success but does nothing.
- **No customer-facing order cancellation.** Storefront order routes only support GET (lookup) and POST (create). Cancellation is admin-only.
- **No bulk import for delivery locations.** Only Pathao-specific import exists (`import-pathao`). A generic CSV/JSON import would improve onboarding.
- **Abandoned checkout recovery lacks automation.** The current system only saves/cleans up abandoned checkouts. There's no scheduled task or queue handler to send recovery emails/SMS.
- **No rate limiting on storefront order creation.** `routes/orders.ts` POST has no rate limit. A bot could flood the order queue. The abandoned checkout route has rate limiting but the actual order route does not.
- **OpenRouter API key is stored unencrypted** in the `settings` table (`routes/admin/settings/integrations.ts` line 70). Payment gateway secrets use `upsertEncryptedSetting`, but the OpenRouter key uses plain `upsertSetting`. Same issue with Resend API key in `system.ts` email settings.

---

## Critical Issues (Fix Now)

| # | File | Issue | Impact |
|---|------|-------|--------|
| 1 | `routes/hero.ts:109,119,203` | `JSON.parse()` without try-catch on DB column | Unhandled crash if slider images data is corrupted |
| 2 | `routes/header.ts:82`, `routes/footer.ts:90` | Same `JSON.parse()` without try-catch | Crashes storefront header/footer on corrupt config |
| 3 | `routes/orders.ts` POST | No rate limiting on order creation | Bot abuse can flood ORDER_INGEST_QUEUE |
| 4 | `routes/admin/settings/integrations.ts:70` | OpenRouter API key stored unencrypted | Inconsistent with encrypted payment keys; plaintext in DB |
| 5 | `routes/admin/settings/system.ts:262` | Resend API key stored unencrypted | Same issue as #4 |

## High-Priority Issues (Fix Soon)

| # | File | Issue | Impact |
|---|------|-------|--------|
| 6 | 15+ files | `as any` casts on OpenAPI route handlers | Defeats type safety system-wide |
| 7 | 15+ files | `new OpenAPIHono()` missing `<{ Bindings: Env }>` | Root cause of issue #6 |
| 8 | `routes/admin/settings/shipping.ts` | Full CRUD with inline Drizzle queries (436 lines) | Violates thin HTTP layer; logic not reusable |
| 9 | `routes/checkout-languages.ts` | Full CRUD with inline queries (452 lines) | Same as #8 |
| 10 | `routes/partytown-proxy.ts:100` | Regex constructed from user-configurable domain strings | Potential regex injection |
| 11 | `routes/seo.ts:14` | Cache TTL set to 0 | SEO data never cached; unnecessary D1 load |
| 12 | Multiple admin list routes | Missing `.max()` on `limit` query param | Clients can request unlimited rows |

## Medium-Priority Issues (Track)

| # | File | Issue |
|---|------|-------|
| 13 | `routes/admin/search.ts:97` | Reindex endpoint is a no-op stub |
| 14 | `routes/payment/sslcommerz-routes.ts:193-257` | 6 duplicate redirect handlers (3 GET + 3 POST with identical logic) |
| 15 | 8+ files | Try-catch-rethrow anti-pattern (catch and immediately rethrow) |
| 16 | `routes/admin/discounts.ts:260` | Inline DB update in route handler bypasses core service |
| 17 | `routes/admin/openrouter.ts:35` | OpenRouter model list fetched without caching |
| 18 | `routes/admin/ai-context.ts` | Batch endpoint has no size limit on product/category IDs |
| 19 | `routes/admin/settings/payments.ts:88-91` | Sequential gateway settings fetches should be parallel |
| 20 | Multiple files | Hardcoded TTL values instead of using `CACHE_TTLS` constants |
| 21 | Bulk operation routes | Inconsistent field names (`ids` vs `collectionIds` vs `pageIds`) |

---

## What's Done Well

1. **OpenAPI-first design.** Every single route (78+ mounts in `app.ts`) uses `@hono/zod-openapi` with `createRoute()`. This means the API is fully documented, type-validated, and generates Swagger UI at `/api/v1/docs`. Few production codebases achieve this level of API specification coverage.

2. **Response envelope discipline.** The `{ success: true, data: T }` contract is enforced through `ok()`, `created()`, `noContent()` helpers. No route manually constructs the envelope. `successEnvelope()` and `paginatedEnvelope()` schema helpers ensure OpenAPI docs match reality.

3. **Queue architecture.** The order processing pipeline (storefront POST -> 202 Accepted -> Queue -> Worker -> KV status -> Poll) is a best-practice async pattern for Cloudflare Workers. The queue consumer (`queue-consumer.ts`) properly dispatches by message type and handles payment events, notifications, and OTP delivery.

4. **Webhook security.** All 5 webhook routes (Stripe, SSLCommerz, Polar, Pathao, Steadfast) implement: (a) provider-specific signature verification, (b) KV-based idempotency dedup, (c) timing-safe comparison. The webhook auth middleware supports provider-specific strategies with IP allowlist fallback.

5. **Credential security.** Payment gateway secrets are AES-GCM encrypted in the DB via `upsertEncryptedSetting()`. All admin settings GET endpoints mask secrets with `MASKED_VALUE`, and PUT/POST endpoints handle the "masked value sent back" case by preserving existing credentials from the DB. The fraud checker and delivery provider routes follow this same pattern.

6. **RBAC middleware.** The three-tier admin auth chain (Better Auth session -> JWT -> Scanner token) with per-route permission checking via `getRoutePermission()` is clean and extensible. Role-based + per-user override permissions give fine-grained access control.

7. **Cache invalidation strategy.** The 9 named cache groups (products, categories, collections, pages, layout, homepage, checkout, search, attributes) with admin path-to-group mapping means saves automatically invalidate the right cached data. The storefront version bumping mechanism forces CDN cache busting on content changes.

8. **Thin HTTP layer pattern.** The majority of routes (collections, pages, widgets, categories, customers, products, navigation, discounts, attributes, orders) follow the pattern: validate input -> call `@scalius/core` service -> return response. Business logic stays in the core package where it's testable and reusable.

9. **Error handling hierarchy.** Custom error classes (`NotFoundError`, `ValidationError`, `ConflictError`, `ForbiddenError`, `RateLimitError`, `ServiceUnavailableError`) each map to the correct HTTP status code. The global error handler in `app.ts` catches everything and formats it as the standard error envelope.

10. **Soft-delete consistency.** Every entity that supports deletion follows the same pattern: soft-delete sets `deletedAt`, restore clears it, permanent delete removes the row. Bulk operations support both modes. The restore endpoints correctly avoid calling `getById` (which filters `deletedAt IS NULL`) before restoring.

---

## Architecture Notes

### File Inventory (86 source files)

- **Entry points:** `worker.ts`, `app.ts`, `queue-consumer.ts` (3)
- **Type definitions:** `env.d.ts`, `hono-env.d.ts` (2)
- **Middleware:** `auth.ts`, `admin-auth.ts`, `webhook-auth.ts`, `cache.ts` (4)
- **Utilities:** `api-error.ts`, `api-response.ts`, `jwt.ts`, `kv-cache.ts`, `cache-invalidation.ts`, `cache-ttls.ts`, `encryption-key.ts` (7)
- **Schemas:** `responses.ts`, `entities.ts` (2)
- **Storefront routes:** 20 files (products, categories, collections, orders, checkout, search, auth, customer-auth, discounts, widgets, analytics, navigation, storefront, cache, header, footer, pages, attributes, locations, shipping-methods, seo, meta-conversions, partytown-proxy, media-server, abandoned-checkouts, checkout-languages, hero)
- **Webhook routes:** 5 files (stripe, sslcommerz, polar, pathao, steadfast)
- **Payment routes:** 3 files (stripe-routes, sslcommerz-routes, polar-routes)
- **Admin routes:** 19 files + 9 settings sub-files = 28 (orders, orders-status, orders-refund, products, categories, collections, customers, discounts, pages, widgets, media, inventory, rbac, dashboard, auth-management, system-utils, search, shipments, analytics, fraud-checker, navigation, ai-context, ai-prompts, openrouter, attributes, settings hub, settings/site, settings/integrations, settings/payments, settings/system, settings/shipping, settings/delivery-providers, settings/hero-sliders, settings/meta-conversions-admin, settings/notification-channels, settings/delivery-locations)

### Route Mounting Order (from `app.ts`)
Webhooks are mounted BEFORE the admin auth middleware gate, which is the correct pattern -- webhooks use their own verification, not session auth. All `/admin/*` routes go through the RBAC permission middleware.

### Dual Env Type Definition
`env.d.ts` defines a global `Env` interface, and `hono-env.d.ts` extends Hono's `ContextVariableMap`. This separation is intentional (global CF bindings vs Hono context vars), but having `Env` defined in `env.d.ts` as a bare interface alongside Cloudflare's own `Env` type from `@cloudflare/workers-types` could cause confusion. Worth a clarifying comment.

---

## Recommendations Priority

### Quick Wins (< 1 hour each)
1. Add `<{ Bindings: Env }>` to all `new OpenAPIHono()` calls missing it, then remove the `as any` casts
2. Wrap all `JSON.parse()` calls on DB columns in try-catch with sensible defaults
3. Add `.max(100)` to all `limit` query parameters in list routes
4. Replace hardcoded TTL values with `CACHE_TTLS` constants
5. Set SEO route cache TTL to `CACHE_TTLS.STANDARD`

### Medium Effort (1-4 hours each)
6. Extract shipping methods CRUD into `@scalius/core/modules/shipping`
7. Extract checkout languages CRUD into `@scalius/core/modules/checkout-languages`
8. Extract hero sliders CRUD into `@scalius/core/modules/hero-sliders`
9. Encrypt OpenRouter API key and Resend API key using `upsertEncryptedSetting`
10. Add rate limiting to storefront order creation endpoint
11. Consolidate SSLCommerz redirect handlers (6 -> 3)
12. Remove try-catch-rethrow blocks in 8+ files

### Larger Refactors (track for later)
13. Standardize bulk operation field names across all routes
14. Add OpenRouter model list caching
15. Add size limits to AI context batch endpoint
16. Implement search reindex or remove the stub endpoint
