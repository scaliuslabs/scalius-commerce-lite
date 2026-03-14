# Scalius Commerce — Project Goals & Progress Tracker

## Vision

Build the most maintainable, reliable, and extensible open-source commerce platform. Designed for thousands of contributors (human and AI) to build hundreds of features with zero ambiguity about patterns or conventions.

## Guiding Principles

1. **Zero ambiguity** — Every pattern has one correct way. No "it depends."
2. **Database enforces truth** — FK constraints, indexes, enums validated at DB level, not just application code.
3. **Fail loudly** — No silent error swallowing. Every failure path is explicit and observable.
4. **Extensibility through interfaces** — New payment/email/delivery/SMS providers are plug-and-play via registry pattern.
5. **Type safety end-to-end** — From DB schema → core service → API route → SDK → frontend component.
6. **Test everything that matters** — Core business logic has comprehensive coverage (private test suite).
7. **LLM-friendly code** — Clear naming, consistent patterns, self-documenting structure. Any contributor (human or AI) can understand a module in isolation.

## Current State (2026-03-15)

| Metric | Value |
|--------|-------|
| Workers | 3 (Admin, API, Storefront) |
| Packages | 5 (core, database, shared, api-client, tsconfig) |
| DB Tables | ~50+ |
| API Routes | 54+ |
| RBAC Permissions | 74 across 14 categories |
| Payment Gateways | 3 (Stripe, SSLCommerz, Polar) + COD |
| Delivery Providers | 2 (Pathao, Steadfast) |
| Email Providers | 1 (Resend) |
| SMS Providers | 0 |
| Test Files | 0 |
| SDK Status | Deleted (was 73% stale — 60/221 endpoints) |

## Future Roadmap (Informs Architecture Decisions)

- 5-7 more payment gateways (global + local markets)
- Multiple email providers (SendGrid, Mailgun, SES, etc.)
- Multiple delivery providers (global + local logistics)
- Mobile SMS providers (Twilio, local gateways)
- WhatsApp Business API providers
- New admin dashboard (Svelte/SolidJS/Next.js SPA — separate team, months away)
- Hundreds/thousands of contributors (human + AI agents)

---

## Phase 1: Foundation — Database & Data Integrity

> Goal: The database enforces correctness. No orphaned records, no missing indexes, no ambiguous schemas.

### 1.1 Foreign Key Constraints

- [x] `products.categoryId` → FK to `categories.id` (set null on delete)
- [x] `productImages.productId` → FK to `products.id` (cascade)
- [x] `productVariants.productId` → FK to `products.id` (cascade)
- [x] `orderItems.productId` → FK to `products.id` (set null — preserve history)
- [x] `orderItems.variantId` → FK to `productVariants.id` (set null — preserve history)
- [x] `inventoryMovements.variantId` → FK to `productVariants.id` (set null)
- [x] `inventoryMovements.orderId` → FK to `orders.id` (set null)
- [x] `deliveryLocations.parentId` → self-referential FK (set null)
- [x] `deliveryShipments.providerId` → FK to `deliveryProviders.id` (set null)
- [x] `media.folderId` → FK to `mediaFolders.id` (set null)
- [x] `productLowStockAlerts.variantId` → FK to `productVariants.id` (cascade)
- [x] `productLowStockAlerts.productId` → FK to `products.id` (cascade)
- [x] `discountProducts.productId` → FK to `products.id` (cascade)
- [x] `discountCollections.collectionId` → FK to `collections.id` (cascade)

### 1.2 Missing Indexes

- [x] `session.userId` — auth session lookups
- [x] `account.userId` — account lookups
- [x] `verification.identifier` — OTP/verification lookups
- [x] `customers.email` — customer search
- [x] `discounts.code` — discount code lookup (critical for checkout)
- [x] `adminFcmTokens.userId` — device lookup per user
- [x] `customerHistory.customerId` — audit trail queries
- [x] `discountUsage.(discountId, customerId)` — usage limit enforcement
- [x] `widgetHistory.widgetId` — version lookup
- [x] `productAttributeValues.(productId)` — attribute joins
- [x] `productRichContent.productId` — content per product
- [x] `deliveryShipments.(providerId, status)` — shipment queries
- [x] Composite `(isActive, deletedAt)` on soft-delete tables (products, categories, collections, pages, widgets, discounts, shippingMethods)

