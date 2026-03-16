# Admin Refactoring & Codebase Architecture Hardening

**Date:** 2026-03-17
**Status:** Draft
**Predecessor:** [2026-03-16-codebase-hardening-design.md](./2026-03-16-codebase-hardening-design.md) (33 commits, all critical/high bugs fixed, API standardized)

## Prerequisites

This spec targets the `mono-repo` branch after the hardening session (33 commits, 2026-03-16). The hardening session fixed backend bugs, standardized API responses, and split core service files — but did NOT refactor the admin app. Verified on current branch:
- All 9 admin loaders still import `@scalius/database` and `@scalius/core` directly
- `middleware.ts` is still a single 352-line file
- All oversized components (CategoryList 1,441, ProductList 1,386, etc.) are at original sizes
- SideBar.astro is still 984 lines

## Goal

Prepare the codebase for rapid feature development at scale. A separate team will soon build a new admin SPA communicating purely through the API. Hundreds of features will be added across admin, storefront, and API. The codebase must be architecturally clean enough that this velocity doesn't create chaos.

## Approach: Layer-First (Top-Down)

Three phases: Foundation → Migration → Refinement. Establish shared infrastructure first, then apply it systematically.

---

## Phase 1: Foundation

### 1.1 Middleware Splitting

**Problem:** `apps/admin/src/middleware.ts` is 353 lines with auth, RBAC, environment detection, admin user detection, CSP, and cache invalidation tangled in one function.

**Solution:** Split into focused middleware modules:

```
apps/admin/src/middleware/
  auth.ts              — Session extraction from Better Auth, set user/session in context.locals
  rbac.ts              — Permission loading, route-level + page-level access checks, 2FA enforcement
  admin-detection.ts   — hasAdminUsers() with memory + KV cache, setup redirect logic
  csp.ts               — CSP header injection (move existing setPageCspHeader call)
  cache-invalidation.ts — Hono cache invalidation (move existing invalidateHonoCacheIfNeeded call)
  index.ts             — Composes all via Astro sequence(), makes execution order explicit
```

**Constraints:**
- Each module under 100 lines
- No shared mutable state between modules (communicate via `context.locals`)
- `admin-detection.ts` owns the memory + KV cache for `hasAdminUsers` (currently lines 49-96)
- Auth module handles CF env detection (currently lines 104-120) since DB init is needed for session extraction

**Verification:** `pnpm typecheck` passes, admin login/logout/RBAC flows work.

### 1.2 AdminLayout Splitting

**Problem:** `AdminLayout.astro` is 621 lines with 6 inline script blocks, nav data, permission filtering, theme detection, Firebase init, and loading spinner all in one file.

**Solution:**

```
apps/admin/src/layouts/
  AdminLayout.astro              — ~80 lines, orchestrates imports
  components/
    AdminHeader.astro            — Sticky header: breadcrumb, dark mode toggle, cache nuke, user menu, sidebar toggles
    AdminNav.ts                  — Nav sections data structure + hasNavPermission() helper (pure TS, no Astro)
    AdminSpinner.astro           — Loading spinner overlay + CSS state machine (admin-nav-pending/loading/loaded)
    ThemeInit.astro              — Inline theme detection script (FOUC prevention) — must remain is:inline
    UserContext.astro             — Window globals: __USER_ID__, __USER_PERMISSIONS__, __IS_SUPER_ADMIN__
    FirebaseInit.astro           — requestIdleCallback Firebase FCM lazy-load
```

**Constraints:**
- `ThemeInit.astro` MUST use `is:inline` (runs before hydration to prevent flash)
- `AdminNav.ts` is pure TypeScript (no Astro component) — exports `getFilteredNavSections(permissions, isSuperAdmin)`
- `AdminSpinner.astro` owns its own CSS (currently lines 359-434)
- Navigation progress tracking script (currently lines 436-535) extracted to `apps/admin/src/lib/client/nav-progress.ts`

