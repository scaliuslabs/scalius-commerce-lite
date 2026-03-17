# Phase 3: Refinement — Admin Codebase Preparation for Scale

**Date:** 2026-03-17
**Status:** Draft
**Predecessor:** [2026-03-17-admin-refactoring-design.md](./2026-03-17-admin-refactoring-design.md) (Phase 1 Foundation + Phase 2 Migration complete)

## Context

Phase 1 (Foundation) and Phase 2 (Migration) are complete on the `mono-repo` branch. The admin app now fetches data through the API layer via `apiGet()` (SSR) and `useApi` (client-side). The infrastructure is in place: middleware split into 6 modules, AdminLayout decomposed, shared hooks created, `noUncheckedIndexedAccess` enabled, ESLint `any` rule set to warn.

However, Phase 2's loader migration caused a cascade of production bugs from response shape mismatches. The codebase must be assumed broken until proven otherwise. Every page needs verification before refactoring.

## Goal

Prepare the admin codebase for rapid feature development at scale. A separate team will soon build a new admin SPA communicating purely through the API. The current admin must be architecturally clean enough to serve as reference implementation and not accumulate further debt during the transition.

## Approach: Staged Waves with Verify-As-You-Go

Four waves, each gated by verification. Parallel subagents within waves, sequential across waves.

```
Wave 0: Verification Pass (solo, sequential)
    ↓ bug list produced
Wave 1: Domain Agent Splits (3-4 parallel agents)
    ↓ all domains split + verified
Wave 2: Cross-Cutting Sweeps (2-3 parallel agents)
    ↓ patterns unified
Wave 3: Final Sweep (solo)
    ↓ lazy-loading + final verification
```

## Key Decisions

- **Verify-as-you-go**: Each domain is tested before and after refactoring. No "typecheck passes = done."
- **Barrel files**: Component directories use barrel `index.ts` for ergonomic imports. Third-party libraries use direct imports (Vercel `bundle-barrel-imports` rule).
- **Fresh spec**: This is a standalone spec, not an amendment to the Phase 1+2 design doc.
- **Subagent context**: Every agent gets full data flow context, explicit file ownership boundaries, Vercel React best practices, and domain-specific bug lists from Wave 0.

## Current State (Verified by Exploration)

| Metric | Count | Notes |
|--------|-------|-------|
| Components >1,000 lines | 9 | CategoryList 1438, DeliveryLocationsManager 1419, AccountSettings 1419, CheckoutLanguagesManager 1392, ProductList 1386, DiscountList 1367, ShippingMethodsManager 1270, DeliveryProviderSettings 1132, CustomerList 959 |
| `any` type usages | 163 | Across 72 files |
| `window.location.reload()` | 13 | Across 9 files |
| `@scalius/database/schema` imports in admin | 8 | Type-only, architectural violation |
| Custom `use-toast.ts` | 187 lines | Redundant with sonner |
| Test files | 0 | Directory structure exists, all empty |
| API routes (all follow OpenAPI pattern) | 68 | Consistent, no outliers |
| Duplicate schema definitions | 2 modules | pages.service.ts + widgets.service.ts duplicate their .validation.ts |

## Data Flow Reference

Every agent must understand these two data paths:

### Path 1: SSR (Astro page frontmatter → loader → apiGet)

```
Astro page frontmatter
  → loader function (apps/admin/src/loaders/admin/*.ts)
    → apiGet<T>(path) (apps/admin/src/lib/api-fetch.ts)
      → Service Binding (prod) or HTTP (dev) to API worker
        → API returns { success: true, data: T }
      → handleResponse() reads body.data, returns T
    → loader returns T
  → Astro passes T as props to React component (client:idle)
```

### Path 2: Client-side (React component → useApi → proxy)

```
React component
  → useApi<T>(path) (apps/admin/src/hooks/use-api.ts)
    → fetch("/api/v1/admin/...")
      → Admin proxy (apps/admin/src/pages/api/v1/[...path].ts)
        → Forwards to API worker
        → API returns { success: true, data: T }
        → Proxy unwraps: { success: true, data: { orders: [...] } }
                       → { success: true, orders: [...] }
        → Arrays stay wrapped: { success: true, data: [...] } → passed through as-is
      → useApi strips `success`, returns rest as T
    → component receives T
```

