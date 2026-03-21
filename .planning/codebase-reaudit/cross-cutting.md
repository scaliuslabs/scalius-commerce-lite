# Cross-Cutting Re-Audit

**Analysis Date:** 2026-03-21
**Branch:** mono-repo
**Scope:** Re-audit of 6 systemic patterns from SYNTHESIS.md after fix session (commits 91b39c8..ef7b915)

## Overall Architecture Score: 8.5/10 (previous: 8/10)

The fix session resolved several critical issues: `err.statusCode` is completely eliminated, the phantom `notification-utils` export is removed, the duplicate error handler middleware is removed, `error-utils.ts` dead code is deleted, the storefront now has a `typecheck` script, `z.any()` usage is reduced from 30+ to just 2 (both in binary/proxy routes where it is correct), and `CURRENT_TIMESTAMP` is eliminated from services. The remaining gaps are the dual timestamp pattern (`new Date()` vs `sql\`unixepoch()\``), the `success: true` envelope double-wrapping in service returns, missing empty-array guards on pages bulk operations, and 4 public route files still contain inline Drizzle queries.

---

## Systemic Pattern Status

| # | Pattern | Previous Status | Current Status | Evidence |
|---|---------|----------------|----------------|----------|
| P1 | Timestamp Corruption | CRITICAL | **IMPROVED** | `CURRENT_TIMESTAMP` eliminated. Schema defaults standardized to `UNIX_NOW`. All timestamp columns use `{ mode: "timestamp" }` so `new Date()` is functionally correct via Drizzle auto-conversion. But dual pattern persists: 42 `new Date()` + 169 `sql\`unixepoch()\`` across core services. Not a bug, but inconsistent. |
| P2 | Envelope Double-Wrapping | CRITICAL | **STILL OPEN** | 50+ routes pass `ok(c, result)` where `result` includes `success: true` (e.g., refund-service.ts:264, reserve.ts:154, orders.fulfillment.ts:69/74/81/138, process-payment.ts:52/60/68/179, cod.ts:75/125/155/178, stripe.ts:62/90/109/134, sslcommerz.ts:93/254, polar.ts:94/131/241/270). Consumers receive `{ success: true, data: { success: true, ... } }`. |
| P3 | Thin HTTP Layer Violations | OPEN | **IMPROVED** | Categories route now imports from `categories.storefront.ts`; attributes route imports from `attributes.public.ts`. But both still contain inline Drizzle queries (7 in categories.ts, 5 in attributes.ts, 4 in navigation.ts). Settings routes (2904 total lines, 44 inline DB ops across 8 files) remain fully inline. Pages route has 1 inline query. |
| P4 | z.any() in OpenAPI | BLOCKING | **RESOLVED** | Only 2 `z.any()` remain: `media-server.ts:21` and `partytown-proxy.ts:71`, both for `*/*` binary body content schemas. These are correct -- binary request bodies cannot have typed Zod schemas. Zero `z.any()` in response schemas or route definitions. |
| P5 | err.statusCode vs err.status | OPEN | **RESOLVED** | Zero occurrences of `err.statusCode` in the entire codebase. Global grep returned no matches. |
| P6 | Empty Array Guards | OPEN | **IMPROVED** | Good coverage added: widgets (4 guards), categories (2), collections (5), products (1), attributes (2), discounts (1), orders (3), customers (2). Still missing: pages bulk operations (`bulkDeletePages`, `bulkPublishPages`, `bulkUnpublishPages`, `restorePages` at `packages/core/src/modules/pages/pages.service.ts:204-222`), `moveMediaFiles` at `packages/core/src/modules/media/media.service.ts:177`. |

---

## Metrics