### 1.3 SideBar Splitting

**Problem:** `SideBar.astro` is 984 lines — navigation rendering, collapse state, submenu expansion, scroll persistence, active state detection, mobile overlay, and event binding all in one file.

**Solution:**

```
apps/admin/src/components/admin/adminLayout/
  SideBar.astro              — ~200 lines, template + imports
  sidebar/
    sidebar-state.ts         — localStorage read/write, collapse/submenu state persistence
    sidebar-events.ts        — Click delegation, scroll listener, Astro lifecycle hooks (before-swap, after-swap, page-load)
    sidebar-active.ts        — Path matching (isExactPathMatch, isPrefixPathMatch), aria-current management
    sidebar-scroll.ts        — Scroll position save/restore (debounced 150ms)
    sidebar.css              — All scoped styles extracted from inline blocks
```

**Bug fixes included:**
- Line 625: Remove reference to non-existent `#sidebar-collapse` element
- CSS/JS timing mismatch: Align submenu collapse timeout (currently 300ms) with CSS transition (350ms) — use 350ms for both
- Mobile vs desktop path matching inconsistency: Mobile uses exact equality, desktop uses `isPrefixPathMatch` — unify to `isPrefixPathMatch` for both
- Line 871: Replace hardcoded `max-height: 600px` on `.submenu-container:not(.hidden)` with `max-height: none` (let scrollHeight handle it)
- Add keyboard navigation: Arrow keys for submenu expansion, Escape to close mobile sidebar

### 1.4 Shared Data Fetching Hook

**Problem:** 30+ components repeat the same pattern: `useState` + `useEffect` + `fetch` + error handling + loading state. No consistent approach to API calls, error handling, or cache invalidation.

**Solution:** Create `apps/admin/src/hooks/use-api.ts`:

```typescript
interface UseApiOptions<T> {
  initialData?: T;
  enabled?: boolean;          // Skip fetch (e.g., when id is undefined)
  params?: Record<string, string>;
  onSuccess?: (data: T) => void;
  onError?: (error: string) => void;
}

interface UseApiReturn<T> {
  data: T | null;
  error: string | null;
  isLoading: boolean;
  refetch: () => Promise<void>;
}

function useApi<T>(path: string, options?: UseApiOptions<T>): UseApiReturn<T>
```

Also create `apps/admin/src/lib/api-fetch.ts` for SSR-side fetching in Astro pages:

```typescript
async function apiGet<T>(path: string, params?: Record<string, string>): Promise<T>
async function apiPost<T>(path: string, body: unknown): Promise<T>
async function apiPut<T>(path: string, body: unknown): Promise<T>
async function apiDelete(path: string): Promise<void>
```

Both handle the admin proxy envelope (`{ success, ...T }` from the proxy, or `{ success, data: T }` if calling API directly).

**Constraints:**
- `useApi` is client-side only (React hook)
- `apiGet`/`apiPost`/`apiPut`/`apiDelete` work in both SSR (Astro pages) and client-side
- SSR calls go through the admin proxy at `/api/v1/admin/*` — cookies flow automatically
- All functions throw on non-success responses with parsed error messages
- `useApi` returns previous data during refetch (avoids flash to loading state)

### 1.5 Error Boundary Infrastructure

**Problem:** Only 1 ErrorBoundary component exists across 232 components. One broken widget crashes the entire admin page.

**Solution:** Enhance existing `ErrorBoundary.tsx` and create a `PageSection` wrapper:

```typescript
// apps/admin/src/components/admin/shared/PageSection.tsx
interface PageSectionProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  onReset?: () => void;
  className?: string;
}
```

`PageSection` wraps `ErrorBoundary` with a styled error card, retry button, and optional `onReset` callback. Apply to every major page section:

- Every list view (ProductList, OrderList, CategoryList, etc.)
- Every form view (ProductForm, OrderForm, CategoryForm, etc.)
- Every settings panel
- Dashboard stat cards and chart
- Media manager
- Widget editor