**Critical:** Both paths return the same shape `T` for object payloads. For array payloads, `apiGet` returns `[array]` but `useApi` returns `{ data: [array] }`. Verify any component using both paths for the same data.

---

## Wave 0: Verification Pass

**Executor:** Orchestrator (not a subagent). Must see actual browser state.

**Process:**
1. Start `pnpm dev` (admin :4321 + API :8787)
2. Open Chrome, visit every admin route systematically
3. For each page: verify data renders, check console for errors, test forms (create/edit/delete), test interactive elements (modals, dropdowns, bulk actions)
4. Document findings as a structured bug list: page, symptom, likely root cause

**Pages to verify:**

| Domain | Routes |
|--------|--------|
| Dashboard | `/admin` — stats cards, chart, recent orders |
| Products | `/admin/products` (list), `/admin/products/new` (create), `/admin/products/[id]/edit`, `/admin/products/[id]` (view) |
| Orders | `/admin/orders` (list), `/admin/orders/new` (create), `/admin/orders/[id]` (view with shipments + payments) |
| Customers | `/admin/customers` (list), `/admin/customers/[id]/edit`, `/admin/customers/[id]/history` |
| Categories | `/admin/categories` (list), `/admin/categories/new`, `/admin/categories/[id]/edit` |
| Collections | `/admin/collections` (list), `/admin/collections/new`, `/admin/collections/[id]/edit` |
| Discounts | `/admin/discounts` (list), `/admin/discounts/new`, `/admin/discounts/[id]/edit` |
| Widgets | `/admin/widgets` (list), `/admin/widgets/new`, `/admin/widgets/[id]/edit` |
| Pages | `/admin/pages` (list), `/admin/pages/new`, `/admin/pages/[id]/edit` |
| Settings | `/admin/settings` (general), `/admin/settings/checkout`, `/admin/settings/shipping`, `/admin/settings/delivery`, `/admin/settings/payment-gateways`, `/admin/settings/meta-conversions`, `/admin/settings/account`, `/admin/settings/fraud-checker` |
| Analytics | `/admin/analytics` (list), `/admin/analytics/[id]/edit` |
| Media | `/admin/media` |
| Navigation | `/admin/navigation` |

**Output:** Bug list partitioned by domain. Each Wave 1 agent receives their domain's bugs.

**Gate:** Wave 1 does not start until Wave 0 completes and bugs are cataloged.

---

## Wave 1: Domain Agent Splits

**Executor:** 4 parallel subagents, each with isolated file ownership.

### Agent 1 — Products & Catalog

**Files owned:**
- `apps/admin/src/components/admin/categories/CategoryList.tsx` (1,438 lines)
- `apps/admin/src/components/admin/products/ProductList.tsx` (1,386 lines)
- `apps/admin/src/components/admin/collections/CollectionForm.tsx` (653 lines)
- `apps/admin/src/components/admin/product-form/variants/BulkVariantGenerator.tsx` (706 lines)
- All new files created by splitting these components

**Split targets:**

| Component | Split Into |
|-----------|-----------|
| `CategoryList.tsx` (1,438) | `categories/` dir: CategoryListContainer + CategoryTable + CategoryFilters + CategoryBulkActions + useCategoryList hook |
| `ProductList.tsx` (1,386) | `product-list/` dir: ProductListContainer + ProductTable + ProductFilters + ProductBulkActions + useProductList hook |
| `CollectionForm.tsx` (653) | `collection-form/` dir: CollectionFormContainer + ProductSelector + CategorySelector |
| `BulkVariantGenerator.tsx` (706) | Wizard steps: SizeColorInput + SkuConfig + PreviewTable |

**Reference pattern:** `apps/admin/src/components/admin/product-form/` (39 files, section-based decomposition with dedicated hooks).

### Agent 2 — Orders & Customers

**Files owned:**
- `apps/admin/src/components/admin/orders/OrderList.tsx` (804 lines)
- `apps/admin/src/components/admin/customers/CustomerList.tsx` (959 lines)
- `apps/admin/src/components/admin/discount/DiscountList.tsx` (1,367 lines)
- All new files created by splitting these components