| Metric | Before | After | Notes |
|--------|--------|-------|-------|
| `z.any()` count (routes) | ~30+ | **2** | Both in binary body schemas (correct usage) |
| `as any` count (API routes) | 26 | **42** | Increase is from more OpenAPI handler casts, not regressions -- more routes added |
| `as any` count (core) | 22 | **27** | New `db.batch()` calls |
| `as any` count (storefront) | 35 | **24** | Reduced -- SDK unwrapping improved |
| `as any` count (admin) | -- | **10** | Low, mostly Cloudflare env probing + phone lib typing |
| `as any` TOTAL | ~83 | **103** | Absolute increase, but rate per route decreased (more routes exist) |
| `err.statusCode` | ~15 | **0** | Fully resolved |
| Dead exports | ~6 | **1** | `notification-utils` removed, `error-utils.ts` deleted. Remaining: `@scalius/database/types` (harmless, unused in code) |
| Inline route DB queries (public) | 3 major files | **4 files** | categories.ts (7 queries), attributes.ts (5), navigation.ts (4), pages.ts (1) |
| Inline route DB queries (settings) | 7 files | **8 files** | 44 total inline DB ops across admin settings routes |
| `new Date()` in core services | Not tracked | **42** | Functionally correct via Drizzle `{ mode: "timestamp" }` but inconsistent with 169 `sql\`unixepoch()\`` usages |
| `throw new Error()` in routes | 6 | **0** | All moved out of route files; 11 remain in `apps/api/src/utils/jwt.ts` and `queue-consumer.ts` (appropriate locations) |
| `@ts-ignore` / `@ts-expect-error` | 4 | **3** | One removed. Remaining are documented and justified. |

---

## Fixes Confirmed

### Resolved Since Last Audit

1. **Phantom export `notification-utils` removed** from `packages/core/package.json` -- no longer references deleted file.

2. **Storefront `typecheck` script added** at `apps/storefront/package.json:13` -- `"typecheck": "astro check"`. Turbo `typecheck` now covers all workspaces.

3. **Duplicate error handler middleware removed** from `apps/api/src/app.ts`. Only `app.onError()` (lines 84-111) remains. The redundant `try/catch` middleware at lines 157-202 has been replaced with a comment explaining that `app.onError()` handles everything.

4. **`error-utils.ts` deleted** from `packages/shared/src/`. No longer exists.

5. **`err.statusCode` fully eliminated** -- zero occurrences across the entire codebase.

6. **`z.any()` reduced to 2** (both correct binary body schemas). Previously 30+ in response schemas and route definitions.

7. **`throw new Error()` eliminated from route files** -- all 6 previously identified occurrences in admin routes (`openrouter.ts`, `auth-management.ts`, `ai-prompts.ts`) are now gone.

8. **`CURRENT_TIMESTAMP` eliminated from services** -- all schema defaults use `UNIX_NOW` constant from `packages/database/src/schema/shared.ts`.

9. **Previous "dead code" modules are actually used** -- `json-repair.ts`, `tag-parser.ts`, and `html-section-parser.ts` from `@scalius/shared` are imported by widget AI hooks in admin (`useAiGenerator.ts`, `useAiImprover.ts`, `useStagedGeneration.ts`, `WidgetForm.tsx`). The previous audit incorrectly flagged these as unused.

---

## Remaining Gaps

### Gap 1: Envelope Double-Wrapping (P2 -- STILL OPEN)

**Severity:** HIGH -- #1 production bug pattern

Core services still return `{ success: true, ... }` objects, which `ok(c, result)` wraps into `{ success: true, data: { success: true, ... } }`.