**Verification:** Temporarily throw an error in one component, confirm boundary catches it without crashing page.

### 1.6 TypeScript Strictness

**Problem:** `noUncheckedIndexedAccess` is not enabled. Array access like `arr[i]` returns `T` instead of `T | undefined`, masking potential runtime errors. ESLint has `no-explicit-any: off`.

**Solution:**
- Add `"noUncheckedIndexedAccess": true` to `packages/tsconfig/base.json`
- Change ESLint `@typescript-eslint/no-explicit-any` from `off` to `warn`
- Fix resulting type errors (mostly adding `?` checks after array indexing)
- Expected scope: 150-250 new type errors across the monorepo, concentrated in array-heavy list components (CategoryList, ProductList, OrderList, etc.)
- Fix packages first (shared, database, core) to unblock apps
- Risk mitigation: Parallel teams can fix different workspaces simultaneously

**Constraints:**
- Fix errors in packages first (shared, database, core), then apps
- Don't suppress with `!` assertions — add proper `undefined` checks
- The 8 `db.batch() as any` casts in core are exempt (Drizzle D1 limitation)

### 1.7 Inline Script Extraction

**Problem:** 5 Astro pages have large inline `<script>` blocks (up to 220 lines) with business logic, window globals, and in one case `eval()`.

**Solution:**

| Page | Lines | Script Content | Extract To |
|------|-------|---------------|-----------|
| `products/new.astro` | 83 | `eval(handleSubmit)` + navigation helper | `lib/client/product-actions.ts` — export `initProductNewPage()` |
| `products/[id]/edit.astro` | 40 | Variant scroll state management | `lib/client/variant-scroll.ts` — export `initVariantScroll()` |
| `orders/[id]/index.astro` | 140 | `window.shipmentActions` (createShipment, checkStatus, delete) | `lib/client/shipment-actions.ts` — export `initShipmentActions()` |
| `discounts/new.astro` | 220 | ReactDOM.createRoot, dynamic form loading | `lib/client/discount-form-loader.ts` — export `initDiscountFormLoader()` |
| `settings/fraud-checker/index.astro` | 60 | `window.fraudCheckerActions` (save, delete, test) | `lib/client/fraud-checker-actions.ts` — export `initFraudCheckerActions()` |

Each page's inline script reduces to ~5 lines calling the exported init function.

**Critical:** The `eval()` in `products/new.astro:83` is eliminated entirely. The handleSubmit function becomes a proper module import.

---

## Phase 2: Migration

### 2.1 Loader → API Migration

**Problem:** All 9 loader files (1,479 lines) in `apps/admin/src/loaders/admin/` directly import `@scalius/database` and `@scalius/core` to query the DB. This bypasses the API layer, prevents the future SPA from reusing the same data fetching paths, and bundles drizzle-orm into the admin worker.

**Solution:** Replace every loader function with calls to the admin API proxy using `apiGet()` from `lib/api-fetch.ts`.

**Migration per loader:**

#### products.ts (283 lines → ~40 lines)
- `getActiveCategories()` → `apiGet("/categories/form-options")`
- `getProductsIndexData()` → `apiGet("/products", { page, limit, search, category, sort, order })`
- `getProductEditData(id)` → `apiGet("/products/{id}")` — returns product with images, variants, attributes, rich content
- `getProductViewData(id)` → `apiGet("/products/{id}")`
- `getProductStats()` → `apiGet("/products/stats")`

#### orders.ts (259 lines → ~35 lines)
- `getOrdersIndexData()` → `apiGet("/orders", { page, limit, search, status, sort, order })`
- `getOrderFormProducts()` → `apiGet("/products", { limit: 999 })` — for order form product picker
- `getOrderViewData(id)` → `apiGet("/orders/{id}")` — API already returns items + shipments
- `getOrderEditData(id)` → `apiGet("/orders/{id}/form-data")`