### 1.3 Schema Consistency

- [ ] Standardize timestamp defaults across ALL schema files (pick one: `CURRENT_TIMESTAMP` or `cast(strftime('%s','now') as int)`)
- [ ] Add singleton constraint to `siteSettings` (only 1 row allowed)
- [ ] Add singleton constraint to `metaConversionsSettings`
- [ ] Fix `collections.type` enum — replace `"collection1"`/`"collection2"` with semantic names
- [ ] Fix `discountProducts.applicationType` enum — document or add missing values beyond `"get"`
- [ ] Resolve discount field duplication (both `products` and `productVariants` have discount fields — define clear precedence rule and document it)
- [ ] Add `deletedAt` to `productImages` for soft-delete consistency
- [ ] Add `updatedAt` to `permissions` table
- [ ] Add `updatedAt` to `twoFactor` table
- [ ] Document denormalization strategy (why customer/product data is copied to orders — intentional for order history preservation)
- [ ] Add `widgets.displayTarget` enum values beyond just `"homepage"`

---

## Phase 2: API Consistency & Response Contract

> Goal: Every API response follows the exact same pattern. No consumer ever has to guess the shape.

### 2.1 Response Envelope Standardization

All routes MUST use `ok()`, `created()`, `noContent()` from `api-response.ts`. Zero raw `c.json()`.

- [x] Customer auth routes (6 routes in `routes/customer-auth.ts`) — converted to `ok()` + ApiError throws
- [x] Payment intent routes (3 routes: stripe, sslcommerz, polar) — errors now throw ApiError subclasses
- [x] Webhook routes (5 routes) — kept as-is (external services expect specific formats)
- [x] Order creation (POST `/orders`) — errors now throw ValidationError
- [x] Order status polling — wrapped in `{ success, data }` envelope
- [x] Auth token revoke — converted to throw UnauthorizedError
- [ ] Remove or implement unused `paginated()` helper
- [ ] Audit and convert remaining `c.json()` calls across all route files

### 2.2 Cache TTL Fixes

- [x] `routes/categories.ts:23` — fixed `3600000` → `3600`
- [x] `routes/orders.ts:34` — fixed `2592000` → `300`
- [x] `routes/hero.ts` — fixed `3600000` → `3600`
- [x] `routes/locations.ts` — fixed `600000` → `600`
- [x] `routes/shipping-methods.ts` — fixed `300000` → `300`
- [x] `routes/storefront.ts` — fixed `3600000` → `3600` (3 instances)
- [x] `routes/checkout.ts` — fixed `60000` → `60`
- [x] Created centralized `CACHE_TTLS` constant in `apps/api/src/utils/cache-ttls.ts`
- [ ] Migrate route files to import from `CACHE_TTLS` instead of inline numbers
- [ ] Document cache strategy: which resources get what TTL and why

### 2.3 Error Handling Consistency

- [ ] All routes throw `ApiError` subclasses for errors — no raw `c.json({ error: ... })`
- [ ] Error `details` field: change from `unknown` to strictly typed union
- [ ] Remove unsafe type assertions in error handling (e.g., `error as { message? }`)
- [ ] Extract webhook signature verification into reusable middleware (currently duplicated per gateway)

---

## Phase 3: Core Business Logic Reliability

> Goal: Every business operation is atomic, idempotent, and handles edge cases. No partial state, no race conditions, no data corruption.

### 3.1 Order System

- [x] Wrap order creation in database transaction (`db.batch()` for atomicity)
- [x] Implement order status state machine (`order-state-machine.ts`) with `canTransitionTo()` validation
- [x] Define valid transitions as const maps for order status, payment status, fulfillment status
- [x] Add optimistic locking to order updates (`version` column, CAS on update, ConflictError on mismatch)
- [x] **CRITICAL**: Enforce state machine in `processPaymentConfirmed()` — validateTransition() added
- [x] **CRITICAL**: Fix race condition in `updateOrderStatus()` — CAS runs before inventory now
- [x] **CRITICAL**: Wire `reserveStockBatch()` into `orders.queue.ts` (replaces sequential `reserveMultiple()`)
- [x] **CRITICAL**: Wire `releaseExpiredReservations()` into scheduled worker (15-min cron)
- [x] Add notification queue messages on order status changes (shipped, delivered)
- [ ] Handle partial payment edge case: if customer pays 50% then comes back days later, verify inventory still reserved
- [ ] Add idempotency keys to all order mutations (prevent duplicate orders from retry)