**Affected service files:**
- `packages/core/src/modules/inventory/reserve.ts:154,204,227,443`
- `packages/core/src/modules/inventory/deduct.ts:106,162`
- `packages/core/src/modules/inventory/release.ts:77`
- `packages/core/src/modules/inventory/restore.ts:94`
- `packages/core/src/modules/payments/process-payment.ts:52,60,68,92,179`
- `packages/core/src/modules/payments/refund-service.ts:264,329`
- `packages/core/src/modules/payments/cod.ts:75,125,155,178`
- `packages/core/src/modules/payments/stripe.ts:62,90,109,134`
- `packages/core/src/modules/payments/sslcommerz.ts:93,254`
- `packages/core/src/modules/payments/polar.ts:94,131,241,270`
- `packages/core/src/modules/orders/orders.fulfillment.ts:69,74,81,138`
- `packages/core/src/modules/delivery/providers/pathao.ts:151,243`
- `packages/core/src/modules/delivery/providers/steadfast.ts:80,196`
- `packages/core/src/modules/delivery/locations.ts:152`
- `packages/core/src/modules/customers/customer-auth.service.ts:254,390`
- `packages/core/src/modules/fraud-checker/fraud-checker.service.ts:211`
- `packages/core/src/modules/analytics/meta.service.ts:90`

**Routes that pass these through `ok()`:**
- `apps/api/src/routes/admin/inventory.ts:155,195,258,293,331,373`
- `apps/api/src/routes/admin/orders-status.ts:156` (COD action)
- `apps/api/src/routes/admin/orders-refund.ts:54,94`
- `apps/api/src/routes/admin/fraud-checker.ts:189`
- `apps/api/src/routes/admin/settings/delivery-providers.ts:356`

**Fix approach:** Either strip `success` from service return types, or add a runtime guard in `ok()` that warns/strips `success` from payloads.

### Gap 2: Dual Timestamp Pattern

**Severity:** LOW -- not a bug, but inconsistent

Two patterns coexist for writing timestamps:
- `new Date()` -- 42 occurrences in core services (correct via Drizzle `{ mode: "timestamp" }`)
- `` sql`unixepoch()` `` -- 169 occurrences in core services (correct raw SQL)

Both produce correct results. The difference: `new Date()` uses JS runtime time, `sql\`unixepoch()\`` uses SQLite server time. On Cloudflare Workers these are essentially the same, but `sql\`unixepoch()\`` is preferred for consistency and to avoid time skew in batch operations.

**High-frequency `new Date()` files:**
- `packages/core/src/modules/media/media.service.ts` (6 occurrences)
- `packages/core/src/modules/payments/process-payment.ts` (4)
- `packages/core/src/modules/payments/cod.ts` (3)
- `packages/core/src/modules/delivery/providers/pathao.ts` (3)
- `packages/core/src/modules/auth/rbac/auto-seed.ts` (4)

### Gap 3: Missing Empty-Array Guards

**Severity:** MEDIUM

Pages bulk operations pass arrays directly to `inArray()` without length checks:
- `packages/core/src/modules/pages/pages.service.ts:206` -- `bulkDeletePages`
- `packages/core/src/modules/pages/pages.service.ts:213` -- `bulkPublishPages`
- `packages/core/src/modules/pages/pages.service.ts:217` -- `bulkUnpublishPages`
- `packages/core/src/modules/pages/pages.service.ts:221` -- `restorePages`

Media:
- `packages/core/src/modules/media/media.service.ts:177` -- `moveMediaFiles` (caller should validate, but no guard)

### Gap 4: Inline DB Queries in Public Routes

**Severity:** LOW -- functional but violates thin HTTP layer

Public route files still import from `@scalius/database/schema` and do inline Drizzle queries:
- `apps/api/src/routes/categories.ts` (421 lines, 7 inline DB queries) -- partially migrated, uses `getPublicCategories`/`getPublicCategoryBySlug` from core but still has `/category/:slug/products` and `/category/:slug/filters` with inline queries
- `apps/api/src/routes/attributes.ts` (245 lines, 5 inline queries) -- partially migrated, uses `getPublicFilterableAttributes`/`getPublicAttributesByCategory` but still has direct queries for category-based filtering
- `apps/api/src/routes/navigation.ts` (253 lines, 4 inline queries) -- reads `siteSettings`, `categories`, `pages` directly
- `apps/api/src/routes/pages.ts` (179 lines, 1 inline query) -- reads `pages` directly for storefront page list

Settings routes (8 files, 2904 lines total, 44 inline DB ops) are intentionally inline per CLAUDE.md convention.