**Split targets:**

| Component | Split Into |
|-----------|-----------|
| `OrderList.tsx` (804) | `order-list/` dir: OrderListContainer + OrderTable + OrderFilters + OrderToolbar |
| `CustomerList.tsx` (959) | `customer-list/` dir: CustomerListContainer + CustomerTable + CustomerFilters + CustomerBulkActions |
| `DiscountList.tsx` (1,367) | `discount-list/` dir: DiscountListContainer + DiscountTable + DiscountFilters + TypeSelector + useDiscountList hook |

### Agent 3 — Settings & Checkout

**Files owned:**
- `apps/admin/src/components/admin/settings/AccountSettings.tsx` (1,419 lines)
- `apps/admin/src/components/admin/settings/checkout/CheckoutLanguagesManager.tsx` (1,392 lines)
- `apps/admin/src/components/admin/settings/shipping/ShippingMethodsManager.tsx` (1,270 lines)
- `apps/admin/src/components/admin/settings/payment/PaymentGatewaysManager.tsx` (510 lines)
- `apps/admin/src/components/admin/settings/MetaConversionsManager.tsx` (835 lines)
- All new files created by splitting these components

**Split targets:**

| Component | Split Into |
|-----------|-----------|
| `AccountSettings.tsx` (1,419) | `account-settings/` dir: AccountSettingsContainer + ProfileTab + SecurityTab + RolesTab + PermissionsTab |
| `CheckoutLanguagesManager.tsx` (1,392) | `checkout-languages/` dir: Container + LanguagesTab + PaymentMethodsTab + ShippingTab |
| `ShippingMethodsManager.tsx` (1,270) | `shipping-methods/` dir: Container + MethodTable + FormDialog + ProviderConfig |
| `PaymentGatewaysManager.tsx` (510) | Extract StripeForm, SSLForm, PolarForm to separate files |
| `MetaConversionsManager.tsx` (835) | `meta-conversions/` dir: SettingsForm + LogsViewer + CleanupDialog |

### Agent 4 — Delivery & Content

**Files owned:**
- `apps/admin/src/components/admin/delivery/DeliveryLocationsManager.tsx` (1,419 lines)
- `apps/admin/src/components/admin/delivery/DeliveryProviderSettings.tsx` (1,132 lines)
- `apps/admin/src/components/admin/widgets/HeroSliderManager.tsx` (662 lines)
- `apps/admin/src/components/admin/product-form/variants/VariantManager.tsx` (521 lines)
- All new files created by splitting these components

**Split targets:**

| Component | Split Into |
|-----------|-----------|
| `DeliveryLocationsManager.tsx` (1,419) | `delivery-locations/` dir: Container + LocationTable + LocationForm + LocationImport + useDeliveryLocations hook |
| `DeliveryProviderSettings.tsx` (1,132) | `delivery-providers/` dir: Container + ProviderCard + CredentialForm + WebhookConfig |
| `HeroSliderManager.tsx` (662) | `hero-slider/` dir: Container + SliderEditor + SortableSlide |
| `VariantManager.tsx` (521) | Extract VariantStats + VariantBulkEdit to separate files |

### Shared Rules for All Wave 1 Agents

**Component splitting pattern:**
1. READ the component fully before splitting. Trace: where does data come from (useApi? props from Astro? direct fetch?), what state does it manage, what callbacks does it define.
2. Container component owns data fetching (via `useApi` hook) and state management. Presentational children receive data via props only.
3. If state logic exceeds ~50 lines of useState/useCallback/useEffect, extract into a custom `use[Domain]` hook in a `hooks/` subfolder.
4. Each split directory gets a barrel `index.ts` that re-exports the main container component.