### 3.2 Inventory System

- [x] Fix multi-variant reservation — `reserveStockBatch()` with `db.batch()` for all-or-nothing
- [x] Validate `backorderLimit >= 0` (`validateBackorderLimit()`)
- [x] Validate final price >= 0 after discount (`calculateFinalPrice()`)
- [x] Validate `stock >= 0` on variant creation (`validateStockNonNegative()`)
- [ ] Separate `stockVersion` from general `version` field (price changes shouldn't break stock operations)
- [x] Make low-stock alerts observable — `checkAndAlertLowStock()` now returns `LowStockAlertResult`
- [x] Add reservation expiry — `releaseExpiredReservations()` with configurable timeout

### 3.3 Payment System

- [x] **CRITICAL**: Fix `processPaymentConfirmed()` idempotency — duplicate check moved to first operation
- [ ] Add webhook retry logic: queue unprocessed webhooks, exponential backoff (3 retries)
- [ ] Standardize idempotency across ALL gateways (Stripe, SSLCommerz, Polar, COD, future gateways)
- [ ] Fix refund double-processing: check existing refund record before processing (prevent inventory over-release)
- [ ] Handle partial payment + fulfillment timing (don't start fulfillment until fully paid, or explicitly support split-ship)
- [ ] Add COD idempotency (prevent double-recording of cash collection)
- [ ] Add payment timeout handling (what happens if customer abandons Stripe checkout after intent created?)
- [ ] Add chargeback status to PaymentStatus enum (DISPUTED, CHARGEBACK)
- [ ] Handle Stripe `charge.dispute.created` webhook event

### 3.4 Discount System

- [ ] Cart-level validation: BOGO discount must validate that required products are actually in cart
- [ ] Define and enforce discount stacking/combination rules explicitly (can two discounts apply to same order? document the answer)
- [ ] Fix usage limit race condition: use atomic increment (not read-then-write) for concurrent discount applies
- [ ] Add fraud audit trail per discount usage (userId, orderId, timestamp, amount saved)
- [ ] Validate discount dates at application time (not just at creation)

### 3.5 Customer System

- [ ] Standardize phone number normalization (single entry point, always formatted before storage)
- [ ] Handle OTP queue failure (retry mechanism, or synchronous fallback)
- [ ] Materialize customer stats as background job (not recalculated on every read)
- [ ] Add customer merge capability (when same person has multiple records via email + phone)

### 3.6 Delivery System

- [ ] Atomic shipment creation: provider API call + local DB insert in single logical operation (compensating action if one fails)
- [ ] Cache provider auth tokens in KV (survive Worker isolate restarts)
- [ ] Add rate limiting for external provider API calls
- [ ] Add circuit breaker for provider health (if provider API down, fail fast instead of timeout)
- [ ] Encrypt credentials at rest (delivery provider API keys)

### 3.7 Pages / CMS

- [ ] Add HTML sanitization for page content before storage (prevent stored XSS)
- [ ] Handle slug collision on update (check uniqueness, return clear error)

### 3.8 Media

- [ ] Prevent folder deletion when files exist inside (or cascade with confirmation)
- [ ] Add file type validation beyond MIME (magic bytes check)

---

## Phase 4: Architecture & Extensibility

> Goal: Adding a new payment gateway, email provider, or delivery service is a single-file operation with zero modifications to existing code.

### 4.1 Provider Registry Architecture

Design a universal provider pattern used consistently across ALL provider types:

- [x] `PaymentProvider` interface — `createPayment`, `createRefund`, `verifyWebhook`, `getPublicConfig` + `ProviderLifecycle`
- [x] `EmailProvider` interface — `sendEmail`, optional `sendTemplated` + `ProviderLifecycle`
- [x] `DeliveryProvider` interface — `createShipment`, `trackShipment`, `cancelShipment`, `calculateRate` + `ProviderLifecycle`
- [x] `SMSProvider` interface — new: `sendSMS`, `sendTemplate`, `getDeliveryStatus` + `ProviderLifecycle`
- [ ] `WhatsAppProvider` interface — new (sendTemplate, sendMessage)
- [x] Universal provider registry (`registerProvider`, `getProvider`, `getActiveProviders`, `isProviderRegistered`)
- [x] Per-provider Zod settings schema (validated at instantiation via registry)
- [x] Provider health check via `ProviderLifecycle.healthCheck()` interface
- [ ] Provider credential encryption at rest
- [ ] Provider error classification (retryable vs permanent)
- [x] Stripe adapter — proof-of-concept wrapping existing code behind new interface
- [x] Resend adapter — proof-of-concept wrapping existing code behind new interface
- [x] Implementation guides — HOW TO ADD A NEW PROVIDER comment blocks in each type file

### 4.2 Distributed Systems

- [ ] Replace in-memory rate limiter (`packages/shared/rate-limit.ts`) with KV-based implementation
- [ ] Replace in-memory layout cache (`packages/shared/layout-cache.ts`) with KV-based
- [ ] Implement granular cache invalidation (per resource ID, not broad prefix wipe)
- [ ] Automatic admin-path→cache-group mapping (instead of manual `ADMIN_PATH_TO_GROUPS` dict)

### 4.3 Search Improvements

- [ ] Add relevance ranking to FTS5 results (rank by match quality)
- [ ] Add FTS5 sync health monitoring (detect when triggers are broken/stale)
- [ ] Support prefix + infix matching for better search UX

### 4.4 Data Integrity

- [ ] Make variant SKU globally unique (not just per-product)
- [ ] Add database triggers or application hooks for customer stats materialization
- [ ] Add `CHECK` constraints where valuable (e.g., `stock >= 0`, `price >= 0`)

---

## Phase 5: Security Hardening

> Goal: No stored XSS, no credential exposure, no enumeration attacks. Defense in depth.

- [ ] HTML sanitization for all user-generated content (CMS pages, widget HTML)
- [ ] Encrypt payment gateway credentials at rest
- [ ] Encrypt delivery provider credentials at rest
- [ ] Extract webhook signature verification into shared middleware
- [ ] Replace `Math.random()` in `generateOrderId()` with `crypto.getRandomValues()`
- [ ] Audit analytics script injection (arbitrary JS stored in `analytics.config`)
- [ ] Add rate limiting to all public-facing mutation endpoints
- [ ] Review CORS configuration for production tightness

---

## Phase 6: Code Quality & Consistency

> Goal: Any contributor can open any file and immediately understand the pattern. Zero confusion.

### 6.1 Admin App

- [x] Consolidate `product-form/` and `ProductForm/` directories (variants moved, ProductForm deleted)
- [x] Delete duplicate MediaManager.tsx and MediaManagerPage.tsx (11 imports updated to media-manager/)
- [x] Delete unused ui/ShipmentStatusBadge.tsx (keep admin/ version)
- [ ] Split `AdminLayout.astro` (606 lines) into `LayoutNavigation`, `LayoutHeader`, `LayoutSidebar`, `LayoutTheme`
- [ ] Split `middleware.ts` (352 lines) — extract RBAC checking into `lib/rbac.ts`
- [ ] Audit and fix 251 `any` type usages
- [ ] Standardize data fetching pattern (document when to use loaders vs component-level fetch)
- [ ] Add React error boundaries to all major page sections
- [ ] Standardize hook async patterns (pick one: promise chains OR useEffect)

### 6.2 Storefront

- [ ] Fix order status polling response format inconsistency
- [ ] Fix discount endpoint error handling inconsistency

### 6.3 Shared Package

- [ ] Make phone validation locale-configurable (not hardcoded to Bangladesh `01XXXXXXXXX`)
- [ ] Make default currency configurable (not hardcoded BDT)
- [ ] Replace `Math.random()` with crypto-safe random in `generateOrderId()`

### 6.4 TypeScript Strictness

- [ ] Add `noUncheckedIndexedAccess` to base tsconfig
- [ ] Remove redundant options in `astro.json` tsconfig
- [ ] Configure ESLint with production rules (`eslint.config.js`)

### 6.5 Permission Query Optimization

- [ ] Refactor `getUserPermissions()` from 3 queries to 1 query with JOINs

---

## Phase 7: Testing Infrastructure

> Goal: Private, centralized test suite that validates all critical business logic. Not public.

### 7.1 Setup

- [x] Create centralized `tests/` directory (gitignored — private to core team)
- [ ] Configure vitest to discover tests from `tests/`
- [ ] Set up test database utilities (in-memory D1 or test fixtures)

### 7.2 Core Service Tests

- [ ] Order lifecycle tests (create → pay → fulfill → deliver → return)
- [ ] Inventory reservation/deduction/release tests
- [ ] Payment processing tests (all gateways)
- [ ] Discount application + validation tests
- [ ] Customer CRUD + stats tests
- [ ] RBAC permission resolution tests

### 7.3 API Integration Tests

- [ ] Response envelope consistency (every route returns `{ success, data }`)
- [ ] Auth middleware tests (admin, customer, service token)
- [ ] Error response format tests

### 7.4 Edge Case Tests

- [ ] Concurrent inventory reservation
- [ ] Discount usage limit under concurrency
- [ ] Order status invalid transition attempts
- [ ] Payment webhook replay/deduplication
- [ ] Partial payment scenarios

---

## Phase 8: SDK & API Documentation

> Goal: Type-safe SDK covering 100% of API surface. Generated, not hand-maintained.

- [x] Delete stale SDK (was 60/221 endpoints — 73% missing)
- [ ] Stabilize API surface (after Phase 1-4 work completes)
- [ ] Regenerate SDK from live OpenAPI spec (`pnpm generate:sdk`)
- [ ] Export clean domain types (Product, Order, Customer — not just response wrappers)
- [ ] Add SDK usage examples in package README

---

## Phase 9: Scale Preparation

> Goal: Any contributor can add a feature without reading the entire codebase.

- [ ] Update CLAUDE.md with all finalized patterns and conventions
- [ ] Create contributor guide: "How to add a new payment gateway" (step-by-step)
- [ ] Create contributor guide: "How to add a new API endpoint" (step-by-step)
- [ ] Create contributor guide: "How to add a new delivery provider" (step-by-step)
- [ ] Performance baselines (response times, build times — for regression detection)
- [ ] CI/CD pipeline: typecheck + lint + test on every PR

---

## Phase 10: Admin Orders & Delivery Completeness

> Goal: Admin orders pages cover every operational workflow. Delivery providers match actual API specs. New providers are plug-and-play.

### 10.1 Delivery Provider Fixes
- [ ] Fix Pathao webhook: return 202 + `X-Pathao-Merchant-Webhook-Integration-Secret` header
- [ ] Fix Pathao webhook: parse `event` field instead of `order_status_slug`
- [ ] Fix Pathao webhook: check `X-PATHAO-Signature` header (not `X-Webhook-Signature`)
- [ ] Fix Steadfast webhook: check `Authorization: Bearer` header (not HMAC)
- [ ] Fix Steadfast webhook: parse `notification_type` field
- [ ] Fix status-mapper.ts: explicit event→status map (no brittle `includes()`)
- [ ] Add webhook URL display + secret config to admin delivery settings UI
- [ ] Implement RedX delivery provider (provider, webhook, status mapping, admin UI)

### 10.2 Admin Order List Missing Features
- [ ] Bulk status change (can bulk ship but not bulk change status)
- [ ] CSV export full results (currently only exports current page)
- [ ] Fraud check indicator on order detail page (currently only in list view)

### 10.3 Admin Order Detail Missing Features
- [ ] **Order timeline/audit log** — show status changes with timestamps and who made the change
- [ ] **Print invoice/packing slip** — essential for fulfillment workflow
- [ ] **Manual payment recording** — admin can see payments but can't record offline payments
- [ ] **Order notes editor** — currently read-only, need edit + add capability
- [ ] **Duplicate order button** — quick order recreation
- [ ] Manual tracking number entry (currently auto-synced from provider only)
- [ ] Delivery status auto-sync (currently manual refresh only)

---

## Decision Log

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-15 | Delete stale SDK, defer regeneration | API surface will change significantly with Phase 1-4 work. Regenerate after stabilization. |
| 2026-03-15 | Tests are private (gitignored) | Only core team (2-3 people) maintains tests. Not pushed to public repo. |
| 2026-03-15 | Fix database first, then API, then business logic | FK constraints and indexes are prerequisite for reliable business logic. |
| 2026-03-15 | Provider architecture before adding new gateways | Design the interface once, then all new providers implement it consistently. |
