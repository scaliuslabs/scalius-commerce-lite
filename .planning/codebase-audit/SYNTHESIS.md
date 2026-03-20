# Codebase Audit Synthesis

**Date:** 2026-03-20
**Scope:** 25 parallel agents analyzed 917 source files across the entire monorepo
**Branch:** mono-repo
**Overall Health:** 7/10 — solid architecture, strong conventions, but systemic patterns need fixing before SDK work

---

## Executive Summary

The codebase has a **strong architectural foundation** — consistent import conventions, well-separated domain modules, good package boundaries, and a comprehensive CLAUDE.md. The recent hardening effort (242 route conversions) shows. However, the audit revealed **~150 issues across 25 domains**, with several **systemic patterns** that recur throughout the codebase. Fixing these patterns holistically (not per-domain) will yield the highest ROI before SDK generation.

---

## Systemic Patterns (Fix These First)

These patterns recur across 5+ domains. Fixing the pattern once eliminates entire categories of bugs.

### P1. Timestamp Corruption — `new Date()` and `CURRENT_TIMESTAMP` in Integer Columns

**Affected domains:** Collections, Analytics, Delivery Locations, Settings (hero sliders)
**Impact:** Dates render as year ~56000–65000 in storefront/admin

The database stores Unix epoch **seconds** (integer columns). Several services write `new Date()` (milliseconds) or use `CURRENT_TIMESTAMP` (ISO string) instead of `sql\`unixepoch()\``. When the storefront multiplies by 1000 for display, the bug compounds.

**Root cause:** No shared timestamp utility. Each domain handles timestamps independently.
**Fix:** Create `@scalius/shared/timestamps.ts` with `nowUnix()`, enforce via lint rule or grep in CI. Audit all `new Date()` and `CURRENT_TIMESTAMP` usage in services.

### P2. Response Envelope Double-Wrapping

**Affected domains:** Inventory, Discounts, Customers, Media, Products (storefront fake variant)
**Impact:** Consumers get `{ success: true, data: { success: true, data: ... } }` — breaks SDK parsing

Services return `{ success: true, ... }` which gets wrapped again by `ok(c, result)` producing double-wrapped envelopes. This is the #1 production bug pattern per project memory.

**Root cause:** No TypeScript enforcement that `ok()` payload must not contain `success` key.
**Fix:** Add a branded type or runtime assertion in `ok()` that rejects payloads with a `success` property. Audit all service return types.

### P3. Thin HTTP Layer Violations — Inline DB Queries in Routes

**Affected domains:** Categories (466 lines), Attributes (389 lines), Pages, Navigation, Settings (7 files), 11+ storefront API routes
**Impact:** Business logic duplicated between admin and public routes, untestable, inconsistent behavior

Public/storefront routes contain full Drizzle query logic instead of delegating to `@scalius/core` services. This means the same entity has different query behavior depending on which route serves it.

**Root cause:** Public routes were written before the service layer pattern was established.
**Fix:** Extract inline queries into `{domain}.storefront.ts` or `{domain}.public.ts` services in `@scalius/core`. Routes become thin wrappers.

### P4. `z.any()` in OpenAPI Schemas — Defeats SDK Codegen

**Affected domains:** Navigation, Widgets, Storefront module, Settings, multiple timestamp fields
**Impact:** Generated SDK types become `unknown` instead of typed — destroys the value of the SDK

Using `z.any()` in response schemas produces `any`/`unknown` in the OpenAPI spec, which propagates to every SDK consumer as untyped responses.

**Root cause:** Complex nested types (JSON configs, widget content) are hard to express in Zod.
**Fix:** Replace `z.any()` with specific schemas (even `z.record(z.unknown())` is better). For JSON config blobs, define known-shape schemas. This is **blocking for SDK quality**.

### P5. Error Handler Property Mismatch — `err.statusCode` vs `err.status`

**Affected domains:** Categories, Discounts, likely others
**Impact:** All caught errors return 400 instead of their correct status (404, 409, etc.)