**Vercel React best practices to apply:**
- `rerender-no-inline-components` (HIGH): No component definitions inside other components. Extract to module-level.
- `rerender-memo` (MEDIUM): Apply `React.memo()` on every row component rendered inside `.map()`.
- `rerender-derived-state-no-effect` (MEDIUM): Derive state during render, not in useEffect. If a value can be computed from props/state, compute it inline.
- `rerender-memo-with-default-value` (MEDIUM): Hoist default non-primitive props (empty arrays, default objects) to module scope constants.
- `rerender-functional-setstate` (MEDIUM): Use `setState(prev => ...)` for stable callbacks instead of depending on current state.
- `rerender-use-ref-transient-values` (MEDIUM): Use refs for transient values (scroll position, timers, animation frame IDs).
- `rendering-conditional-render` (MEDIUM): Use ternary for conditional rendering, not `&&`.

**Type safety (within split files):**
- `catch (error: any)` → `catch (error: unknown)` + `error instanceof Error` check
- `icon: any` → `icon: React.ComponentType<{ className?: string }>`
- API response types: type the `useApi<T>` generic parameter with proper interfaces
- If a file imports from `@scalius/database/schema`, replace with a local type definition

**Boundaries:**
- Do NOT touch files outside your domain file list.
- Do NOT modify shared hooks (`use-api.ts`, `api-fetch.ts`), shared types, or middleware.
- If you find a shared issue, document it as a comment in your output — do not fix it.

