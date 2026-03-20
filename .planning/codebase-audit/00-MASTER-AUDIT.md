# Scalius Commerce — Master Codebase Audit

**Date:** 2026-03-20
**Scope:** 25 parallel agents analyzed 920+ source files across all apps and packages
**Goal:** Assess maintainability, code quality, architecture, scalability, robustness, and LLM-friendliness before unified SDK work

---

## Executive Summary

**Overall Grade: B+** — Strong architectural foundations with a clean monorepo structure, consistent patterns in most domains, and excellent dev tooling. The main debt is at the consumer boundary (SDK types, response envelope handling, manual fetch calls) — exactly where the upcoming unified SDK will deliver the most value.

**By the numbers:**
- **25 domain audits** completed
- **~120 issues** identified across all domains
- **8 critical/P1** issues (broken functionality or security)
- **~45 major/P2** issues (should fix before SDK work)
- **~67 minor/P3** issues (improve over time)
- **Average LLM-Friendliness: 8/10**

---

## Critical Issues (P1 — Fix Immediately)

### Security
| # | Domain | Issue | Report |
|---|--------|-------|--------|
| C1 | Auth | `API_TOKEN` default fallback lacks production guard — attacker knowing default string can generate system JWT tokens | 03 |
| C2 | Notifications | `process.env.NODE_ENV` used in Cloudflare Worker — either throws or leaks debug info in production | 17 |
| C3 | Storefront | `POST /abandoned-checkouts` has zero authentication — anyone can flood the table | 19 |

### Broken Functionality
| # | Domain | Issue | Report |
|---|--------|-------|--------|
| C4 | Fraud Checker | `FraudCheckIndicator` calls `POST /admin/fraud-checker/lookup` which doesn't exist — feature completely non-functional | 18 |
| C5 | Fraud Checker | Delete and test operations use wrong URL paths — both 404 | 18 |
| C6 | Notifications | FCM invalid token cleanup SQL is broken — `IN ${array}` binds as single param instead of expanding | 17 |
| C7 | Notifications | `logRetentionDays` admin setting is dead — hardcoded 12h constant always wins | 17 |
| C8 | Content | Public `GET /pages/{id}` doesn't check `isPublished` — draft pages exposed publicly | 16 |

---

## Systemic Patterns (Issues Appearing Across Multiple Domains)

### 1. Module-Level `db` Singleton (7+ routes)
**Impact:** Stale D1 binding in Cloudflare Workers where env is per-request.
**Files:** `routes/auth.ts`, `routes/header.ts`, `routes/footer.ts`, `routes/categories.ts`, `routes/navigation.ts`, `admin/settings/payments.ts`, `admin/settings/hero-sliders.ts`, `delivery/providers/pathao.ts`
**Fix:** Replace all `import { db }` with `c.get("db")` from Hono context.
**Reports:** 04, 12, 14, 16, 19, 20

### 2. Missing Input Validation on Save Routes
**Impact:** Raw `c.req.json()` written to DB without Zod validation.
**Files:** Stripe/SSLCommerz/Polar settings saves, discount service `Record<string, unknown>`, analytics service params
**Fix:** Add Zod schemas to all save endpoints, type service params.
**Reports:** 11, 14, 17

### 3. Module-Level Mutable State
**Impact:** Cross-request state leakage on Cloudflare Workers isolate reuse.
**Instances:** 15 identified — `_requestHeaders` in admin api-server, JWT singleton in storefront, FCM credential cache, rate-limit Maps, layout cache, R2 bucket globals
**Fix:** Move to request-scoped context or KV.
**Reports:** 02, 04, 15, 21, 22

### 4. Inconsistent Timestamp Generation
**Impact:** Mixed `new Date()` (JS runtime) vs `sql`unixepoch()`` (DB-level) for integer timestamp columns.
**Affected:** Customer profile update, discount operations, 6+ settings saves
**Fix:** Standardize on `sql`unixepoch()`` for all DB writes.
**Reports:** 10, 11, 14

### 5. Plaintext Credentials (Inconsistent Encryption)
**Impact:** Delivery providers use AES-GCM encryption. Payment gateways, OpenRouter, and fraud checker store keys in plaintext.
**Fix:** Extend credential encryption to all provider types.
**Reports:** 08, 18