#### customers.ts (359 lines → ~30 lines)
- `getCustomersIndexData()` → `apiGet("/customers", { page, limit, search, sort, order })`
- `getCustomerEditData(id)` → `apiGet("/customers/{id}")`
- `getCustomerHistoryData(id)` → `apiGet("/customers/{id}/history")`

#### catalog.ts (143 lines → ~25 lines)
- `getCategoriesIndexData()` → `apiGet("/categories", { page, limit, search, sort, order })`
- `getCategoryEditData(id)` → `apiGet("/categories/{id}")`
- `getCollectionFormOptions()` → `apiGet("/collections/form-options")`
- `getCollectionEditData(id)` → `apiGet("/collections/{id}")`

#### widgets.ts (143 lines → ~20 lines)
- `getWidgetsListPageData()` → `apiGet("/widgets", { search })`
- `getWidgetFormPageData(id)` → `apiGet("/widgets/{id}")` + `apiGet("/collections/form-options")`

#### discounts.ts (102 lines → ~15 lines)
- `getDiscountsIndexData()` → `apiGet("/discounts", { page, limit, search, sort, order })`
- `getDiscountEditData(id)` → `apiGet("/discounts/{id}")`

#### settings.ts (64 lines → ~15 lines)
- `getGeneralSettingsData()` → `apiGet("/settings/header")` + `apiGet("/settings/footer")`
- `getMetaConversionSettingsData()` → `apiGet("/settings/meta-conversions")`
- `getDeliveryProvidersData()` → `apiGet("/settings/delivery-providers")`

#### analytics.ts (45 lines → ~10 lines)
- `getAnalyticsListData()` → `apiGet("/analytics")`
- `getAnalyticsEditData(id)` → `apiGet("/analytics/{id}")`

#### layout.ts (90 lines → ~20 lines)
- `getSetupAdminExists()` → stays in middleware (not a loader concern)
- `getSidebarStorefrontUrl()` → `apiGet("/settings/storefront-url")`
- `getAdminLayoutFirebaseConfig()` → `apiGet("/settings/firebase")` (already exists as public endpoint)
- `getAccountSecurityData(userId)` → `apiGet("/auth/users/{userId}")` or keep as middleware-injected

**After migration:** Delete entire `apps/admin/src/loaders/` directory.

### 2.2 Admin Bundle Cleanup

After loader migration, remove `@scalius/database` from `apps/admin/package.json` dependencies.

Remaining `@scalius/core` imports in admin (all legitimate):
- `middleware/` — auth, RBAC, CSP (server-side, must stay)
- `contexts/PermissionContext.tsx` — type-only imports (RBAC type definitions)
- `layouts/AdminLayout.astro` — `PERMISSIONS` constant for nav filtering
- `pages/api/auth/[...all].ts` — Better Auth passthrough
- `lib/middleware-helper/` — cache invalidation utilities

Also migrate `pages/firebase-messaging-sw.js.ts` from direct DB access to fetch from `GET /api/v1/auth/firebase-config`.

**Estimated bundle reduction:** ~150KB (drizzle-orm) + ~100KB (removed DB schema imports) = ~250KB smaller admin worker.

### 2.3 Security Fixes

| # | Issue | Severity | File | Fix |
|---|-------|----------|------|-----|
| 1 | `eval()` for form handler | Critical | `products/new.astro:83` | Extract to module import (Phase 1.7) |
| 2 | SQL string concatenation | Critical | `loaders/admin/orders.ts:180` | Eliminated by loader migration (no SQL in admin) |
| 3 | Missing Zod on POST | High | `api/routes/admin/fraud-checker.ts:54,87` | Add `fraudCheckerProviderSchema` with Zod validation |
| 4 | Missing Zod on POST | High | `api/routes/admin/openrouter.ts:97` | Add `generateContentSchema` with Zod validation |
| 5 | Missing Zod on POST | High | `api/routes/admin/settings/site.ts:58` | Add `currencySettingsSchema` with Zod validation |
| 6 | Missing Zod on POST | High | `api/routes/admin/settings/delivery-providers.ts:90` | Add `deliveryProviderSchema` with Zod validation |
| 7 | No rate limit on setup | Medium | `api/routes/admin/auth-management.ts:490` | Add KV rate limit: 5 req/IP/hour |
| 8 | Wrong response format | Medium | `api/routes/admin/ai-prompts.ts:53` | Change `c.text()` to `ok(c, { prompt })` |
| 9 | Global DB in routes | Medium | `api/routes/admin/settings/site.ts:29`, `system.ts:2`, `integrations.ts:2` | Replace `import { db }` with `c.get("db")` |