### Gap 5: order_created / order_confirmed Notifications Still Dead

**Severity:** MEDIUM

Templates exist in `packages/core/src/modules/notifications/notifications.service.ts:174-184`, but no order creation flow enqueues `order.notification` with `notificationType: "order_created"` or `"order_confirmed"`. The only notification enqueue point is admin status update (`apps/api/src/routes/admin/orders-status.ts:84`), which fires on explicit status changes, not on initial creation.

---

## New Issues Found

### Issue 1: `createFulfillmentShipment` Uses `new Date()` for Shipment Timestamps

**File:** `packages/core/src/modules/orders/orders.fulfillment.ts:106,118`

```typescript
const now = new Date();
// ...
createdAt: now, updatedAt: now,
```

The `deliveryShipments` table schema uses `integer("created_at", { mode: "timestamp" })` so this works, but the same function uses `sql\`unixepoch()\`` on line 125 for the order update. Within a single function, two different timestamp patterns coexist.

### Issue 2: Storefront `as any` Count Still Notable (24)

**Files:** Concentrated in:
- `apps/storefront/src/middleware.ts` (4) -- Cloudflare env probing
- `apps/storefront/src/components/product/scripts/product-controller.ts` (3) -- DOM data attributes
- `apps/storefront/src/lib/api/abandoned-checkouts.ts` (2) -- SDK body typing
- `apps/storefront/src/components/AuthModal.tsx` (4) -- phone library typing
- `apps/storefront/src/components/PhoneField.tsx` (2) -- phone library typing

The phone library casts (6 total) are a type mismatch between `react-international-phone` and its React type definitions. Low risk, but could be fixed with a typed wrapper.

### Issue 3: API Route `as any` Grew to 42

All 42 are the `}) as any)` OpenAPI handler cast pattern -- a known Hono OpenAPI type inference limitation. This is not a regression; more routes were added with the same pattern. The cast count grows linearly with route count.

---

## LLM-Friendliness Score: 9/10 (previous: not scored separately)

### What Works Well
1. **CLAUDE.md is comprehensive** -- 350+ lines covering architecture, conventions, recipes, dependency graph, important file paths, and known backlog items.
2. **Predictable file locations** -- `packages/core/src/modules/{domain}/{domain}.{role}.ts` pattern is consistent across all 20+ domains.
3. **Standardized API patterns** -- `ok()`/`created()`/`noContent()` + `ApiError` + `successEnvelope()` across all 60+ non-webhook routes.
4. **Import conventions enforced** -- Zero violations of the import discipline rules in CLAUDE.md.
5. **Settings inline pattern documented** -- CLAUDE.md explicitly explains the inline settings convention, preventing confusion.

### What Could Trip Up an LLM
1. **Double-wrapping trap** -- An LLM adding a new inventory/payment route will see `ok(c, result)` patterns and propagate the double-wrap unless warned. CLAUDE.md mentions the envelope contract but does not explicitly warn about `success: true` in service returns.
2. **Dual timestamp pattern** -- An LLM may use either `new Date()` or `sql\`unixepoch()\`` and both will work, but inconsistency accumulates.
3. **Settings vs domain convention split** -- Settings routes use inline DB queries; domain routes delegate to core. An LLM might apply the wrong pattern for new features.

---

## Summary of Recommended Actions (Priority Order)

1. **Strip `success: true` from service returns** (P2) -- Audit all 50+ occurrences. Services should return pure data; `ok()` adds the envelope.
2. **Add empty-array guards to pages bulk operations** (P6) -- 4 functions in `pages.service.ts`
3. **Standardize on `sql\`unixepoch()\`` for service timestamps** -- Convert 42 `new Date()` usages for consistency (optional, both work)
4. **Wire up order_created/order_confirmed notifications** -- Templates exist but are never triggered
5. **Extract remaining inline public route queries** to core services (categories, attributes, navigation, pages)