**Verification:**
- Run `pnpm typecheck` after all changes. Must pass with zero errors.
- Report any data shape mismatches found (read the API route to see actual response shape, don't guess).

**Gate:** Wave 2 does not start until all Wave 1 agents complete and `pnpm typecheck` passes.

---

## Wave 2: Cross-Cutting Sweeps

**Executor:** 3 parallel subagents. These touch different file sets with zero overlap to Wave 1 output.

### Agent 5 — Toast Migration + Pattern Cleanup

**Files owned:** All files containing `useToast()` imports, plus:
- `apps/admin/src/components/ui/use-toast.ts` (to be deleted)
- `packages/core/src/modules/pages/pages.service.ts` (schema dedup)
- `packages/core/src/modules/widgets/widgets.service.ts` (schema dedup)

**Tasks:**
1. Find all files importing `useToast` from `@/components/ui/use-toast`
2. Replace each with `import { toast } from "sonner"` — adapt the call pattern:
   - `toast({ title, description, variant: "destructive" })` → `toast.error(description)` or `toast.error(title, { description })`
   - `toast({ title, description })` → `toast.success(description)` or `toast(title, { description })`
3. After all consumers migrated, delete `use-toast.ts`
4. Replace all 13 `window.location.reload()` calls with `useApi` `refetch()` or React state updates. For each:
   - If the component already uses `useApi`, call `refetch()` after the mutation succeeds
   - If the component uses direct `fetch()` for mutations, add a state flag to trigger re-render
   - The `ErrorBoundary.tsx` reload is acceptable (keep it — it's a last-resort recovery)
5. Replace `Math.random()` in `HeroSliderManager.tsx` with `crypto.randomUUID()` (available in Workers runtime, no dependency needed)
6. Remove duplicate schema definitions from `pages.service.ts` and `widgets.service.ts` — import from their `.validation.ts` files instead

**Verification:** `pnpm typecheck` passes. Grep confirms zero `useToast` imports remain (except the deleted file). Grep confirms zero `window.location.reload()` outside ErrorBoundary.

### Agent 6 — Test Infrastructure

**Files owned:** Everything under `tests/` (gitignored, private)

**Tasks:**
1. Create `tests/vitest.config.ts` — configure vitest with globals, path aliases matching the monorepo
2. Create `tests/setup.ts` — D1 test database helpers, mock env factory, seed data generators
3. Write core service tests targeting exact bugs from the hardening session:

```
tests/
  core/
    orders/
      order-lifecycle.test.ts         — PENDING → CONFIRMED → SHIPPED → DELIVERED → COMPLETED
      order-state-machine.test.ts     — All valid + blocked transitions (CANCELLED terminal, admin reactivation)
      order-cancellation.test.ts      — Inventory release on cancel
    inventory/
      reserve-deduct-release.test.ts  — CAS with stockVersion, retry on conflict
      batch-reservation.test.ts       — Multi-variant atomic batch
    payments/
      process-payment.test.ts         — Atomicity via db.batch(), all gateways
      cod-idempotency.test.ts         — Duplicate COD collection prevention
      refund-validation.test.ts       — Cumulative refund limit, partial vs full
    discounts/
      discount-validation.test.ts     — Per-customer usage limits, expired codes
  api/
    response-envelope.test.ts         — All routes return { success, data } shape
```

**Note:** Tests import from `@scalius/core` and `@scalius/database` directly. They do NOT test admin UI — they test the domain logic layer. The `tests/` directory is gitignored per project convention.

### Agent 7 — Database Indexes + Admin Type Definitions

**Files owned:**
- `packages/database/src/schema/*.ts` (index additions only)
- `apps/admin/src/types/` (new files)

**Tasks:**

1. Add missing indexes to schema files:
```typescript
// In packages/database/src/schema/ — add to appropriate schema files:
// media.ts:
index("media_folder_id_idx").on(table.folderId)
index("media_deleted_at_idx").on(table.deletedAt)

// delivery.ts:
index("delivery_providers_type_idx").on(table.type)

// system.ts:
index("analytics_type_idx").on(table.type)

// products.ts:
index("product_attributes_slug_idx").on(table.slug)
```

2. Run `pnpm db:generate` to produce migration 0025.

3. Create `apps/admin/src/types/api-responses.ts` — proper interfaces for all admin API responses. These replace the 8 `@scalius/database/schema` imports:
```typescript
// Types that mirror DB schema types but are owned by admin, not database package
export type OrderStatus = "PENDING" | "CONFIRMED" | "PROCESSING" | "SHIPPED" | "DELIVERED" | "COMPLETED" | "CANCELLED" | "RETURNED" | "REFUNDED";
export interface DeliveryProviderRecord { id: string; name: string; type: string; /* ... */ }
export interface DeliveryShipment { id: string; orderId: string; /* ... */ }
export interface ShippingMethod { id: string; name: string; /* ... */ }
export interface CheckoutLanguage { id: string; code: string; /* ... */ }
export interface AbandonedCheckout { id: string; /* ... */ }
export interface MetaConversionsSettings { /* ... */ }
export interface MetaConversionsLog { /* ... */ }
```

4. Update the 8 admin component files to import from `@/types/api-responses` instead of `@scalius/database/schema`.

5. Create `apps/admin/src/types/window.d.ts` (if not already complete) — extend global `Window` for all `window.__USER_ID__`, `window.__USER_PERMISSIONS__`, etc.

**Verification:** `pnpm typecheck` passes. Grep confirms zero `@scalius/database/schema` imports in `apps/admin/src/components/`.

**Gate:** Wave 3 does not start until all Wave 2 agents complete and `pnpm typecheck` passes.

---

## Wave 3: Final Sweep

**Executor:** Single agent or orchestrator.

**Tasks:**

1. **Lazy-load Recharts** (~300KB, dashboard only):
```typescript
// In dashboard component:
const DashboardChart = React.lazy(() => import("./DashboardChart"));
// Wrap in <Suspense fallback={<ChartSkeleton />}>
```

2. **Lazy-load TipTap** (~800KB, widget/page editor only):
```typescript
const TiptapEditor = React.lazy(() => import("./TiptapEditor"));
// Wrap in <Suspense fallback={<EditorSkeleton />}>
```

3. **Extend React.lazy** to all settings tabs with heavy sub-components (following existing pattern from CheckoutSettingsPage/GeneralSettingsPage).

4. **Apply Vercel `rendering-content-visibility`** to long admin lists (product table, order table, customer table) — add `content-visibility: auto` CSS for off-screen rows.

5. **Apply Vercel `bundle-defer-third-party`** — verify Firebase init already defers properly (uses requestIdleCallback). If not, wrap in dynamic import.

6. **Final `pnpm typecheck`** across all workspaces.

7. **Full manual smoke test** — same page list as Wave 0. Every page loads, data renders, forms work, console clean.

---

## Agent Context Template

Every Wave 1-2 agent receives this in their prompt:

```
ARCHITECTURE:
Turborepo monorepo: Astro 6 SSR admin (port 4321) + Hono API (port 8787) + Astro storefront (port 4322).
All Cloudflare Workers. Admin React components hydrate via client:idle on Astro pages.

DATA FLOW — SSR PATH:
Astro page frontmatter → loader function → apiGet<T>(path) [lib/api-fetch.ts]
  → Service Binding (prod) / HTTP localhost:8787 (dev) → API worker
  → API returns { success: true, data: T }
  → handleResponse() checks body.data first, returns T directly
  → Loader returns T → Astro passes as props to React component

DATA FLOW — CLIENT PATH:
React component → useApi<T>(path) [hooks/use-api.ts]
  → fetch("/api/v1/admin/...") → Admin proxy [pages/api/v1/[...path].ts]
  → Proxy forwards to API worker → API returns { success: true, data: T }
  → Proxy unwraps object T: { success: true, data: {orders:[...]} } → { success: true, orders:[...] }
  → Proxy passes through array T: { success: true, data: [...] } → unchanged
  → useApi strips "success" key, returns rest as T

BOTH PATHS return same shape T for object payloads.
ARRAY payloads differ: apiGet returns [array], useApi returns { data: [array] }.

RESPONSE ENVELOPE CONTRACT:
All API success responses: { success: true, data: T }
The T passed to ok(c, T) is the FINAL payload.
NEVER include redundant success:true or data: wrapping inside T.

EXISTING PATTERNS TO FOLLOW:
- product-form/ directory: 39 files, section-based decomposition, dedicated hooks
- useApi hook for client-side data fetching (strips success, returns T)
- apiGet/apiPost for SSR-side (unwraps body.data, returns T)
- PageSection wrapper for error boundaries

VERCEL REACT BEST PRACTICES TO APPLY:
1. [HIGH] No inline component definitions — extract to module level
2. [MEDIUM] React.memo() on every row component rendered in .map()
3. [MEDIUM] Derive state during render, not in useEffect
4. [MEDIUM] Hoist default non-primitive props to module scope
5. [MEDIUM] Use functional setState: setState(prev => ...) for stable callbacks
6. [MEDIUM] Use refs for transient values (scroll, timers)
7. [MEDIUM] Ternary for conditional rendering, not &&

BOUNDARIES:
- Only touch files in YOUR domain list
- Do NOT modify shared hooks, types, middleware, or other domains' files
- Document shared issues — do not fix them

VERIFICATION:
- pnpm typecheck must pass with zero errors after your changes
- Report any data shape mismatches (read API routes, don't guess)
```

---

## Success Criteria

Phase 3 is complete when:

| # | Criterion | Measurement |
|---|-----------|-------------|
| 1 | No components over 800 lines | `find apps/admin/src/components -name "*.tsx" \| xargs wc -l \| sort -rn \| head -20` |
| 2 | Container/presentational pattern | All split components have container (data) + children (render) |
| 3 | `any` types ≤ 8 | Only Drizzle batch casts remain (with eslint-disable comments) |
| 4 | Zero `window.location.reload()` | Except ErrorBoundary last-resort recovery |
| 5 | `use-toast.ts` deleted | All toasts via sonner's `toast()` |
| 6 | React.memo on list rows | CategoryRow, ProductRow, OrderRow, CustomerRow, DiscountRow, etc. |
| 7 | Heavy deps lazy-loaded | Recharts + TipTap behind React.lazy + Suspense |
| 8 | Core tests passing | Order lifecycle, payments, inventory, discounts, envelope |
| 9 | DB indexes added | Migration 0025 with 5 new indexes |
| 10 | Zero `@scalius/database/schema` in admin components | Replaced with `@/types/api-responses` |
| 11 | `pnpm typecheck` passes | Zero errors across all workspaces |
| 12 | All admin pages verified | Manual smoke test post-refactor |

## Out of Scope

- SDK regeneration (deferred until API surface fully stabilizes)
- Scanner mobile app (separate session)
- Major dependency upgrades (TipTap 2→3, Firebase 11→12, Recharts 2→3, etc.)
- Multi-tenancy / KV migration for rate limiter and layout cache
- Storefront refactoring (already clean — zero violations)
- New feature development (this is purely refactoring + testing)