### 2.4 API Gap Filling

New endpoints required for loader migration and known backlog:

```
# Loader migration support
GET  /admin/products/stats              — Product/category count dashboard data
GET  /admin/customers/{id}/history      — Customer history + orders + enriched locations
GET  /admin/categories/form-options     — Lightweight category list for dropdowns
GET  /admin/collections/form-options    — Categories + products for collection form
GET  /admin/orders/{id}/form-data       — Order edit data with products/variants

# Known backlog (widget history)
GET    /admin/widgets/{id}/history                    — Version history list
POST   /admin/widgets/{id}/history/{versionId}/restore — Restore a version
DELETE /admin/widgets/{id}/history/{versionId}          — Delete a version

# Navigation CRUD (currently skeleton — only 1 GET route)
GET    /admin/navigation                — List navigation configs
POST   /admin/navigation               — Create navigation config
PUT    /admin/navigation/{id}           — Update navigation config
DELETE /admin/navigation/{id}           — Delete navigation config
```

All new endpoints follow existing patterns: `createRoute()` + Zod schemas + `ok()`/`created()`/`noContent()` response helpers.

**Response shapes** (match what current loaders return, so admin pages need zero changes):

```typescript
// GET /admin/products/stats
{ totalProducts: number, activeProducts: number, productsWithImages: number, categoriesCount: number }

// GET /admin/customers/{id}/history
{ customer: Customer, history: CustomerHistory[], orders: Order[] }

// GET /admin/categories/form-options
{ categories: { id: string, name: string }[] }

// GET /admin/collections/form-options
{ categories: { id: string, name: string }[], products: { id: string, name: string, price: number }[] }

// GET /admin/orders/{id}/form-data
{ order: Order, products: ProductWithVariants[] }

// GET /admin/widgets/{id}/history
{ history: { id: string, htmlContent: string, cssContent: string, reason: string, createdAt: string }[] }
```

Implementers should cross-reference the current loader return shapes in `apps/admin/src/loaders/admin/*.ts` to ensure exact compatibility.

---

## Phase 3: Refinement

### 3.1 Component Splitting

Split 15 oversized components following container/presentational pattern. Each split creates:
- A container component (data fetching via `useApi`, state management, callbacks)
- Presentational children (pure render, receive data via props)
- A custom hook if state logic is complex

**1,000+ line components (8):**

| Component | Lines | Split Into |
|-----------|-------|-----------|
| CategoryList.tsx | 1,441 | Container + Table + Filters + BulkActions + useCategoryList hook |
| DeliveryLocationsManager.tsx | 1,419 | Container + LocationTable + LocationForm + LocationImport + hook |
| AccountSettings.tsx | 1,419 | Container + ProfileTab + SecurityTab + RolesTab + PermissionsTab |
| CheckoutLanguagesManager.tsx | 1,392 | Container + LanguagesTab + PaymentMethodsTab + ShippingTab |
| ProductList.tsx | 1,386 | Container + Table + Filters + BulkActions + useProductList hook |
| DiscountList.tsx | 1,367 | Container + Table + Filters + TypeSelector + useDiscountList hook |
| ShippingMethodsManager.tsx | 1,270 | Container + Table + FormDialog + ProviderConfig |
| SideBar.astro | 984 | Covered in Phase 1.3 |