### 6. Duplicated Logic Across Layers
**Impact:** Maintenance burden, drift risk.
**Instances:** Collection product resolution (~300 lines), analytics tracking (core vs storefront), storefront proxy envelope unwrapping (4 checkout endpoints), admin/storefront type definitions (668 + 524 lines)
**Fix:** Extract to core services; unified SDK will address type duplication.
**Reports:** 13, 17, 19, 25

### 7. Error Response Format Inconsistency
**Impact:** Consumers can't reliably parse errors.
**Detail:** Auth middleware returns `{ error: "string" }`, global handler returns `{ error: { code, message } }`, some routes return `{ success: false, error: "string" }`
**Fix:** Standardize all error responses through the global error handler.
**Reports:** 20, 23

---

## Major Issues by Domain (P2 — Fix Before SDK Work)

### Orders (Report 06)
- Admin UI double-counts shipping/discount in total display
- `updateOrder` applies inventory before CAS check — no rollback on failure
- Client-submitted per-item prices stored without server verification
- `bulkShipOrders` skips optimistic locking and state machine validation
- Queue batch fails all orders when one has insufficient stock

### Inventory (Report 07)
- No `deducted -> cancelled/returned` transition — shipped returns lose stock silently
- `stock-adjustment.ts` lacks CAS protection — stale movement audit logs under concurrency
- Low-stock alerts never auto-resolve on positive adjustments

### Payments (Report 08)
- Refund records never inserted into `orderPayments` — cumulative over-refund protection broken for multi-refund
- No UNIQUE constraint on gateway payment IDs (TOCTOU gap)
- `processPaymentFailed()` silently swallows errors

### Products (Report 05)
- Storefront discount filter ignores flat-amount discounts completely
- Phantom default variant with hardcoded `stock: 100` for variantless products
- Error matching uses fragile `message.includes("slug")` instead of `instanceof`

### Delivery (Report 09)
- Encryption key never threaded to shipment creation or webhook auth — enabling encryption breaks both
- No idempotency on shipment creation (double-click = duplicate courier orders)
- `checkShipmentStatus` casts null `externalId` to string

### Discounts (Report 11)
- Race condition in `maxUses` counting (SELECT then compare, no atomic guard)
- Ghost `recordDiscountUsage()` endpoint — storefront calls route that doesn't exist
- Identity mismatch: eligibility checks by phone, queue checks by customerId

### Categories/Attributes (Report 12)
- `listAttributeValues` loads ALL rows then paginates in JavaScript
- Missing index on `productAttributeValues.attributeId`
- `getCategoryEditData` fetches up to 999 categories to find one by ID

### Database (Report 01)
- 8 boolean columns missing `notNull()` (NULL third-state)
- `products.slug`, `pages.slug`, `categories.slug` lack UNIQUE constraints
- 18 JSON-in-text columns with undocumented shapes

### Media (Report 15)
- File size limit mismatch: service allows 20MB, storage enforces 10MB
- Upload route 207 status code branch unreachable (HTTP always 200/201)

### Auth (Report 03)
- Token blacklist fails open on KV errors (revoked tokens accepted)
- Email verification disabled for admin accounts
- Setup endpoint re-exposed if database wiped

---

## SDK Readiness Assessment (Report 25)

**Current state:** SDK is completely hollow — all 24 type exports are `any`, methods file empty, client is a no-op.

**Consumer debt:**
- Admin: 267 raw fetch calls + 668-line manual type file + 68 files importing `unwrapEnvelope`
- Storefront: 20 API modules with 524-line manual type file + inline envelope parsing

**Blockers for unified SDK:**
1. **Admin proxy envelope rewriting** (`{ success, data: T }` -> `{ success, ...T }`) creates a unique shape no generated SDK would produce
2. **No OpenAPI response schemas** on any route — request schemas are typed but responses are description-only strings
3. **328 endpoints** across 62 route files need response type annotations

**Recommended SDK roadmap:**
1. Add OpenAPI response schemas to all routes (enables type generation)
2. Generate real types from live OpenAPI spec
3. Build transport-agnostic client factory (service binding + HTTP)
4. Migrate admin off the envelope-rewriting proxy
5. Replace hand-written fetch calls with SDK methods
6. Automate SDK regeneration in CI

---

## Architecture Strengths

These are genuinely well-done and should be preserved:

1. **Response envelope consistency** — `ok()`/`created()` used 271 times across 59 route files
2. **Error class hierarchy** — clean `ApiError` classes with 274 usages across 45 files
3. **Import boundaries** — storefront has zero imports from `@scalius/core` or `@scalius/database`
4. **Inventory CAS** — `stockVersion` separate from metadata `version`, correct reasoning
5. **Atomic payment processing** — `db.batch()` for payment + order + inventory in one D1 round-trip
6. **Two-layer storefront caching** — L1 in-memory + L2 Cloudflare Cache API with KV-versioned invalidation
7. **Queue architecture** — proper DLQ, retry backoff, batch processing for order ingest
8. **Route consistency** — every API file follows the same OpenAPIHono `createRoute()` template
9. **Reservation batch atomicity** — validate-all-then-batch-write with full rollback
10. **Dev experience** — one-command setup, zombie process cleanup, staggered ports

---

## LLM-Friendliness Assessment

**Average score: 8/10** across all domains.

**What makes this codebase LLM-friendly:**
- Consistent file naming: `{domain}.service.ts`, `{domain}.validation.ts`, `{domain}.admin.ts`
- Predictable recipe for adding new features (5-6 files in a known sequence)
- Clean module boundaries with explicit index exports
- Self-documenting function names in most services
- CLAUDE.md is comprehensive and accurate (with minor corrections needed)

**What to improve for LLM-friendliness:**
- 18 JSON-in-text columns with undocumented shapes (LLMs can't infer structure)
- Dual provider system (universal registry vs legacy interfaces) creates ambiguity
- Admin proxy envelope rewriting is a hidden transformation an LLM would miss
- Some long functions (861-line orders route) need decomposition
- `Record<string, unknown>` parameters defeat type inference

---

## Prioritized Action Plan

### Phase 0: Critical Fixes (Before Any Other Work)
1. Add production guard to `API_TOKEN` default fallback
2. Fix `process.env.NODE_ENV` in notifications Worker code
3. Add auth to `POST /abandoned-checkouts`
4. Fix fraud checker URL mismatches (or remove dead UI)
5. Fix FCM `IN` SQL expansion
6. Add `isPublished` check to public pages endpoint

### Phase 1: Systemic Cleanup (Foundation for SDK)
1. Replace all 7+ module-level `db` imports with `c.get("db")`
2. Add Zod validation to all unvalidated save routes
3. Standardize error response format across all middleware
4. Standardize timestamps on `sql`unixepoch()``
5. Add `notNull()` to 8 boolean columns + UNIQUE to slug columns
6. Add missing indexes (productAttributeValues.attributeId, deliveryShipments.orderId/externalId)

### Phase 2: Domain Fixes (Business Logic Correctness)
1. Add `deducted -> cancelled/returned` inventory transition
2. Fix order total double-counting in admin UI
3. Fix `updateOrder` CAS-before-inventory ordering
4. Add refund row insertion to `orderPayments`
5. Fix discount maxUses race condition (atomic increment)
6. Fix storefront flat-discount filter
7. Thread encryption key to delivery shipment/webhook paths
8. Add shipment creation idempotency

### Phase 3: SDK Enablement
1. Add OpenAPI response schemas to all 328 endpoints
2. Generate real SDK types from live spec
3. Build transport-agnostic client factory
4. Migrate admin off envelope-rewriting proxy
5. Replace 267 admin fetch calls + 20 storefront API modules with SDK

### Phase 4: Quality Polish
1. Extract duplicated logic (collection resolution, analytics tracking)
2. Move module-level mutable state to request scope
3. Add Astro 404/500 error pages to both apps
4. Extend credential encryption to all providers
5. Add L1 cache size limits in storefront
6. Split 861-line orders route

---

## CLAUDE.md Corrections Needed

Based on audit findings, these CLAUDE.md items need updating:
- **`any` count**: Says ~250, actual count is 27 (per admin architecture audit)
- **SDK state**: Says "60 paths from old spec" — SDK is actually completely hollow (all types are `any`)
- **Module-level db**: Not documented as an anti-pattern to avoid
- **Response schema**: Should note that OpenAPI response schemas are missing (request-only)

---

*Generated by 25 parallel analysis agents on 2026-03-20*
*Individual reports: `.planning/codebase-audit/01-25`*