Route-level catch blocks read `err.statusCode` (which doesn't exist on `AppError`/`ApiError` — the property is `.status`), so the fallback to 400 always triggers.

**Root cause:** Copy-paste from an incorrect template.
**Fix:** Global find-and-replace `err.statusCode` → `err.status` in all route catch blocks. Better: remove per-route catch blocks entirely and let the global error handler (which reads `.status` correctly) handle everything.

### P6. Empty Array Guards Missing for `inArray()` / Bulk Operations

**Affected domains:** Collections, Widgets, Products (bulk), Attributes
**Impact:** `inArray(col, [])` generates invalid SQL (`WHERE col IN ()`) — D1 may error or return wrong results

Multiple bulk operations pass arrays to `inArray()` without checking for empty arrays first.

**Fix:** Add `if (ids.length === 0) return []` guard at the start of all bulk operations. Could also create a shared `safeInArray()` helper.

---

## Security Issues (Priority Order)

| # | Issue | Domain | Severity |
|---|-------|--------|----------|
| S1 | Stored XSS — unsanitized widget HTML renders on storefront | Widgets | **CRITICAL** |
| S2 | SQL injection surface — `ftsMatch` accepts arbitrary table names | Search | **HIGH** |
| S3 | JWT token blacklist fails open when KV unavailable | Auth | **HIGH** |
| S4 | Temp admin password logged to console on email failure | Auth | **HIGH** |
| S5 | Webhook auth falls through to allow-all when no secret configured | Delivery | **HIGH** |
| S6 | Unsafe sort field injection via `as keyof` cast | Attributes | **HIGH** |
| S7 | Unguarded `DELETE /all` settings endpoint | Settings | **MEDIUM** |
| S8 | Default JWT secret accepted in non-production environments | Auth | **MEDIUM** |
| S9 | Unencrypted WhatsApp token in settings | Settings | **MEDIUM** |
| S10 | TOCTOU race in payment duplicate check (no unique constraint) | Payments | **MEDIUM** |

---

## Data Integrity Issues

| # | Issue | Domain | Impact |
|---|-------|--------|--------|
| D1 | `new Date()` timestamps → year 56000 dates | Collections | All collection dates corrupted |
| D2 | `Number(date) * 1000` → year 65000 dates | Analytics | Dashboard date displays broken |
| D3 | `CURRENT_TIMESTAMP` in integer columns | Delivery, Settings | Location/slider timestamps corrupted |
| D4 | `getProductDetails` omits discountType/Amount | Products | Flat discounts silently revert to percentage on edit |
| D5 | Cart localStorage key mismatch (`"cart"` vs `"scalius_cart"`) | Storefront | Cart never cleared after purchase |
| D6 | `createPage` silently drops publishedAt and sortOrder | Pages | Data loss on page creation |
| D7 | `updateCollection` succeeds silently on non-existent IDs | Collections | False success, no data written |
| D8 | Notification emails (order_created, order_confirmed) are dead code | Notifications | Customers never receive order/confirmation emails |
| D9 | Tracking ID never passed to notification queue | Notifications | Shipped emails never include tracking info |
| D10 | Double shortcode processing in storefront pages | Pages | Shortcodes processed twice, potential rendering bugs |

---

## Performance Issues

| # | Issue | Domain | Impact |
|---|-------|--------|--------|
| PF1 | `getCategoryEditData` fetches all 999 categories to find one | Categories | O(N) where O(1) endpoint exists |
| PF2 | Duplicate discount queries (6 where 3 suffice) | Discounts | 2x DB load on discount validation |
| PF3 | N+1 sample-products query per attribute value | Attributes | 20+ extra queries per page |
| PF4 | Sequential FCM token sends (O(n) with retries) | Notifications | Notification latency scales linearly |
| PF5 | Email settings re-read from DB on every send | Notifications | 40 queries per 20-message batch |
| PF6 | N sequential HTTP requests for bulk media delete | Media | No batch endpoint |
| PF7 | Client-side sorting defeats server pagination | Inventory | All pages fetched client-side |
| PF8 | Cache context race under concurrent Worker requests | Storefront | Mutable module-level state |

---

## Code Quality / Maintainability

### Duplication

| Files | Lines | Issue |
|-------|-------|-------|
| `MediaManager.tsx` + `MediaManagerPage.tsx` | 533 + 432 | ~80% identical media manager implementations |
| 3 discount form `types.ts` files | ~300 total | Independent schemas with inconsistent validation rules |
| Admin env detection | 4 locations | Duplicate Cloudflare env probing |
| Admin envelope unwrapping | 3 modules | Duplicate `unwrapEnvelope` logic |
| `convertTimestampToISO` / `unixToISO` | 5+ files | Same helper reimplemented everywhere |
| `formatTimestamp` | 2+ files | Duplicate in collections |

### `as any` Cast Count

| Area | Count | Reason |
|------|-------|--------|
| API route OpenAPI handlers | 26 | Hono type inference limitation |
| Core `db.batch()` calls | 22 | Drizzle batch tuple type limitation |
| Storefront API modules | 35 | SDK envelope unwrapping |
| Total | **83** | Mostly pragmatic workarounds, not bugs |

### Dead Code

| Item | Location |
|------|----------|
| `error-utils.ts` (entire file) | `@scalius/shared` |
| `json-repair.ts`, `tag-parser.ts`, `html-section-parser.ts` | `@scalius/shared` |
| `notification-utils` phantom export | `@scalius/core/package.json` |
| `order_created`/`order_confirmed` email templates | `notifications.service.ts` |
| Missing `POST /discounts/usage` endpoint (SDK calls 404) | Discounts |
| `@scalius/tsconfig/astro.json` (never extended) | `packages/tsconfig` |
| Stale `migrate-collections-data.ts` (references dead Turso dep) | Database |

---

## LLM-Friendliness Assessment

### Strengths (Keep These)
- Comprehensive CLAUDE.md with architecture, conventions, recipes
- Predictable file paths: `packages/core/src/modules/{domain}/{domain}.{role}.ts`
- Consistent API patterns: `ok()`/`created()`/`ApiError` across 60+ routes
- Clear package boundaries with export maps
- Barrel exports with explanatory comments
- Standardized naming (kebab-case files, camelCase functions, PascalCase components)

### Improvements Needed for SDK/LLM Work
1. **`z.any()` elimination** — LLMs generate untyped SDK calls when response schemas are `any`
2. **Inline route logic** — LLMs duplicate business logic in new routes when the pattern shows inline queries
3. **Timestamp helper** — LLMs will perpetuate `new Date()` bugs without a canonical utility
4. **Dual error handling in app.ts** — LLMs add redundant error handling not knowing two layers exist
5. **Settings validation** — LLMs define inline schemas following the settings pattern vs `.validation.ts` for domains

---

## Recommended Fix Order

### Wave 1: Security (1-2 sessions)
1. HTML sanitize widget content before storefront render
2. Allowlist table names in `ftsMatch`
3. Allowlist sort fields in attributes service
4. Change token blacklist to fail-closed
5. Remove temp password console.log
6. Guard webhook auth (require secret or reject)
7. Protect DELETE /all endpoint
8. Require JWT_SECRET (no default fallback)

### Wave 2: Systemic Data Fixes (1 session)
1. Create `@scalius/shared/timestamps.ts` — replace ALL `new Date()` and `CURRENT_TIMESTAMP` in services
2. Fix all envelope double-wrapping — audit every `ok()` call
3. Fix error handler `statusCode` → `status` globally
4. Add empty-array guards to all `inArray()` bulk operations
5. Fix cart localStorage key mismatch
6. Fix `getProductDetails` missing discount fields
7. Wire up `order_created`/`order_confirmed` notification emails
8. Pass tracking ID through notification queue

### Wave 3: Architecture Cleanup (1-2 sessions)
1. Extract inline route queries → core services (categories, attributes, pages, navigation, settings, storefront routes)
2. Replace ALL `z.any()` with typed schemas — **blocking for SDK quality**
3. Deduplicate media managers (extract shared component)
4. Consolidate timestamp helpers across the codebase
5. Add `typecheck` script to storefront
6. Remove dead code (4 shared modules, phantom export, stale migration)

### Wave 4: Performance (1 session)
1. Add `GET /admin/categories/{id}` endpoint
2. Deduplicate discount validation queries
3. Batch attribute sample-product queries
4. Batch FCM sends / cache email settings
5. Add batch media delete endpoint
6. Fix inventory client-side sort → server-side

### Wave 5: Hardening (ongoing)
1. Add unique constraints for payment idempotency
2. Convert raw `throw new Error()` to typed errors (6 occurrences)
3. Define Drizzle relations for all schemas
4. Add type annotations to 18 JSON columns
5. Migrate storefront cache context to AsyncLocalStorage

---

## Report Index

| Domain | File | Critical | Total |
|--------|------|----------|-------|
| Products | `products.md` | 3 | ~15 |
| Orders | `orders.md` | 4 | ~20 |
| Customers | `customers.md` | 3 | ~21 |
| Categories | `categories.md` | 3 | ~15 |
| Collections | `collections.md` | 2 | ~20 |
| Discounts | `discounts.md` | 3 | ~15 |
| Payments | `payments.md` | 3 | ~20 |
| Inventory | `inventory.md` | 1 | ~10 |
| Delivery | `delivery.md` | 3 | ~21 |
| Media | `media.md` | 3 | ~20 |
| Notifications | `notifications.md` | 3 | ~15 |
| Pages | `pages.md` | 2 | ~18 |
| Widgets | `widgets.md` | 3 | ~16 |
| Navigation | `navigation.md` | 3 | ~12 |
| Settings | `settings.md` | 3 | ~20 |
| Attributes | `attributes.md` | 1 | ~8 |
| Analytics/AI/Fraud | `analytics-ai-fraud.md` | 3 | ~20 |
| Storefront Module | `storefront-module.md` | 2 | ~14 |
| Database | `database.md` | 3 | ~15 |
| Auth | `auth.md` | 4 | ~18 |
| API Framework | `api-framework.md` | 3 | ~16 |
| Admin Infra | `admin-infra.md` | 4 | ~12 |
| Storefront Infra | `storefront-infra.md` | 3 | ~12 |
| Shared Utils | `shared-utils.md` | 0 | ~17 |
| Search (FTS5) | `search.md` | 3 | ~15 |
| Cross-Cutting | `cross-cutting.md` | 1 | ~11 |
| **TOTALS** | | **~68** | **~400** |