**500-900 line components (7):**

| Component | Lines | Split Into |
|-----------|-------|-----------|
| OrderList.tsx | 804 | Container + OrderTable + OrderFilters + OrderToolbar |
| MetaConversionsManager.tsx | 835 | SettingsForm + LogsViewer + CleanupDialog |
| BulkVariantGenerator.tsx | 707 | Wizard steps: SizeColorInput + SkuConfig + PreviewTable |
| HeroSliderManager.tsx | 662 | Container + SliderEditor + SortableSlide |
| CollectionForm.tsx | 653 | Form + ProductSelector + CategorySelector |
| PaymentGatewaysManager.tsx | 510 | Extract existing sub-components to separate files (StripeForm, SSLForm, PolarForm) |
| VariantManager.tsx | 521 | Already well-organized; extract VariantStats, VariantBulkEdit to files |

### 3.2 Type Safety

Eliminate ~130 `any` usages by category:

**Category 1: Error handlers (~60 instances)**
Replace `catch (error: any)` with `catch (error)` + `error instanceof Error` check.

**Category 2: API response types (~30 instances)**
Create `apps/admin/src/types/api-responses.ts` with interfaces for all admin API responses. These are interim types until SDK is regenerated.

**Category 3: Component props (~20 instances)**
Replace `icon: any` with `icon: React.ComponentType<{ className?: string }>` and similar.

**Category 4: Window globals (~10 instances)**
Create `apps/admin/src/types/window.d.ts` extending the global `Window` interface.

**Category 5: Drizzle batch casts (~8 instances)**
Keep `as any` with ESLint disable comment. These are a Drizzle D1 API limitation.

**Category 6: Customers service errors**
Replace `Object.assign(new Error(), {statusCode})` with proper `ApiError` subclasses.

### 3.3 Performance

**React.memo on list rows:** Apply to ~12 row components rendered inside `.map()`:
`CategoryRow`, `ProductRow`, `DiscountRow`, `CustomerRow`, `PageRow`, `CollectionRow`, `AttributeRow`, `WidgetRow`, `ShipmentHistoryItem`, `InventoryVariantRow`, `AbandonedCheckoutRow`, `AnalyticsRow`.

**Lazy-load heavy dependencies:**
- `DashboardStats` (imports Recharts ~300KB) — `React.lazy()` on dashboard page only
- `TiptapEditor` (imports TipTap ~800KB) — `React.lazy()` on widget/page editor only
- Extend the existing `React.lazy` pattern from `CheckoutSettingsPage`/`GeneralSettingsPage` to all settings tabs with heavy sub-components

**Remove debug logging:** Delete 11 `console.log` in `LocationSelector.tsx`, scattered debug logs in `DeliveryShipmentManager.tsx`, `use-shipment-status.ts`.

**Replace `window.location.reload()`:** 5+ components use reload as state sync workaround. Replace with `refetch()` from `useApi` hook or React state updates.

### 3.4 Pattern Cleanup

**Toast standardization:** Migrate remaining `useToast()` hook consumers to `toast` from `sonner`. Delete `apps/admin/src/hooks/use-toast.ts` (192 lines) after migration.

**ID generation:** Replace `Math.random()` in `HeroSliderManager.tsx:389` with `nanoid`.

**Schema deduplication:** Remove duplicate schema definitions from `pages.service.ts` and `widgets.service.ts` — keep only in `.validation.ts` files.

**`getDashboardStats()` DI fix:** Change function signature to accept `db` as parameter instead of importing global `db`.

### 3.5 Test Infrastructure

Set up in private `tests/` directory (gitignored per project convention — only core team maintains tests):

```
tests/
  vitest.config.ts
  setup.ts                           — D1 test database, mock env, seed helpers
  core/
    orders/
      order-lifecycle.test.ts        — PENDING → CONFIRMED → SHIPPED → DELIVERED → COMPLETED
      order-state-machine.test.ts    — All valid transitions + blocked transitions (CANCELLED terminal)
      order-cancellation.test.ts     — Inventory release on cancel
    inventory/
      reserve-deduct-release.test.ts — CAS with stockVersion, retry on conflict
      batch-reservation.test.ts      — Multi-variant atomic batch
      expiry.test.ts                 — releaseExpiredReservations idempotency
    payments/
      process-payment.test.ts        — Atomicity via db.batch(), all 4 gateways
      cod-idempotency.test.ts        — Duplicate COD collection prevention
      refund-validation.test.ts      — Cumulative refund limit, partial vs full
    discounts/
      discount-validation.test.ts    — Per-customer usage limits, expired codes
      discount-race.test.ts          — Usage re-check in queue handler
  api/
    response-envelope.test.ts        — All routes return { success, data }
    zod-validation.test.ts           — All POST/PUT routes reject invalid input
```

Tests target the exact bugs fixed in the hardening session to prevent regression.

### 3.6 Database Indexes

Add missing indexes for frequently queried tables:

```sql
CREATE INDEX IF NOT EXISTS media_folder_id_idx ON media(folder_id);
CREATE INDEX IF NOT EXISTS media_deleted_at_idx ON media(deleted_at);
CREATE INDEX IF NOT EXISTS delivery_providers_type_idx ON delivery_providers(type);
CREATE INDEX IF NOT EXISTS analytics_type_idx ON analytics(type);
CREATE INDEX IF NOT EXISTS product_attributes_slug_idx ON product_attributes(slug);
```

Generate migration: `pnpm db:generate` → produces migration 0025.

---

## Execution Order

### Phase 1 (Foundation) — Parallel Groups

All of Phase 1 must complete before Phase 2 starts (Phase 2 depends on shared hooks from 1.4 and extracted scripts from 1.7).

- **Group A:** Middleware splitting (1.1) + TypeScript strictness (1.6)
- **Group B:** AdminLayout splitting (1.2) + SideBar splitting (1.3)
- **Group C:** Shared hooks (1.4) + Error boundaries (1.5) + Inline script extraction (1.7)

### Phase 2 (Migration) — Sequential Within Phase

Phase 2 starts only after Phase 1 is complete.

1. Fill API gaps (2.4) — **BLOCKS** 2.1 and 2.2; new endpoints must exist before loaders can call them
2. Loader migration (2.1) + bundle cleanup (2.2) — depends on 2.4
3. Security fixes (2.3) — can overlap with 2.2

### Phase 3 (Refinement) — Parallel Groups

Phase 3 starts only after Phase 2 is complete.

- **Group D:** Component splitting (3.1) — parallelizable by domain (products, orders, customers, settings, etc.)
- **Group E:** Type safety (3.2) + Pattern cleanup (3.4)
- **Group F:** Performance (3.3)
- **Group G:** Test infrastructure (3.5) + Database indexes (3.6)

---

## Verification

After each phase:
1. `pnpm typecheck` passes across all workspaces
2. Admin login, dashboard, CRUD operations work (manual smoke test)
3. No regressions in API response format (`{ success, data }` envelope)
4. Storefront unaffected (it only uses `@scalius/shared` and `@scalius/api-client`)

After Phase 2 specifically:
- Confirm `@scalius/database` is not in admin worker bundle
- Confirm all admin pages load data via API proxy (network tab shows `/api/v1/admin/*` requests)

After Phase 3:
- All tests pass
- ESLint `warn` on `no-explicit-any` shows only the ~8 exempt Drizzle batch casts

---

## Out of Scope

- SDK regeneration (deferred until API surface fully stabilizes)
- Scanner mobile app (separate session)
- Major dependency upgrades (TipTap 2→3, Firebase 11→12, etc.)
- Multi-tenancy / KV migration for rate limiter and layout cache
- Storefront refactoring (already clean — zero violations)
